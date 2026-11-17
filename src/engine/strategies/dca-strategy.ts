import crypto from "crypto";
import { BaseStrategy } from "./base-strategy";
import { TickerData, Candle, DcaConfig } from "../types";

export class DcaStrategy extends BaseStrategy {
  private config: DcaConfig;
  private safetyOrdersPlaced = 0;
  private lastBuyPrice = 0;
  private isPlacingOrder = false;
  private lastBalanceCheck = 0;
  private lastTpErrorTime = 0;
  private lastSlErrorTime = 0;
  private lastSoErrorTime = 0;
  private lastBaseErrorTime = 0;
  private trailingArmed = false;
  private peakPrice = 0;
  private lastGuardLogTime = 0;

  constructor(bot: any, account: any, exchangeManager: any) {
    super(bot, account, exchangeManager);
    const raw = JSON.parse(bot.config_json || "{}");
    this.config = {
      baseOrderAmount: Number(raw.baseOrderAmount || 1.25),
      safetyOrderAmount: Number(raw.safetyOrderAmount || raw.dcaOrderAmount || 1.25),
      maxSafetyOrders: Number(raw.maxSafetyOrders || raw.maxDcaOrders || 5),
      priceDropPercentage: Math.max(1.2, Number(raw.priceDropPercentage || raw.dcaStepPercent || 1.8)),
      // Anti-Negative-Spin Fee Shield: Minimum 2.0% required to beat Coinbase 1.80% round-trip taker fees
      takeProfitPercentage: Math.max(2.0, Number(raw.takeProfitPercentage ?? raw.takeProfitPercent ?? 2.5)),
      trailingTakeProfitPercentage:
        raw.trailingTakeProfitPercentage != null
          ? Number(raw.trailingTakeProfitPercentage)
          : raw.trailingTakeProfit != null
          ? Number(raw.trailingTakeProfit)
          : undefined,
      stopLossPercentage:
        raw.stopLossPercentage != null
          ? Number(raw.stopLossPercentage)
          : raw.stopLoss != null
          ? Number(raw.stopLoss)
          : undefined,
    };
  }

  public async initialize(): Promise<void> {
    try {
      const balances = await this.exchangeManager.fetchBalances(this.account, true);
      const freeUsd = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);
      this.log("info", `DCA Strategy connected to Coinbase. Detected $${freeUsd.toFixed(2)} USD cash. Auto-capital absorption ACTIVE.`);
    } catch (err: any) {
      console.warn("[DcaStrategy] Init balance check notice:", err.message);
    }
    this.log(
      "info",
      `DCA Strategy active for ${this.bot.symbol}. Base order: $${this.config.baseOrderAmount}, Take profit: ${this.config.takeProfitPercentage}%`
    );
  }

  public async onTick(ticker: TickerData): Promise<void> {
    if (this.isPlacingOrder) return;
    const openOrders = this.getOpenOrders();

    // 1. Calculate active cycle position & average entry (isolated from historical closed cycles)
    const lastSell = this.db.prepare(`
      SELECT MAX(timestamp) as lastSellTime
      FROM trades
      WHERE bot_id = ? AND side = 'sell'
    `).get(this.bot.id) as { lastSellTime: string | null };

    const activeBuys = lastSell && lastSell.lastSellTime
      ? (this.db.prepare(`
          SELECT price, amount, cost
          FROM trades
          WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
          ORDER BY timestamp ASC
        `).all(this.bot.id, lastSell.lastSellTime) as { price: number; amount: number; cost: number }[])
      : (this.db.prepare(`
          SELECT price, amount, cost
          FROM trades
          WHERE bot_id = ? AND side = 'buy'
          ORDER BY timestamp ASC
        `).all(this.bot.id) as { price: number; amount: number; cost: number }[]);

    let totalAmount = 0;
    let totalCost = 0;
    for (const b of activeBuys) {
      totalAmount += b.amount;
      totalCost += b.cost;
    }
    totalAmount = Math.max(0, Number(totalAmount.toFixed(6)));
    const avgEntry = totalAmount > 0 ? totalCost / totalAmount : 0;

    // Synchronize crash-proof state from database
    if (activeBuys.length > 0) {
      this.safetyOrdersPlaced = Math.max(0, activeBuys.length - 1);
      this.lastBuyPrice = activeBuys[activeBuys.length - 1].price;
    } else {
      this.safetyOrdersPlaced = 0;
      this.lastBuyPrice = 0;
      this.trailingArmed = false;
      this.peakPrice = 0;
    }

    // 2. Auto-Capital Absorption: Sync live Coinbase balance every 15s
    await this.syncLiveCapital(ticker.last, totalAmount);

    // 3. Initial Entry: If no position and no open orders, check Risk & Regime Guards before placing Base Order
    const nowTs = Date.now();
    if (totalAmount <= 0.0001 && openOrders.length === 0) {
      const guard = this.canEnterBuy();
      if (!guard.allowed) {
        if (nowTs - this.lastGuardLogTime > 300000) {
          this.lastGuardLogTime = nowTs;
          this.log("warn", `🛡️ Entry paused by Guard: ${guard.reason}`);
        }
        return;
      }
      const expGuard = await this.checkExposureCap();
      if (!expGuard.allowed) {
        if (nowTs - this.lastGuardLogTime > 300000) {
          this.lastGuardLogTime = nowTs;
          this.log("warn", `🛡️ Entry paused by Exposure Cap: ${expGuard.reason}`);
        }
        return;
      }

      if (nowTs - this.lastBaseErrorTime <= 300000) return;

      const cashCheck = await this.hasSufficientCash(this.config.baseOrderAmount);
      if (!cashCheck.ok) {
        this.lastBaseErrorTime = nowTs;
        this.log("warn", `DCA base order paused: need $${this.config.baseOrderAmount.toFixed(2)} free USD/USDC (have $${cashCheck.availableUsd.toFixed(2)}). Cooling down 5m.`);
        return;
      }

      const amount = Number((this.config.baseOrderAmount / ticker.last).toFixed(5));
      if (amount > 0) {
        this.isPlacingOrder = true;
        try {
          await this.placeOrder("buy", "market", ticker.last, amount, true);
          this.lastBuyPrice = ticker.last;
          this.safetyOrdersPlaced = 0;
          this.trailingArmed = false;
          this.peakPrice = 0;
        } catch (err: any) {
          this.lastBaseErrorTime = Date.now();
          this.log("error", `Failed placing DCA base order (cooling down 5m): ${err.message}`);
        } finally {
          this.isPlacingOrder = false;
        }
      }
      return;
    }

    // 4. Take Profit Check (Supports Trailing Take-Profit when configured)
    if (avgEntry > 0 && totalAmount > 0.0001 && nowTs - this.lastTpErrorTime > 15000) {
      const tpTarget = avgEntry * (1 + this.config.takeProfitPercentage / 100);
      const trailPct = this.config.trailingTakeProfitPercentage || 0;
      let shouldTakeProfit = false;

      if (trailPct > 0) {
        if (!this.trailingArmed && ticker.last >= tpTarget) {
          this.trailingArmed = true;
          this.peakPrice = ticker.last;
          this.log("info", `🎯 Trailing Take-Profit ARMED at $${ticker.last.toFixed(2)} (Target: +${this.config.takeProfitPercentage}%, Trail: ${trailPct}%)`);
        }
        if (this.trailingArmed) {
          if (ticker.last > this.peakPrice) {
            this.peakPrice = ticker.last;
          }
          const trailStop = Math.max(tpTarget, this.peakPrice * (1 - trailPct / 100));
          if (ticker.last <= trailStop) {
            shouldTakeProfit = true;
          }
        }
      } else if (ticker.last >= tpTarget) {
        shouldTakeProfit = true;
      }

      if (shouldTakeProfit) {
        this.isPlacingOrder = true;
        try {
          const baseAsset = this.bot.symbol.split("/")[0];
          const balances = await this.exchangeManager.fetchBalances(this.account, true);
          const freeBase = Number(balances[baseAsset]?.free || 0);

          if (freeBase < 0.00005) {
            this.log("info", `DCA position on exchange has 0 ${baseAsset} available. Reconciling position to 0.`);
            this.safetyOrdersPlaced = 0;
            this.lastBuyPrice = 0;
            this.trailingArmed = false;
            this.peakPrice = 0;
            this.db.prepare(`
              INSERT INTO trades (
                id, bot_id, symbol, side, price, amount, cost, fee, realized_pnl, is_paper, timestamp
              ) VALUES (?, ?, ?, 'sell', ?, ?, ?, 0, 0, 0, datetime('now'))
            `).run(`live-trd-reconcile-${crypto.randomUUID()}`, this.bot.id, this.bot.symbol, ticker.last, totalAmount, totalAmount * ticker.last);
            return;
          }

          const sellAmount = Math.floor(Math.min(totalAmount, freeBase * 0.995) * 100000) / 100000;
          if (sellAmount * ticker.last < 1.0) {
            this.log("info", `DCA remaining position is dust ($${(sellAmount * ticker.last).toFixed(2)}). Resetting.`);
            this.safetyOrdersPlaced = 0;
            this.lastBuyPrice = 0;
            this.trailingArmed = false;
            this.peakPrice = 0;
            return;
          }

          this.log(
            "info",
            `DCA Take Profit hit! Price: $${ticker.last}${this.trailingArmed ? ` (Peak: $${this.peakPrice.toFixed(2)})` : ""}, Avg Entry: $${avgEntry.toFixed(2)}, Target: +${this.config.takeProfitPercentage}%. Executing sell of ${sellAmount} ${baseAsset}...`
          );

          const order = await this.placeOrder("sell", "market", ticker.last, sellAmount, true);
          const execPrice = order.price || ticker.last;
          const feeRate = order.type === "limit" ? 0.004 : 0.009;
          const grossPnl = (execPrice - avgEntry) * sellAmount;
          const roundTripFee = (avgEntry * sellAmount * 0.009) + (execPrice * sellAmount * feeRate);
          const pnl = Number((grossPnl - roundTripFee).toFixed(4));
          this.safetyOrdersPlaced = 0;
          this.lastBuyPrice = 0;
          this.trailingArmed = false;
          this.peakPrice = 0;

        const isWin = pnl > 0 ? 1 : 0;
        // Record authentic NET realized PnL & winning trade stats
        this.db.prepare(`
          UPDATE trading_bots
          SET realized_pnl = realized_pnl + ?,
              total_trades = total_trades + 1,
              winning_trades = winning_trades + ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(pnl, isWin, this.bot.id);

        if (order && order.id) {
          this.db.prepare(`
            UPDATE trades SET realized_pnl = ? WHERE order_id = ?
          `).run(pnl, order.id);
        }

        this.log("trade", `Take-profit executed! Locked in +$${pnl.toFixed(2)} NET profit after fees (Gross: +$${grossPnl.toFixed(2)}, Fees: -$${roundTripFee.toFixed(2)}).`);
      } catch (err: any) {
        this.lastTpErrorTime = Date.now();
        this.log("error", `Failed closing DCA position at take-profit (cooling down 15s): ${err.message}`);
      } finally {
        this.isPlacingOrder = false;
      }
      return;
      }
    }

    // 5. Stop Loss Check
    if (
      this.config.stopLossPercentage &&
      avgEntry > 0 &&
      totalAmount > 0.0001 &&
      nowTs - this.lastSlErrorTime > 15000
    ) {
      if (ticker.last <= avgEntry * (1 - this.config.stopLossPercentage / 100)) {
        this.isPlacingOrder = true;
        try {
          const baseAsset = this.bot.symbol.split("/")[0];
          const balances = await this.exchangeManager.fetchBalances(this.account, true);
          const freeBase = Number(balances[baseAsset]?.free || 0);

          if (freeBase < 0.00005) {
            this.log("info", `DCA position on exchange has 0 ${baseAsset} available. Reconciling position to 0.`);
            this.safetyOrdersPlaced = 0;
            this.lastBuyPrice = 0;
            return;
          }

          const sellAmount = Math.floor(Math.min(totalAmount, freeBase * 0.995) * 100000) / 100000;
          if (sellAmount * ticker.last < 1.0) {
            this.safetyOrdersPlaced = 0;
            this.lastBuyPrice = 0;
            return;
          }

          this.log("warn", `DCA Stop Loss hit! Price: $${ticker.last}, Avg Entry: $${avgEntry.toFixed(2)}`);
          const grossPnl = (ticker.last - avgEntry) * sellAmount;
          const roundTripFee = (avgEntry * sellAmount * 0.009) + (ticker.last * sellAmount * 0.009);
          const pnl = Number((grossPnl - roundTripFee).toFixed(4));
          const order = await this.placeOrder("sell", "market", ticker.last, sellAmount);
          this.safetyOrdersPlaced = 0;
          this.lastBuyPrice = 0;

          const isWin = pnl > 0 ? 1 : 0;
          this.db.prepare(`
            UPDATE trading_bots
            SET realized_pnl = realized_pnl + ?,
                total_trades = total_trades + 1,
                winning_trades = winning_trades + ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(pnl, isWin, this.bot.id);

          if (order && order.id) {
            this.db.prepare(`
              UPDATE trades SET realized_pnl = ? WHERE order_id = ?
            `).run(pnl, order.id);
          }
        } catch (err: any) {
          this.lastSlErrorTime = Date.now();
          this.log("error", `Failed executing DCA stop loss (cooling down 15s): ${err.message}`);
        } finally {
          this.isPlacingOrder = false;
        }
        return;
      }
    }

    // 6. Safety Order (Buy Dip): If price drops by configured % from last buy
    const referencePrice = this.lastBuyPrice || avgEntry;
    const maxSafetyByCapital = Math.max(
      0,
      Math.floor((this.bot.allocated_capital - this.config.baseOrderAmount) / (this.config.safetyOrderAmount || 1))
    );
    const effectiveMaxSafety = Math.min(this.config.maxSafetyOrders, maxSafetyByCapital);

    if (
      referencePrice > 0 &&
      ticker.last <= referencePrice * (1 - this.config.priceDropPercentage / 100) &&
      this.safetyOrdersPlaced < effectiveMaxSafety &&
      openOrders.length === 0 &&
      nowTs - this.lastSoErrorTime > 300000
    ) {
      const cashCheck = await this.hasSufficientCash(this.config.safetyOrderAmount);
      if (!cashCheck.ok) {
        this.lastSoErrorTime = nowTs;
        this.log("warn", `DCA safety order paused: need $${this.config.safetyOrderAmount.toFixed(2)} free USD/USDC (have $${cashCheck.availableUsd.toFixed(2)}). Cooling down 5m.`);
        return;
      }
      const safetyAmount = Number((this.config.safetyOrderAmount / ticker.last).toFixed(5));
      if (safetyAmount > 0) {
        this.isPlacingOrder = true;
        try {
          this.log(
            "info",
            `DCA safety order ${this.safetyOrdersPlaced + 1}/${effectiveMaxSafety} triggered at $${ticker.last}`
          );
          await this.placeOrder("buy", "market", ticker.last, safetyAmount, true);
          this.lastBuyPrice = ticker.last;
          this.safetyOrdersPlaced += 1;
        } catch (err: any) {
          this.lastSoErrorTime = Date.now();
          this.log("error", `Failed placing safety order (cooling down 5m): ${err.message}`);
        } finally {
          this.isPlacingOrder = false;
        }
      }
    }
  }

  /**
   * Auto-Capital Absorption Engine:
   * Polls Coinbase balance every 15s. Automatically absorbs newly deposited USD,
   * dynamically adjusts bot allocated capital, and auto-scales Base & Safety order sizes.
   */
  private async syncLiveCapital(currentPrice: number, currentPositionAmount: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < 15000) return;
    this.lastBalanceCheck = now;

    try {
      const balances = await this.exchangeManager.fetchBalances(this.account, true);
      const freeUsd = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);
      const positionValue = currentPositionAmount * currentPrice;
      const totalAvailable = Number((freeUsd + positionValue).toFixed(2));

      // Auto-scale capital when new deposits appear or balance changes by >= $0.50
      if (totalAvailable >= 1.0 && Math.abs(totalAvailable - this.bot.allocated_capital) >= 0.50) {
        const oldCap = this.bot.allocated_capital;
        this.bot.allocated_capital = totalAvailable;

        // Dynamic Sizing: Base Order ~ 25% of capital (min $1.25), Safety Order ~ 20% of capital (min $1.25)
        const newBase = Math.max(1.25, Number((totalAvailable * 0.25).toFixed(2)));
        const newSafety = Math.max(1.25, Number((totalAvailable * 0.20).toFixed(2)));

        this.config.baseOrderAmount = newBase;
        this.config.safetyOrderAmount = newSafety;

        const updatedConfig = {
          ...this.config,
          baseOrderAmount: newBase,
          safetyOrderAmount: newSafety,
        };

        this.db.prepare(`
          UPDATE trading_bots
          SET allocated_capital = ?, config_json = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(totalAvailable, JSON.stringify(updatedConfig), this.bot.id);

        this.log(
          "info",
          `Auto-Capital Absorption: Synced Coinbase live funds ($${oldCap.toFixed(2)} ➔ $${totalAvailable.toFixed(2)}). Dynamic Order Sizing: Base $${newBase.toFixed(2)} (25%), Safety $${newSafety.toFixed(2)} (20%)`
        );
      }
    } catch (err: any) {
      console.warn(`[DcaStrategy] Balance sync notice: ${err.message}`);
    }
  }

  public async onCandle(_candles: Candle[]): Promise<void> {}
}

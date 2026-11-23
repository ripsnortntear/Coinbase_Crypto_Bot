"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DcaStrategy = void 0;
const crypto_1 = __importDefault(require("crypto"));
const base_strategy_1 = require("./base-strategy");
class DcaStrategy extends base_strategy_1.BaseStrategy {
    config;
    safetyOrdersPlaced = 0;
    lastBuyPrice = 0;
    isPlacingOrder = false;
    lastBalanceCheck = 0;
    lastTpErrorTime = 0;
    lastSlErrorTime = 0;
    lastSoErrorTime = 0;
    lastBaseErrorTime = 0;
    trailingArmed = false;
    peakPrice = 0;
    lastGuardLogTime = 0;
    lastFreeCash = Infinity;
    lowCashPaused = false;
    constructor(bot, account, exchangeManager) {
        super(bot, account, exchangeManager);
        const raw = JSON.parse(bot.config_json || "{}");
        this.config = {
            baseOrderAmount: Number(raw.baseOrderAmount || 1.25),
            safetyOrderAmount: Number(raw.safetyOrderAmount || raw.dcaOrderAmount || 1.25),
            maxSafetyOrders: Number(raw.maxSafetyOrders || raw.maxDcaOrders || 5),
            priceDropPercentage: Math.max(1.2, Number(raw.priceDropPercentage || raw.dcaStepPercent || 1.8)),
            // Anti-Negative-Spin Fee Shield: Minimum 2.0% required to beat Coinbase 1.80% round-trip taker fees
            takeProfitPercentage: Math.max(2.0, Number(raw.takeProfitPercentage ?? raw.takeProfitPercent ?? 2.5)),
            trailingTakeProfitPercentage: raw.trailingTakeProfitPercentage != null
                ? Number(raw.trailingTakeProfitPercentage)
                : raw.trailingTakeProfit != null
                    ? Number(raw.trailingTakeProfit)
                    : undefined,
            stopLossPercentage: raw.stopLossPercentage != null
                ? Number(raw.stopLossPercentage)
                : raw.stopLoss != null
                    ? Number(raw.stopLoss)
                    : 8.0,
        };
    }
    async initialize() {
        try {
            const balances = await this.exchangeManager.fetchBalances(this.account, true);
            const freeUsd = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);
            this.log("info", `DCA Strategy connected to Coinbase. Detected $${freeUsd.toFixed(2)} USD cash. Auto-capital absorption ACTIVE.`);
        }
        catch (err) {
            console.warn("[DcaStrategy] Init balance check notice:", err.message);
        }
        this.log("info", `DCA Strategy active for ${this.bot.symbol}. Base order: $${this.config.baseOrderAmount}, Take profit: ${this.config.takeProfitPercentage}%`);
    }
    async onTick(ticker) {
        if (this.isPlacingOrder)
            return;
        const openOrders = this.getOpenOrders();
        // 1. Calculate active cycle position & average entry (isolated from historical closed cycles)
        const lastSell = this.db.prepare(`
      SELECT MAX(timestamp) as lastSellTime
      FROM trades
      WHERE bot_id = ? AND side = 'sell'
    `).get(this.bot.id);
        const activeBuys = lastSell && lastSell.lastSellTime
            ? this.db.prepare(`
          SELECT price, amount, cost
          FROM trades
          WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
          ORDER BY timestamp ASC
        `).all(this.bot.id, lastSell.lastSellTime)
            : this.db.prepare(`
          SELECT price, amount, cost
          FROM trades
          WHERE bot_id = ? AND side = 'buy'
          ORDER BY timestamp ASC
        `).all(this.bot.id);
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
        }
        else {
            this.safetyOrdersPlaced = 0;
            this.lastBuyPrice = 0;
            this.trailingArmed = false;
            this.peakPrice = 0;
        }
        // 2. Auto-Capital Absorption: Sync live Coinbase balance every 15s
        await this.syncLiveCapital(ticker.last, totalAmount);
        if (!this.isBotActive())
            return;
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
            if (nowTs - this.lastBaseErrorTime <= 300000)
                return;
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
                }
                catch (err) {
                    this.lastBaseErrorTime = Date.now();
                    this.log("error", `Failed placing DCA base order (cooling down 5m): ${err.message}`);
                }
                finally {
                    this.isPlacingOrder = false;
                }
            }
            return;
        }
        // 4. Take Profit Check (Supports Trailing Take-Profit when configured)
        if (avgEntry > 0 && totalAmount > 0.0001 && nowTs - this.lastTpErrorTime > 15000) {
            const tpTarget = avgEntry * (1 + this.config.takeProfitPercentage / 100);
            const minProfitFloor = avgEntry * 1.02; // 2.0% Anti-Negative-Spin Fee Shield
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
                        if (ticker.last >= minProfitFloor) {
                            shouldTakeProfit = true;
                        }
                        else {
                            // Price gapped below the 2.0% fee shield before trailing stop could fill; disarm instead of selling at a net loss
                            this.trailingArmed = false;
                            this.peakPrice = 0;
                            this.log("info", `Trailing Take-Profit disarmed: price $${ticker.last.toFixed(4)} fell below 2.0% fee shield ($${minProfitFloor.toFixed(4)})`);
                        }
                    }
                }
            }
            else if (ticker.last >= tpTarget && ticker.last >= minProfitFloor) {
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
            `).run(`live-trd-reconcile-${crypto_1.default.randomUUID()}`, this.bot.id, this.bot.symbol, ticker.last, totalAmount, totalAmount * ticker.last);
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
                    this.log("info", `DCA Take Profit hit! Price: $${ticker.last}${this.trailingArmed ? ` (Peak: $${this.peakPrice.toFixed(2)})` : ""}, Avg Entry: $${avgEntry.toFixed(2)}, Target: +${this.config.takeProfitPercentage}%. Executing sell of ${sellAmount} ${baseAsset}...`);
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
                }
                catch (err) {
                    this.lastTpErrorTime = Date.now();
                    this.log("error", `Failed closing DCA position at take-profit (cooling down 15s): ${err.message}`);
                }
                finally {
                    this.isPlacingOrder = false;
                }
                return;
            }
        }
        // 5. Stop Loss Check
        if (this.config.stopLossPercentage &&
            avgEntry > 0 &&
            totalAmount > 0.0001 &&
            nowTs - this.lastSlErrorTime > 15000) {
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
                }
                catch (err) {
                    this.lastSlErrorTime = Date.now();
                    this.log("error", `Failed executing DCA stop loss (cooling down 15s): ${err.message}`);
                }
                finally {
                    this.isPlacingOrder = false;
                }
                return;
            }
        }
        // 6. Safety Order (Buy Dip): If price drops by configured % from last buy
        const referencePrice = this.lastBuyPrice || avgEntry;
        const maxSafetyByCapital = Math.max(0, Math.floor((this.bot.allocated_capital - this.config.baseOrderAmount) / (this.config.safetyOrderAmount || 1)));
        const effectiveMaxSafety = Math.min(this.config.maxSafetyOrders, maxSafetyByCapital);
        if (this.lowCashPaused && this.lastFreeCash < 1.25 * 1.01) {
            return;
        }
        if (referencePrice > 0 &&
            ticker.last <= referencePrice * (1 - this.config.priceDropPercentage / 100) &&
            this.safetyOrdersPlaced < effectiveMaxSafety &&
            openOrders.length === 0 &&
            nowTs - this.lastSoErrorTime > 300000) {
            let orderUsd = this.config.safetyOrderAmount;
            const cashCheck = await this.hasSufficientCash(orderUsd);
            if (!cashCheck.ok) {
                const maxAffordableUsd = Number((Math.floor((cashCheck.availableUsd / 1.01) * 100) / 100).toFixed(2));
                if (maxAffordableUsd >= 1.25) {
                    orderUsd = maxAffordableUsd;
                    this.lowCashPaused = false;
                    this.log("info", `DCA safety order scaled to available cash: $${orderUsd.toFixed(2)} (configured $${this.config.safetyOrderAmount.toFixed(2)}, free $${cashCheck.availableUsd.toFixed(2)})`);
                }
                else {
                    this.lastFreeCash = cashCheck.availableUsd;
                    if (!this.lowCashPaused) {
                        this.lowCashPaused = true;
                        this.log("warn", `DCA safety order auto-paused: need at least $1.25 free USD/USDC (have $${cashCheck.availableUsd.toFixed(2)}). Will auto-resume when funds are available.`);
                    }
                    this.lastSoErrorTime = nowTs;
                    return;
                }
            }
            const safetyAmount = Number((orderUsd / ticker.last).toFixed(5));
            if (safetyAmount > 0) {
                this.isPlacingOrder = true;
                try {
                    this.log("info", `DCA safety order ${this.safetyOrdersPlaced + 1}/${effectiveMaxSafety} triggered at $${ticker.last}`);
                    await this.placeOrder("buy", "market", ticker.last, safetyAmount, true);
                    this.lastBuyPrice = ticker.last;
                    this.safetyOrdersPlaced += 1;
                }
                catch (err) {
                    this.lastSoErrorTime = Date.now();
                    this.log("error", `Failed placing safety order (cooling down 5m): ${err.message}`);
                }
                finally {
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
    async syncLiveCapital(currentPrice, currentPositionAmount) {
        const now = Date.now();
        if (now - this.lastBalanceCheck < 15000)
            return;
        this.lastBalanceCheck = now;
        try {
            const balances = await this.exchangeManager.fetchBalances(this.account, true);
            const usdFree = Number(balances["USD"]?.free || 0);
            const usdcFree = Number(balances["USDC"]?.free || 0);
            const freeUsd = usdFree + usdcFree;
            const bestSingleCash = Math.max(usdFree, usdcFree);
            this.lastFreeCash = bestSingleCash;
            if (this.lowCashPaused && bestSingleCash >= 1.25 * 1.01) {
                this.lowCashPaused = false;
                this.lastSoErrorTime = 0;
                this.log("info", `Free USD/USDC recovered ($${bestSingleCash.toFixed(2)}). Auto-resuming DCA safety orders.`);
            }
            const positionValue = currentPositionAmount * currentPrice;
            const totalAvailable = Number((freeUsd + positionValue).toFixed(2));
            // Dynamic Sizing: Base Order ~ 25% of capital (min $1.25), Safety Order ~ min(20% of capital, spendable free cash) (min $1.25)
            const newBase = Math.max(1.25, Number((totalAvailable * 0.25).toFixed(2)));
            const rawSafety = Math.max(1.25, Number((totalAvailable * 0.20).toFixed(2)));
            const maxSpendableCash = Number((Math.floor((bestSingleCash / 1.01) * 100) / 100).toFixed(2));
            const newSafety = maxSpendableCash >= 1.25 ? Math.max(1.25, Math.min(rawSafety, maxSpendableCash)) : 1.25;
            // Auto-scale capital when new deposits appear, balance changes by >= $0.50, or safety order cap shifts
            if (totalAvailable >= 1.0 &&
                (Math.abs(totalAvailable - this.bot.allocated_capital) >= 0.50 ||
                    Math.abs(newSafety - this.config.safetyOrderAmount) >= 0.10)) {
                const oldCap = this.bot.allocated_capital;
                this.bot.allocated_capital = totalAvailable;
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
                this.log("info", `Auto-Capital Absorption: Synced Coinbase live funds ($${oldCap.toFixed(2)} ➔ $${totalAvailable.toFixed(2)}). Dynamic Order Sizing: Base $${newBase.toFixed(2)} (25%), Safety $${newSafety.toFixed(2)} (20%)`);
            }
        }
        catch (err) {
            console.warn(`[DcaStrategy] Balance sync notice: ${err.message}`);
        }
    }
    async onCandle(_candles) { }
}
exports.DcaStrategy = DcaStrategy;

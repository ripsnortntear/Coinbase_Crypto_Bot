"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MomentumStrategy = void 0;
const base_strategy_1 = require("./base-strategy");
const technicalindicators_1 = require("technicalindicators");
class MomentumStrategy extends base_strategy_1.BaseStrategy {
    config;
    inPosition = false;
    entryPrice = 0;
    lastBuyErrorTime = 0;
    lastStopLossTime = 0;
    lastSlCooldownLogTime = 0;
    isPlacingOrder = false;
    constructor(bot, account, exchangeManager) {
        super(bot, account, exchangeManager);
        const raw = JSON.parse(bot.config_json || "{}");
        this.config = {
            rsiPeriod: Number(raw.rsiPeriod || 14),
            rsiOversold: Number(raw.rsiOversold || 30),
            rsiOverbought: Number(raw.rsiOverbought || 70),
            timeframe: raw.timeframe || "5m",
            orderAmount: Number(raw.orderAmount || bot.allocated_capital || 250),
            takeProfitPercentage: Math.max(2.0, Number(raw.takeProfitPercentage ?? raw.takeProfitPercent ?? 4.0)),
            stopLossPercentage: Number(raw.stopLossPercentage ?? raw.stopLossPercent ?? raw.stopLoss ?? 2.0),
        };
    }
    async initialize() {
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        this.log("info", `Momentum Strategy initialized on ${this.config.timeframe || "5m"} candles. RSI Period: ${this.config.rsiPeriod || 14}${this.inPosition ? ` | Hydrated open position @ $${this.entryPrice.toFixed(4)}` : ""}`);
    }
    async onTick(ticker) {
        if (this.isPlacingOrder)
            return;
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        // Check Take Profit or Stop Loss for active position
        if (this.inPosition && this.entryPrice > 0) {
            const pnlPct = ((ticker.last - this.entryPrice) / this.entryPrice) * 100;
            if (this.config.takeProfitPercentage && pnlPct >= this.config.takeProfitPercentage) {
                this.isPlacingOrder = true;
                try {
                    this.log("info", `Momentum Take-Profit hit (+${pnlPct.toFixed(2)}%) at $${ticker.last}`);
                    await this.closePosition(ticker.last);
                }
                finally {
                    this.isPlacingOrder = false;
                }
            }
            else if (this.config.stopLossPercentage && pnlPct <= -this.config.stopLossPercentage) {
                this.isPlacingOrder = true;
                try {
                    this.log("warn", `Momentum Stop-Loss hit (${pnlPct.toFixed(2)}%) at $${ticker.last} — cooling down 60m before re-entry.`);
                    this.lastStopLossTime = Date.now();
                    await this.closePosition(ticker.last);
                }
                finally {
                    this.isPlacingOrder = false;
                }
            }
        }
    }
    async onCandle(candles) {
        if (this.isPlacingOrder)
            return;
        if (candles.length < 25)
            return;
        const closePrices = candles.map((c) => c.close);
        const rsiPeriod = this.config.rsiPeriod || 14;
        const rsiValues = technicalindicators_1.RSI.calculate({
            values: closePrices,
            period: rsiPeriod,
        });
        if (rsiValues.length < 2)
            return;
        const currentRsi = rsiValues[rsiValues.length - 1];
        const prevRsi = rsiValues[rsiValues.length - 2];
        const lastPrice = closePrices[closePrices.length - 1];
        const oversold = this.config.rsiOversold || 30;
        const overbought = this.config.rsiOverbought || 70;
        // BUY Signal: RSI dips below oversold and starts turning up
        const nowTs = Date.now();
        if (!this.inPosition && prevRsi <= oversold && currentRsi > prevRsi && nowTs - this.lastBuyErrorTime > 300000) {
            if (nowTs - this.lastStopLossTime < 3600000) {
                if (nowTs - this.lastSlCooldownLogTime > 300000) {
                    this.lastSlCooldownLogTime = nowTs;
                    const minsLeft = Math.ceil((3600000 - (nowTs - this.lastStopLossTime)) / 60000);
                    this.log("info", `Momentum BUY paused: post-stop-loss cooldown (${minsLeft}m remaining).`);
                }
                return;
            }
            const guard = this.canEnterBuy();
            if (!guard.allowed) {
                this.log("warn", `🛡️ Momentum BUY paused by Guard: ${guard.reason}`);
                return;
            }
            const expGuard = await this.checkExposureCap();
            if (!expGuard.allowed) {
                this.log("warn", `🛡️ Momentum BUY paused by Exposure Cap: ${expGuard.reason}`);
                return;
            }
            const cashCheck = await this.hasSufficientCash(this.config.orderAmount);
            if (!cashCheck.ok) {
                this.lastBuyErrorTime = nowTs;
                this.log("warn", `Momentum BUY skipped: need $${this.config.orderAmount.toFixed(2)} free USD/USDC (have $${cashCheck.availableUsd.toFixed(2)}). Cooling down 5m.`);
                return;
            }
            this.log("info", `BUY Signal: RSI oversold rebound (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)}) at $${lastPrice}`);
            const amount = Number((this.config.orderAmount / lastPrice).toFixed(5));
            if (amount > 0) {
                try {
                    await this.placeOrder("buy", "market", lastPrice, amount, true);
                    this.inPosition = true;
                    this.entryPrice = lastPrice;
                }
                catch (err) {
                    this.lastBuyErrorTime = Date.now();
                    this.log("error", `Failed executing Momentum BUY (cooling down 5m): ${err.message}`);
                }
            }
        }
        // SELL Signal: RSI overbought
        else if (this.inPosition && currentRsi >= overbought) {
            this.log("info", `SELL Signal: RSI overbought (${currentRsi.toFixed(1)} >= ${overbought}) at $${lastPrice}`);
            await this.closePosition(lastPrice);
        }
    }
    async closePosition(currentPrice) {
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
        `).all(this.bot.id, lastSell.lastSellTime)
            : this.db.prepare(`
          SELECT price, amount, cost
          FROM trades
          WHERE bot_id = ? AND side = 'buy'
        `).all(this.bot.id);
        let totalAmount = 0;
        let totalCost = 0;
        for (const b of activeBuys) {
            totalAmount += b.amount;
            totalCost += b.cost;
        }
        totalAmount = Math.max(0, Number(totalAmount.toFixed(6)));
        const avgEntry = totalAmount > 0 ? totalCost / totalAmount : currentPrice;
        if (totalAmount <= 0.00005) {
            this.inPosition = false;
            this.entryPrice = 0;
            return;
        }
        try {
            const baseAsset = this.bot.symbol.split("/")[0];
            const balances = await this.exchangeManager.fetchBalances(this.account, true);
            const freeBase = Number(balances[baseAsset]?.free || 0);
            if (freeBase < 0.00005) {
                this.inPosition = false;
                this.entryPrice = 0;
                return;
            }
            const sellAmount = Math.floor(Math.min(totalAmount, freeBase * 0.995) * 100000) / 100000;
            if (sellAmount * currentPrice >= 1.0) {
                const order = await this.placeOrder("sell", "market", currentPrice, sellAmount);
                const execPrice = order.price || currentPrice;
                const sellFeeRate = order.type === "limit" ? 0.004 : 0.009;
                const grossPnl = (execPrice - avgEntry) * sellAmount;
                const roundTripFee = (avgEntry * sellAmount * 0.009) + (execPrice * sellAmount * sellFeeRate);
                const pnl = Number((grossPnl - roundTripFee).toFixed(4));
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
            this.inPosition = false;
            this.entryPrice = 0;
        }
        catch (err) {
            this.log("error", `Failed closing Momentum position: ${err.message}`);
        }
    }
}
exports.MomentumStrategy = MomentumStrategy;

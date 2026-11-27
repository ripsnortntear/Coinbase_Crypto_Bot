"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BollingerStrategy = void 0;
const base_strategy_1 = require("./base-strategy");
const technicalindicators_1 = require("technicalindicators");
class BollingerStrategy extends base_strategy_1.BaseStrategy {
    config;
    inPosition = false;
    entryPrice = 0;
    lastBuyErrorTime = 0;
    lastStopLossTime = 0;
    lastSlCooldownLogTime = 0;
    lastGuardLogTime = 0;
    isPlacingOrder = false;
    constructor(bot, account, exchangeManager) {
        super(bot, account, exchangeManager);
        const raw = JSON.parse(bot.config_json || "{}");
        this.config = {
            period: Number(raw.period || 20),
            stdDev: Number(raw.stdDev || 2),
            timeframe: raw.timeframe || "5m",
            orderAmount: Number(raw.orderAmount || bot.allocated_capital || 250),
            takeProfitPercentage: Math.max(2.0, Number(raw.takeProfitPercentage ?? raw.takeProfitPercent ?? 3.5)),
            stopLossPercentage: Number(raw.stopLossPercentage ?? raw.stopLossPercent ?? raw.stopLoss ?? 2.0),
        };
    }
    async initialize() {
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        this.log("info", `Bollinger Bands Strategy initialized on ${this.config.timeframe || "5m"}. Period: ${this.config.period || 20}, StdDev: ${this.config.stdDev || 2}${this.inPosition ? ` | Hydrated open position @ $${this.entryPrice.toFixed(4)}` : ""}`);
    }
    async onTick(ticker) {
        if (this.isPlacingOrder)
            return;
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        if (this.inPosition && this.entryPrice > 0) {
            const pnlPct = ((ticker.last - this.entryPrice) / this.entryPrice) * 100;
            if (this.config.takeProfitPercentage && pnlPct >= this.config.takeProfitPercentage) {
                this.isPlacingOrder = true;
                try {
                    this.log("info", `Bollinger Take-Profit reached (+${pnlPct.toFixed(2)}%) at $${ticker.last}`);
                    await this.closePosition(ticker.last);
                }
                finally {
                    this.isPlacingOrder = false;
                }
            }
            else if (this.config.stopLossPercentage && pnlPct <= -this.config.stopLossPercentage) {
                this.isPlacingOrder = true;
                try {
                    this.log("warn", `Bollinger Stop-Loss hit (${pnlPct.toFixed(2)}%) at $${ticker.last} — cooling down 60m before re-entry.`);
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
        const period = this.config.period || 20;
        if (candles.length < period + 5)
            return;
        const closePrices = candles.map((c) => c.close);
        const bb = technicalindicators_1.BollingerBands.calculate({
            values: closePrices,
            period,
            stdDev: this.config.stdDev || 2,
        });
        if (bb.length === 0)
            return;
        const currentBB = bb[bb.length - 1];
        const lastPrice = closePrices[closePrices.length - 1];
        // BUY Signal: Price touches or drops below lower band (oversold mean-reversion)
        const nowTs = Date.now();
        if (!this.inPosition && lastPrice <= currentBB.lower && nowTs - this.lastBuyErrorTime > 300000) {
            if (nowTs - this.lastStopLossTime < 3600000) {
                if (nowTs - this.lastSlCooldownLogTime > 300000) {
                    this.lastSlCooldownLogTime = nowTs;
                    const minsLeft = Math.ceil((3600000 - (nowTs - this.lastStopLossTime)) / 60000);
                    this.log("info", `Bollinger BUY paused: post-stop-loss cooldown (${minsLeft}m remaining).`);
                }
                return;
            }
            const guard = this.canEnterBuy();
            if (!guard.allowed) {
                if (nowTs - this.lastGuardLogTime > 300000) {
                    this.lastGuardLogTime = nowTs;
                    this.log("warn", `🛡️ Bollinger BUY paused by Guard: ${guard.reason}`);
                }
                return;
            }
            const expGuard = await this.checkExposureCap();
            if (!expGuard.allowed) {
                if (nowTs - this.lastGuardLogTime > 300000) {
                    this.lastGuardLogTime = nowTs;
                    this.log("warn", `🛡️ Bollinger BUY paused by Exposure Cap: ${expGuard.reason}`);
                }
                return;
            }
            const cashCheck = await this.hasSufficientCash(this.config.orderAmount);
            if (!cashCheck.ok) {
                this.lastBuyErrorTime = nowTs;
                this.log("warn", `Bollinger BUY skipped: need $${this.config.orderAmount.toFixed(2)} free USD/USDC (have $${cashCheck.availableUsd.toFixed(2)}). Cooling down 5m.`);
                return;
            }
            this.log("info", `Bollinger BUY Signal: Price $${lastPrice} <= Lower Band $${currentBB.lower.toFixed(2)}`);
            const amount = Number((this.config.orderAmount / lastPrice).toFixed(5));
            if (amount > 0) {
                try {
                    await this.placeOrder("buy", "market", lastPrice, amount, true);
                    this.inPosition = true;
                    this.entryPrice = lastPrice;
                }
                catch (err) {
                    this.lastBuyErrorTime = Date.now();
                    this.log("error", `Failed executing Bollinger BUY (cooling down 5m): ${err.message}`);
                }
            }
        }
        // Reversion Target reached: Price touches middle/upper band AND clears Fee Shield TP
        else if (this.inPosition) {
            const minTpPct = Math.max(2.0, Number(this.config.takeProfitPercentage || 2.5));
            const minTpPrice = this.entryPrice > 0 ? this.entryPrice * (1 + minTpPct / 100) : 0;
            if (lastPrice >= currentBB.middle && lastPrice >= minTpPrice) {
                this.log("info", `Bollinger Mean Reversion Target: Price $${lastPrice} >= Middle Band $${currentBB.middle.toFixed(2)} (TP +${minTpPct}%)`);
                await this.closePosition(lastPrice);
            }
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
            this.log("error", `Failed closing Bollinger position: ${err.message}`);
        }
    }
}
exports.BollingerStrategy = BollingerStrategy;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MomentumStrategy = void 0;
const base_strategy_1 = require("./base-strategy");
const technicalindicators_1 = require("technicalindicators");
class MomentumStrategy extends base_strategy_1.BaseStrategy {
    config;
    inPosition = false;
    entryPrice = 0;
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
        this.log("info", `Momentum Strategy initialized on ${this.config.timeframe || "5m"} candles. RSI Period: ${this.config.rsiPeriod || 14}`);
    }
    async onTick(ticker) {
        // Check Take Profit or Stop Loss for active position
        if (this.inPosition && this.entryPrice > 0) {
            const pnlPct = ((ticker.last - this.entryPrice) / this.entryPrice) * 100;
            if (this.config.takeProfitPercentage && pnlPct >= this.config.takeProfitPercentage) {
                this.log("info", `Momentum Take-Profit hit (+${pnlPct.toFixed(2)}%) at $${ticker.last}`);
                await this.closePosition(ticker.last);
            }
            else if (this.config.stopLossPercentage && pnlPct <= -this.config.stopLossPercentage) {
                this.log("warn", `Momentum Stop-Loss hit (${pnlPct.toFixed(2)}%) at $${ticker.last}`);
                await this.closePosition(ticker.last);
            }
        }
    }
    async onCandle(candles) {
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
        if (!this.inPosition && prevRsi <= oversold && currentRsi > prevRsi) {
            this.log("info", `BUY Signal: RSI oversold rebound (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)}) at $${lastPrice}`);
            const amount = Number((this.config.orderAmount / lastPrice).toFixed(5));
            if (amount > 0) {
                try {
                    await this.placeOrder("buy", "market", lastPrice, amount);
                    this.inPosition = true;
                    this.entryPrice = lastPrice;
                }
                catch (err) {
                    this.log("error", `Failed executing Momentum BUY: ${err.message}`);
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
                const pnl = Number(((currentPrice - avgEntry) * sellAmount).toFixed(4));
                const order = await this.placeOrder("sell", "market", currentPrice, sellAmount);
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

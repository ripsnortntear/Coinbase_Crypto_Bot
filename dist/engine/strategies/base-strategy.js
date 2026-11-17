"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseStrategy = void 0;
const database_1 = require("../../db/database");
const regime_guard_1 = require("../regime-guard");
const ml_predictor_1 = require("../ml-predictor");
const daily_rotator_1 = require("../daily-rotator");
class BaseStrategy {
    bot;
    account;
    exchangeManager;
    db = (0, database_1.getDatabase)();
    constructor(bot, account, exchangeManager) {
        this.bot = bot;
        this.account = account;
        this.exchangeManager = exchangeManager;
    }
    log(level, message, metadata = {}) {
        try {
            this.db.prepare(`
        INSERT INTO system_logs (level, bot_id, symbol, message, metadata_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(level, this.bot.id, this.bot.symbol, message, JSON.stringify(metadata), new Date().toISOString());
        }
        catch (err) {
            console.error(`[Strategy Log Error]`, err);
        }
    }
    getOpenOrders() {
        return this.db.prepare(`
      SELECT * FROM orders
      WHERE bot_id = ? AND status = 'open'
    `).all(this.bot.id);
    }
    canEnterBuy() {
        try {
            const cb = this.db.prepare("SELECT value FROM system_settings WHERE key = 'circuit_breaker_tripped'").get();
            if (cb && cb.value === "true") {
                return { allowed: false, reason: "Global Daily Drawdown Circuit Breaker is TRIPPED" };
            }
            const panic = this.db.prepare("SELECT value FROM system_settings WHERE key = 'panic_active'").get();
            if (panic && panic.value === "true") {
                return { allowed: false, reason: "Emergency Panic Stop is ACTIVE" };
            }
            if (daily_rotator_1.DailyRotator.getInstance()?.isPendingRotation(this.bot.id)) {
                return { allowed: false, reason: "Bot is queued for Hyperopt rotation after closing current position" };
            }
        }
        catch { }
        const guard = regime_guard_1.RegimeGuard.getInstance();
        if (guard) {
            const res = guard.canOpenNewPosition();
            if (!res.allowed) {
                return { allowed: false, reason: res.reason };
            }
        }
        // Optional Continuous ML Filter
        try {
            const mlRow = this.db.prepare("SELECT value FROM system_settings WHERE key = 'ml_filter_enabled'").get();
            if (mlRow && mlRow.value === "true") {
                const pred = ml_predictor_1.MlPredictor.getInstance().predict(this.bot.symbol);
                if (pred.probUp < 0.42) {
                    return {
                        allowed: false,
                        reason: `ML Predictor bearish (${(pred.probUp * 100).toFixed(1)}% up prob, val acc ${pred.accuracy}%)`,
                    };
                }
            }
        }
        catch { }
        return { allowed: true };
    }
    hydratePositionFromDb() {
        try {
            const lastSell = this.db.prepare(`
        SELECT MAX(timestamp) as lastSellTime FROM trades WHERE bot_id = ? AND side = 'sell'
      `).get(this.bot.id);
            const activeBuys = lastSell && lastSell.lastSellTime
                ? this.db.prepare(`
            SELECT price, amount, cost FROM trades WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
          `).all(this.bot.id, lastSell.lastSellTime)
                : this.db.prepare(`
            SELECT price, amount, cost FROM trades WHERE bot_id = ? AND side = 'buy'
          `).all(this.bot.id);
            let totalAmount = 0;
            let totalCost = 0;
            for (const b of activeBuys) {
                totalAmount += b.amount;
                totalCost += b.cost;
            }
            totalAmount = Math.max(0, Number(totalAmount.toFixed(6)));
            const entryPrice = totalAmount > 0 ? totalCost / totalAmount : 0;
            return { inPosition: totalAmount > 0.00005, entryPrice, totalAmount };
        }
        catch {
            return { inPosition: false, entryPrice: 0, totalAmount: 0 };
        }
    }
    async hasSufficientCash(requiredUsd) {
        if (this.account.is_paper === 1)
            return { ok: true, availableUsd: requiredUsd };
        try {
            const balances = await this.exchangeManager.fetchBalances(this.account);
            const freeUsd = Number(balances["USD"]?.free || 0);
            const freeUsdc = Number(balances["USDC"]?.free || 0);
            const bestSingle = Math.max(freeUsd, freeUsdc);
            return { ok: bestSingle >= requiredUsd * 1.01, availableUsd: Number(bestSingle.toFixed(2)) };
        }
        catch {
            return { ok: true, availableUsd: requiredUsd };
        }
    }
    async checkExposureCap() {
        try {
            const row = this.db.prepare("SELECT value FROM system_settings WHERE key = 'max_coin_exposure_pct'").get();
            const maxPct = Number(row?.value || 50);
            if (maxPct >= 100 || maxPct <= 0)
                return { allowed: true };
            const baseAsset = this.bot.symbol.split("/")[0];
            const portfolio = await this.exchangeManager.calculateTotalPortfolioUsd(this.account);
            if (portfolio.totalUsd <= 0)
                return { allowed: true };
            const assetInfo = portfolio.balances[baseAsset];
            if (!assetInfo || assetInfo.total <= 0)
                return { allowed: true };
            const ticker = await this.exchangeManager.fetchTicker(this.bot.symbol, this.account.exchange_id);
            const assetUsd = assetInfo.total * (ticker.last || 0);
            const exposurePct = (assetUsd / portfolio.totalUsd) * 100;
            if (exposurePct >= maxPct) {
                return {
                    allowed: false,
                    reason: `${baseAsset} exposure is ${exposurePct.toFixed(1)}% (cap: ${maxPct}%)`,
                };
            }
        }
        catch { }
        return { allowed: true };
    }
    async placeOrder(side, type, price, amount, makerFirst = false) {
        const order = await this.exchangeManager.createOrder(this.account, {
            bot_id: this.bot.id,
            symbol: this.bot.symbol,
            side,
            type,
            price,
            amount,
            makerFirst,
        });
        this.log("trade", `Placed ${side.toUpperCase()} ${order.type.toUpperCase()} order: ${amount} ${this.bot.symbol} @ $${price.toFixed(2)}`, {
            orderId: order.id,
            side,
            type: order.type,
            price,
            amount,
        });
        if (side === "sell" && order.status === "filled") {
            setTimeout(() => {
                daily_rotator_1.DailyRotator.getInstance()?.onBotClosedPosition(this.bot.id).catch(() => { });
            }, 1500);
        }
        return order;
    }
    async cancelOrder(order) {
        const success = await this.exchangeManager.cancelOrder(order, this.account);
        if (success) {
            this.log("info", `Canceled ${order.side} order #${order.id.slice(0, 8)}`);
        }
        return success;
    }
}
exports.BaseStrategy = BaseStrategy;

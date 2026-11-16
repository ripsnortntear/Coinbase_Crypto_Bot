"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseStrategy = void 0;
const database_1 = require("../../db/database");
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
    async placeOrder(side, type, price, amount) {
        const order = await this.exchangeManager.createOrder(this.account, {
            bot_id: this.bot.id,
            symbol: this.bot.symbol,
            side,
            type,
            price,
            amount,
        });
        this.log("trade", `Placed ${side.toUpperCase()} ${type.toUpperCase()} order: ${amount} ${this.bot.symbol} @ $${price.toFixed(2)}`, {
            orderId: order.id,
            side,
            type,
            price,
            amount,
        });
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

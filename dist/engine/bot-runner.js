"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotRunner = void 0;
const crypto_1 = __importDefault(require("crypto"));
const events_1 = __importDefault(require("events"));
const database_1 = require("../db/database");
const grid_strategy_1 = require("./strategies/grid-strategy");
const dca_strategy_1 = require("./strategies/dca-strategy");
const momentum_strategy_1 = require("./strategies/momentum-strategy");
const bollinger_strategy_1 = require("./strategies/bollinger-strategy");
class BotRunner extends events_1.default {
    db = (0, database_1.getDatabase)();
    exchangeManager;
    activeStrategies = new Map();
    isRunning = false;
    loopInterval = null;
    candleInterval = null;
    reconcileInterval = null;
    activeSymbols = new Set(["ETH/USD", "BTC/USD", "SOL/USD", "BTC/USDT", "ETH/USDT"]);
    constructor(exchangeManager) {
        super();
        this.exchangeManager = exchangeManager;
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        // Load active bots from database
        const activeBots = this.db.prepare("SELECT * FROM trading_bots WHERE status = 'active'").all();
        for (const bot of activeBots) {
            await this.startBot(bot.id, false);
        }
        // Main Ticker & Strategy Evaluation Loop (Every 2.5s)
        this.loopInterval = setInterval(() => this.tickLoop(), 2500);
        // Candle Analysis Loop (Every 30s)
        this.candleInterval = setInterval(() => this.candleLoop(), 30000);
        // Live Exchange Order Reconciliation Loop (Every 15s)
        this.reconcileInterval = setInterval(() => this.reconcileLiveOrders(), 15000);
        // Initial immediate reconciliation
        setTimeout(() => this.reconcileLiveOrders(), 2000);
        console.log(`[BotRunner] Trading engine active with ${this.activeStrategies.size} running bots.`);
    }
    stop() {
        this.isRunning = false;
        if (this.loopInterval)
            clearInterval(this.loopInterval);
        if (this.candleInterval)
            clearInterval(this.candleInterval);
        if (this.reconcileInterval)
            clearInterval(this.reconcileInterval);
        this.activeStrategies.clear();
        console.log("[BotRunner] Trading engine stopped.");
    }
    async startBot(botId, updateDb = true) {
        const bot = this.db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId);
        if (!bot)
            return false;
        const account = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(bot.exchange_account_id);
        if (!account)
            return false;
        let strategy;
        switch (bot.strategy_type) {
            case "grid":
                strategy = new grid_strategy_1.GridStrategy(bot, account, this.exchangeManager);
                break;
            case "dca":
                strategy = new dca_strategy_1.DcaStrategy(bot, account, this.exchangeManager);
                break;
            case "momentum_rsi":
                strategy = new momentum_strategy_1.MomentumStrategy(bot, account, this.exchangeManager);
                break;
            case "bollinger":
                strategy = new bollinger_strategy_1.BollingerStrategy(bot, account, this.exchangeManager);
                break;
            default:
                return false;
        }
        await strategy.initialize();
        this.activeStrategies.set(bot.id, strategy);
        this.activeSymbols.add(bot.symbol);
        if (updateDb) {
            this.db.prepare("UPDATE trading_bots SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(botId);
        }
        this.emit("bot_status", { botId, status: "active" });
        return true;
    }
    async pauseBot(botId) {
        this.activeStrategies.delete(botId);
        this.db.prepare("UPDATE trading_bots SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(botId);
        this.emit("bot_status", { botId, status: "paused" });
        return true;
    }
    async stopBot(botId) {
        this.activeStrategies.delete(botId);
        this.db.prepare("UPDATE trading_bots SET status = 'stopped', updated_at = datetime('now') WHERE id = ?").run(botId);
        // Cancel open orders for this bot
        const openOrders = this.db.prepare("SELECT * FROM orders WHERE bot_id = ? AND status = 'open'").all(botId);
        for (const ord of openOrders) {
            const acc = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(ord.exchange_account_id);
            if (acc) {
                await this.exchangeManager.cancelOrder(ord, acc);
            }
        }
        this.emit("bot_status", { botId, status: "stopped" });
        return true;
    }
    async panicKillSwitch() {
        console.warn("[BotRunner] EMERGENCY PANIC KILL SWITCH ACTIVATED!");
        // Mark panic in settings
        this.db.prepare("UPDATE system_settings SET value = 'true' WHERE key = 'panic_active'").run();
        let pausedBots = 0;
        let canceledOrders = 0;
        // Pause all running strategies
        for (const botId of Array.from(this.activeStrategies.keys())) {
            await this.pauseBot(botId);
            pausedBots++;
        }
        // Cancel all open orders across paper and live
        const allOpenOrders = this.db.prepare("SELECT * FROM orders WHERE status = 'open'").all();
        for (const ord of allOpenOrders) {
            const acc = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(ord.exchange_account_id);
            if (acc) {
                await this.exchangeManager.cancelOrder(ord, acc);
                canceledOrders++;
            }
        }
        this.db.prepare(`
      INSERT INTO system_logs (level, message, metadata_json, timestamp)
      VALUES ('warn', 'EMERGENCY PANIC KILL SWITCH EXECUTED', ?, ?)
    `).run(JSON.stringify({ canceledOrders, pausedBots }), new Date().toISOString());
        this.emit("panic", { active: true, canceledOrders, pausedBots });
        return { canceledOrders, pausedBots };
    }
    async tickLoop() {
        for (const symbol of this.activeSymbols) {
            try {
                const ticker = await this.exchangeManager.fetchTicker(symbol);
                this.emit("ticker", ticker);
                // Match paper orders against this fresh ticker
                const trades = this.exchangeManager.getPaperEngine().matchOrdersAgainstTicker(ticker);
                for (const trd of trades) {
                    this.emit("trade", trd);
                }
                // Notify active strategies for this symbol
                for (const [botId, strategy] of this.activeStrategies.entries()) {
                    const bot = this.db.prepare("SELECT symbol FROM trading_bots WHERE id = ?").get(botId);
                    if (bot && bot.symbol === symbol) {
                        await strategy.onTick(ticker);
                    }
                }
            }
            catch (err) {
                // Ticker fetch error (e.g. temporary network blip)
            }
        }
    }
    async candleLoop() {
        for (const symbol of this.activeSymbols) {
            try {
                const candles = await this.exchangeManager.fetchOHLCV(symbol, "5m", 50);
                for (const [botId, strategy] of this.activeStrategies.entries()) {
                    const bot = this.db.prepare("SELECT symbol FROM trading_bots WHERE id = ?").get(botId);
                    if (bot && bot.symbol === symbol) {
                        await strategy.onCandle(candles);
                    }
                }
            }
            catch (err) { }
        }
    }
    async reconcileLiveOrders() {
        try {
            const openLiveOrders = this.db.prepare("SELECT * FROM orders WHERE status = 'open' AND is_paper = 0").all();
            for (const order of openLiveOrders) {
                if (!order.exchange_order_id)
                    continue;
                const account = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(order.exchange_account_id);
                if (!account)
                    continue;
                try {
                    const ex = this.exchangeManager.getAuthenticatedExchange(account);
                    if (!ex)
                        continue;
                    const exOrder = await ex.fetchOrder(order.exchange_order_id, order.symbol);
                    if (exOrder) {
                        const status = exOrder.status; // closed, canceled, open, etc.
                        if (status === "closed") {
                            const filled = exOrder.filled !== undefined && exOrder.filled > 0 ? exOrder.filled : order.amount;
                            const avgPrice = exOrder.average || exOrder.price || order.price;
                            const cost = exOrder.cost || (filled * avgPrice);
                            const fee = (exOrder.fee && exOrder.fee.cost) ? exOrder.fee.cost : 0;
                            const now = new Date().toISOString();
                            this.db.prepare(`
                UPDATE orders
                SET status = 'filled', filled_amount = ?, cost = ?, fee = ?, updated_at = ?
                WHERE id = ?
              `).run(filled, cost, fee, now, order.id);
                            const existingTrade = this.db.prepare("SELECT id FROM trades WHERE order_id = ?").get(order.id);
                            if (!existingTrade) {
                                let realizedPnl = 0;
                                if (order.side === "sell" && order.bot_id) {
                                    const lastSell = this.db.prepare(`
                    SELECT MAX(timestamp) as lastSellTime FROM trades WHERE bot_id = ? AND side = 'sell'
                  `).get(order.bot_id);
                                    const buyStats = lastSell && lastSell.lastSellTime
                                        ? this.db.prepare(`
                        SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
                        FROM trades WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
                      `).get(order.bot_id, lastSell.lastSellTime)
                                        : this.db.prepare(`
                        SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
                        FROM trades WHERE bot_id = ? AND side = 'buy'
                      `).get(order.bot_id);
                                    if (buyStats.totalCost && buyStats.totalAmount && buyStats.totalAmount > 0) {
                                        const avgBuy = buyStats.totalCost / buyStats.totalAmount;
                                        realizedPnl = Number(((avgPrice - avgBuy) * filled - fee).toFixed(4));
                                    }
                                    const isWin = realizedPnl > 0 ? 1 : 0;
                                    this.db.prepare(`
                    UPDATE trading_bots
                    SET realized_pnl = realized_pnl + ?,
                        total_trades = total_trades + 1,
                        winning_trades = winning_trades + ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                  `).run(realizedPnl, isWin, order.bot_id);
                                }
                                const tradeId = `live-trd-${crypto_1.default.randomUUID()}`;
                                this.db.prepare(`
                  INSERT INTO trades (
                    id, bot_id, order_id, symbol, side, price, amount, cost, fee, realized_pnl, is_paper, timestamp
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                `).run(tradeId, order.bot_id, order.id, order.symbol, order.side, avgPrice, filled, cost, fee, realizedPnl, now);
                                this.emit("trade", { id: tradeId, symbol: order.symbol, side: order.side, price: avgPrice, amount: filled, realized_pnl: realizedPnl });
                            }
                            console.log(`[OrderReconciliation] Order ${order.exchange_order_id} filled: ${filled} ${order.symbol} @ $${avgPrice}`);
                        }
                        else if (status === "canceled" || status === "expired" || status === "rejected") {
                            this.db.prepare(`
                UPDATE orders SET status = 'canceled', updated_at = datetime('now') WHERE id = ?
              `).run(order.id);
                            console.log(`[OrderReconciliation] Order ${order.exchange_order_id} marked canceled`);
                        }
                    }
                }
                catch (err) {
                    // Order query error or network blip
                }
            }
        }
        catch (e) { }
    }
}
exports.BotRunner = BotRunner;

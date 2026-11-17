"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBotsRouter = createBotsRouter;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../../db/database");
const backtester_1 = require("../../engine/backtester");
const optimizer_1 = require("../../engine/optimizer");
const strategy_plugins_1 = require("../../engine/strategy-plugins");
function createBotsRouter(botRunner) {
    const router = (0, express_1.Router)();
    const db = (0, database_1.getDatabase)();
    // List all bots
    router.get("/", (req, res) => {
        try {
            const bots = db.prepare(`
        SELECT b.*, e.name as exchange_name, e.is_paper
        FROM trading_bots b
        JOIN exchange_accounts e ON b.exchange_account_id = e.id
        ORDER BY b.created_at DESC
      `).all();
            res.json({ ok: true, data: bots });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Create new bot
    router.post("/", async (req, res) => {
        try {
            const { name, exchange_account_id, symbol, strategy_type, allocated_capital, config, } = req.body;
            if (!name || !exchange_account_id || !symbol || !strategy_type) {
                return res.status(400).json({ ok: false, error: "Missing required fields" });
            }
            const botId = `bot-${crypto_1.default.randomUUID()}`;
            const now = new Date().toISOString();
            const botConfig = { ...(config || {}) };
            if (strategy_type === "dca") {
                const cap = Number(allocated_capital) || 1000.0;
                botConfig.baseOrderAmount = Math.max(1.25, Number((cap * 0.25).toFixed(2)));
                botConfig.safetyOrderAmount = Math.max(1.25, Number((cap * 0.20).toFixed(2)));
                botConfig.takeProfitPercentage = Math.max(2.0, Number(botConfig.takeProfitPercentage ?? 2.5));
                botConfig.priceDropPercentage = Math.max(1.2, Number(botConfig.priceDropPercentage ?? 1.8));
            }
            else if (botConfig.takeProfitPercentage !== undefined) {
                botConfig.takeProfitPercentage = Math.max(2.0, Number(botConfig.takeProfitPercentage));
            }
            db.prepare(`
        INSERT INTO trading_bots (
          id, name, exchange_account_id, symbol, strategy_type, status,
          config_json, allocated_capital, realized_pnl, unrealized_pnl,
          total_trades, winning_trades, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, 0.0, 0.0, 0, 0, ?, ?)
      `).run(botId, name, exchange_account_id, symbol.toUpperCase(), strategy_type, JSON.stringify(botConfig), Number(allocated_capital) || 1000.0, now, now);
            db.prepare(`
        INSERT INTO system_logs (level, bot_id, symbol, message, timestamp)
        VALUES ('info', ?, ?, ?, ?)
      `).run(botId, symbol, `Created new ${strategy_type} bot: ${name}`, now);
            const created = db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId);
            res.json({ ok: true, data: created });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Start bot
    router.post("/:id/start", async (req, res) => {
        try {
            const botId = String(req.params.id);
            const success = await botRunner.startBot(botId);
            if (!success) {
                return res.status(400).json({ ok: false, error: "Failed to start bot" });
            }
            res.json({ ok: true, message: "Bot started successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Pause bot
    router.post("/:id/pause", async (req, res) => {
        try {
            const botId = String(req.params.id);
            const success = await botRunner.pauseBot(botId);
            if (!success) {
                return res.status(400).json({ ok: false, error: "Failed to pause bot" });
            }
            res.json({ ok: true, message: "Bot paused successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Stop bot
    router.post("/:id/stop", async (req, res) => {
        try {
            const botId = String(req.params.id);
            const success = await botRunner.stopBot(botId);
            if (!success) {
                return res.status(400).json({ ok: false, error: "Failed to stop bot" });
            }
            res.json({ ok: true, message: "Bot stopped and orders canceled" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Update bot capital & configuration
    router.patch("/:id", async (req, res) => {
        try {
            const botId = String(req.params.id);
            const { allocated_capital, name, config: incomingConfig, baseOrderAmount, safetyOrderAmount } = req.body;
            const bot = db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId);
            if (!bot) {
                return res.status(404).json({ ok: false, error: "Bot not found" });
            }
            let config = JSON.parse(bot.config_json || "{}");
            if (incomingConfig && typeof incomingConfig === "object") {
                config = { ...config, ...incomingConfig };
            }
            const newCapital = allocated_capital !== undefined ? Number(allocated_capital) : bot.allocated_capital;
            const newName = name || bot.name;
            if (bot.strategy_type === "dca") {
                config.baseOrderAmount = Math.max(1.25, Number((newCapital * 0.25).toFixed(2)));
                config.safetyOrderAmount = Math.max(1.25, Number((newCapital * 0.20).toFixed(2)));
            }
            else {
                if (baseOrderAmount !== undefined)
                    config.baseOrderAmount = Number(baseOrderAmount);
                if (safetyOrderAmount !== undefined)
                    config.safetyOrderAmount = Number(safetyOrderAmount);
            }
            // Anti-Negative-Spin Fee Shield: Enforce min 2.0% take-profit to clear exchange fees
            if (config.takeProfitPercentage !== undefined) {
                config.takeProfitPercentage = Math.max(2.0, Number(config.takeProfitPercentage));
            }
            if (config.priceDropPercentage !== undefined) {
                config.priceDropPercentage = Math.max(1.2, Number(config.priceDropPercentage));
            }
            db.prepare(`
        UPDATE trading_bots
        SET allocated_capital = ?, name = ?, config_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newCapital, newName, JSON.stringify(config), botId);
            // If active, reload the strategy instance with updated capital
            if (bot.status === "active") {
                await botRunner.startBot(botId, false);
            }
            db.prepare(`
        INSERT INTO system_logs (level, bot_id, symbol, message, timestamp)
        VALUES ('info', ?, ?, ?, ?)
      `).run(botId, bot.symbol, `Updated bot capital to $${newCapital.toFixed(2)}`, new Date().toISOString());
            res.json({ ok: true, message: "Bot updated successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Historical Backtest Simulator
    router.post("/backtest", async (req, res) => {
        try {
            const { symbol, strategy_type, timeframe, candle_limit, initial_capital, execution_mode, config } = req.body || {};
            if (!symbol || !strategy_type) {
                return res.status(400).json({ ok: false, error: "symbol and strategy_type are required" });
            }
            const backtester = new backtester_1.Backtester(botRunner.getExchangeManager());
            const result = await backtester.run({
                symbol: String(symbol).toUpperCase(),
                strategyType: strategy_type,
                timeframe: String(timeframe || "1h"),
                candleLimit: Number(candle_limit || 300),
                initialCapital: Number(initial_capital || 1000),
                executionMode: execution_mode === "taker" ? "taker" : "maker",
                config: config || {},
            });
            res.json({ ok: true, data: result });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Auto-Optimizer (Hyperopt Sweep)
    router.post("/optimize", async (req, res) => {
        try {
            const { symbol, strategy_type, timeframe, candle_limit, initial_capital, execution_mode } = req.body || {};
            if (!symbol || !strategy_type) {
                return res.status(400).json({ ok: false, error: "symbol and strategy_type are required" });
            }
            const optimizer = new optimizer_1.StrategyOptimizer(botRunner.getExchangeManager());
            const result = await optimizer.optimize({
                symbol: String(symbol).toUpperCase(),
                strategyType: strategy_type,
                timeframe: String(timeframe || "1h"),
                candleLimit: Number(candle_limit || 300),
                initialCapital: Number(initial_capital || 1000),
                executionMode: execution_mode === "taker" ? "taker" : "maker",
            });
            res.json({ ok: true, data: result });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Hot-Swappable Strategy Plugins
    router.get("/plugins", (req, res) => {
        res.json({ ok: true, data: strategy_plugins_1.StrategyPluginLoader.list() });
    });
    router.post("/plugins/reload", (req, res) => {
        const loaded = strategy_plugins_1.StrategyPluginLoader.loadAll();
        res.json({ ok: true, data: loaded, message: `Reloaded ${loaded.length} strategy plugin(s)` });
    });
    // Delete bot
    router.delete("/:id", async (req, res) => {
        try {
            const botId = String(req.params.id);
            await botRunner.stopBot(botId);
            db.prepare("DELETE FROM trading_bots WHERE id = ?").run(botId);
            res.json({ ok: true, message: "Bot deleted successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    return router;
}

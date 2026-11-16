"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrdersRouter = createOrdersRouter;
const express_1 = require("express");
const database_1 = require("../../db/database");
function createOrdersRouter(exchangeManager) {
    const router = (0, express_1.Router)();
    const db = (0, database_1.getDatabase)();
    // List recent orders
    router.get("/", (req, res) => {
        try {
            const limit = Number(req.query.limit) || 50;
            const status = req.query.status;
            let sql = `
        SELECT o.*, b.name as bot_name, e.name as exchange_name
        FROM orders o
        LEFT JOIN trading_bots b ON o.bot_id = b.id
        LEFT JOIN exchange_accounts e ON o.exchange_account_id = e.id
      `;
            const params = [];
            if (status) {
                sql += " WHERE o.status = ?";
                params.push(status);
            }
            sql += " ORDER BY o.created_at DESC LIMIT ?";
            params.push(limit);
            const orders = db.prepare(sql).all(...params);
            res.json({ ok: true, data: orders });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // List executed trades
    router.get("/trades", (req, res) => {
        try {
            const limit = Number(req.query.limit) || 50;
            const trades = db.prepare(`
        SELECT t.*, b.name as bot_name
        FROM trades t
        LEFT JOIN trading_bots b ON t.bot_id = b.id
        ORDER BY t.timestamp DESC LIMIT ?
      `).all(limit);
            res.json({ ok: true, data: trades });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Place manual order
    router.post("/manual", async (req, res) => {
        try {
            const { exchange_account_id, symbol, side, type, price, amount } = req.body;
            if (!exchange_account_id || !symbol || !side || !type || !amount) {
                return res.status(400).json({ ok: false, error: "Missing required order parameters" });
            }
            const account = db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(exchange_account_id);
            if (!account)
                return res.status(404).json({ ok: false, error: "Exchange account not found" });
            const numPrice = Number(price) || 0;
            const numAmount = Number(amount);
            const order = await exchangeManager.createOrder(account, {
                bot_id: null,
                symbol: symbol.toUpperCase(),
                side,
                type,
                price: numPrice,
                amount: numAmount,
            });
            db.prepare(`
        INSERT INTO system_logs (level, symbol, message, timestamp)
        VALUES ('trade', ?, ?, ?)
      `).run(symbol, `Manual ${side.toUpperCase()} ${type.toUpperCase()}: ${numAmount} @ $${numPrice.toFixed(2)}`, new Date().toISOString());
            res.json({ ok: true, data: order });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Cancel order
    router.post("/:id/cancel", async (req, res) => {
        try {
            const id = String(req.params.id);
            const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
            if (!order)
                return res.status(404).json({ ok: false, error: "Order not found" });
            const account = db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(order.exchange_account_id);
            if (!account)
                return res.status(404).json({ ok: false, error: "Associated exchange account not found" });
            const success = await exchangeManager.cancelOrder(order, account);
            if (!success) {
                return res.status(400).json({ ok: false, error: "Failed to cancel order" });
            }
            res.json({ ok: true, message: "Order canceled successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    return router;
}

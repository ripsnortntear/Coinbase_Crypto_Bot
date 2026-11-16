"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExchangesRouter = createExchangesRouter;
const express_1 = require("express");
const database_1 = require("../../db/database");
const encryption_1 = require("../../security/encryption");
function createExchangesRouter(exchangeManager) {
    const router = (0, express_1.Router)();
    const db = (0, database_1.getDatabase)();
    // List exchange accounts (live accounts only)
    router.get("/", (req, res) => {
        try {
            const accounts = db.prepare("SELECT * FROM exchange_accounts WHERE is_paper = 0 AND id NOT LIKE 'paper-%' ORDER BY created_at DESC").all();
            const sanitized = accounts.map((acc) => ({
                id: acc.id,
                name: acc.name,
                exchange_id: acc.exchange_id,
                is_paper: acc.is_paper,
                is_active: acc.is_active,
                has_api_key: Boolean(acc.api_key_encrypted),
                created_at: acc.created_at,
            }));
            res.json({ ok: true, data: sanitized });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Add new exchange account
    router.post("/", async (req, res) => {
        try {
            const { name, exchange_id, api_key, api_secret, passphrase, is_paper } = req.body;
            if (!name || !exchange_id) {
                return res.status(400).json({ ok: false, error: "Name and exchange_id required" });
            }
            const accId = is_paper ? `paper-${exchange_id}-${Date.now()}` : `live-${exchange_id}-${Date.now()}`;
            const encKey = api_key ? (0, encryption_1.encrypt)(api_key.trim()) : "";
            const encSec = api_secret ? (0, encryption_1.encrypt)(api_secret.trim()) : "";
            const encPass = passphrase ? (0, encryption_1.encrypt)(passphrase.trim()) : "";
            const now = new Date().toISOString();
            db.prepare(`
        INSERT INTO exchange_accounts (
          id, name, exchange_id, api_key_encrypted, api_secret_encrypted,
          passphrase_encrypted, is_paper, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(accId, name, exchange_id.toLowerCase(), encKey, encSec, encPass, is_paper ? 1 : 0, now, now);
            res.json({ ok: true, message: "Exchange account added successfully", id: accId });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Get account balances
    router.get("/:id/balances", async (req, res) => {
        try {
            const id = String(req.params.id);
            const acc = db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(id);
            if (!acc)
                return res.status(404).json({ ok: false, error: "Account not found" });
            const balances = await exchangeManager.fetchBalances(acc);
            res.json({ ok: true, data: balances });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Delete exchange account
    router.delete("/:id", (req, res) => {
        try {
            const id = String(req.params.id);
            db.prepare("DELETE FROM exchange_accounts WHERE id = ?").run(id);
            res.json({ ok: true, message: "Exchange account deleted" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    return router;
}

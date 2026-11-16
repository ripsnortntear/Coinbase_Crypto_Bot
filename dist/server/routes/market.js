"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMarketRouter = createMarketRouter;
const express_1 = require("express");
const POPULAR_SYMBOLS = [
    "ETH/USD",
    "BTC/USD",
    "SOL/USD",
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "DOGE/USD",
    "XRP/USD",
    "ADA/USD",
    "AVAX/USD",
];
function createMarketRouter(exchangeManager) {
    const router = (0, express_1.Router)();
    router.get("/symbols", (req, res) => {
        res.json({ ok: true, data: POPULAR_SYMBOLS });
    });
    router.get("/ticker", async (req, res) => {
        try {
            const symbol = req.query.symbol || "ETH/USD";
            const defaultEx = symbol.endsWith("/USD") ? "coinbase" : "kraken";
            const exchangeId = req.query.exchange || defaultEx;
            const ticker = await exchangeManager.fetchTicker(symbol, exchangeId);
            res.json({ ok: true, data: ticker });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    router.get("/ohlcv", async (req, res) => {
        try {
            const symbol = req.query.symbol || "ETH/USD";
            const timeframe = req.query.timeframe || "5m";
            const limit = Number(req.query.limit) || 120;
            const defaultEx = symbol.endsWith("/USD") ? "coinbase" : "kraken";
            const exchangeId = req.query.exchange || defaultEx;
            const candles = await exchangeManager.fetchOHLCV(symbol, timeframe, limit, exchangeId);
            // Format for TradingView Lightweight Charts (time in seconds)
            const formatted = candles.map((c) => ({
                time: Math.floor(c.timestamp / 1000),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
            }));
            res.json({ ok: true, data: formatted });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    return router;
}

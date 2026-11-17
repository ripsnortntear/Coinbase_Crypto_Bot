"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMarketRouter = createMarketRouter;
const express_1 = require("express");
const POPULAR_SYMBOLS = [
    "ETH/USD",
    "BTC/USD",
    "SOL/USD",
    "XRP/USD",
    "HYPE/USD",
    "ZEC/USD",
    "ICP/USD",
    "LIGHTER/USD",
    "AERO/USD",
    "NEAR/USD",
    "DOGE/USD",
    "SUI/USD",
    "AVAX/USD",
    "LINK/USD",
    "UNI/USD",
    "AAVE/USD",
    "ADA/USD",
    "LTC/USD",
    "VVV/USD",
    "QNT/USD",
    "XLM/USD",
    "PEPE/USD",
    "SHIB/USD",
    "BONK/USD",
    "TAO/USD",
    "APT/USD",
    "INJ/USD",
    "ARB/USD",
    "OP/USD",
    "BCH/USD",
];
const STABLE_BASES = new Set(["USDT", "USDC", "DAI", "PYUSD", "TUSD", "USDP", "GUSD", "EURC", "FDUSD"]);
let cachedCoinbasePairs = null;
function createMarketRouter(exchangeManager) {
    const router = (0, express_1.Router)();
    router.get("/symbols", (req, res) => {
        res.json({ ok: true, data: POPULAR_SYMBOLS });
    });
    // Dynamically discover ALL active volatile spot /USD markets on Coinbase
    router.get("/coinbase-pairs", async (req, res) => {
        try {
            const now = Date.now();
            if (cachedCoinbasePairs && now - cachedCoinbasePairs.ts < 5 * 60 * 1000) {
                return res.json({ ok: true, data: cachedCoinbasePairs.data });
            }
            const ex = exchangeManager.getPublicExchange("coinbase");
            const markets = await ex.loadMarkets();
            const tickers = await ex.fetchTickers();
            const pairs = Object.values(tickers)
                .filter((t) => {
                if (!t.symbol || !t.symbol.endsWith("/USD"))
                    return false;
                const base = t.symbol.split("/")[0];
                if (STABLE_BASES.has(base))
                    return false;
                const m = markets[t.symbol];
                return Boolean(m && m.active && (t.last || 0) > 0);
            })
                .map((t) => ({
                symbol: t.symbol,
                last: t.last || 0,
                volUsdM: Number(((t.quoteVolume || 0) / 1e6).toFixed(2)),
                changePct: Number((t.percentage || 0).toFixed(2)),
            }))
                .sort((a, b) => b.volUsdM - a.volUsdM);
            cachedCoinbasePairs = { data: pairs, ts: now };
            res.json({ ok: true, data: pairs });
        }
        catch (err) {
            const fallback = POPULAR_SYMBOLS.map((s) => ({ symbol: s, last: 0, volUsdM: 0, changePct: 0 }));
            res.json({ ok: true, data: cachedCoinbasePairs?.data || fallback });
        }
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

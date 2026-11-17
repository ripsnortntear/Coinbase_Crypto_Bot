import { Router, Request, Response } from "express";
import { ExchangeManager } from "../../engine/exchange-manager";

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
let cachedCoinbasePairs: { data: any[]; ts: number } | null = null;

export function createMarketRouter(exchangeManager: ExchangeManager): Router {
  const router = Router();

  router.get("/symbols", (req: Request, res: Response) => {
    res.json({ ok: true, data: POPULAR_SYMBOLS });
  });

  // Dynamically discover ALL active volatile spot /USD markets on Coinbase
  router.get("/coinbase-pairs", async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      if (cachedCoinbasePairs && now - cachedCoinbasePairs.ts < 5 * 60 * 1000) {
        return res.json({ ok: true, data: cachedCoinbasePairs.data });
      }

      const ex = exchangeManager.getPublicExchange("coinbase");
      const markets = await ex.loadMarkets();
      const tickers = await ex.fetchTickers();

      const pairs = Object.values(tickers)
        .filter((t: any) => {
          if (!t.symbol || !t.symbol.endsWith("/USD")) return false;
          const base = t.symbol.split("/")[0];
          if (STABLE_BASES.has(base)) return false;
          const m = markets[t.symbol];
          return Boolean(m && m.active && (t.last || 0) > 0);
        })
        .map((t: any) => ({
          symbol: t.symbol,
          last: t.last || 0,
          volUsdM: Number(((t.quoteVolume || 0) / 1e6).toFixed(2)),
          changePct: Number((t.percentage || 0).toFixed(2)),
        }))
        .sort((a: any, b: any) => b.volUsdM - a.volUsdM);

      cachedCoinbasePairs = { data: pairs, ts: now };
      res.json({ ok: true, data: pairs });
    } catch (err: any) {
      const fallback = POPULAR_SYMBOLS.map((s) => ({ symbol: s, last: 0, volUsdM: 0, changePct: 0 }));
      res.json({ ok: true, data: cachedCoinbasePairs?.data || fallback });
    }
  });

  router.get("/ticker", async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || "ETH/USD";
      const defaultEx = symbol.endsWith("/USD") ? "coinbase" : "kraken";
      const exchangeId = (req.query.exchange as string) || defaultEx;
      const ticker = await exchangeManager.fetchTicker(symbol, exchangeId);
      res.json({ ok: true, data: ticker });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/ohlcv", async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || "ETH/USD";
      const timeframe = (req.query.timeframe as string) || "5m";
      const limit = Number(req.query.limit) || 120;
      const defaultEx = symbol.endsWith("/USD") ? "coinbase" : "kraken";
      const exchangeId = (req.query.exchange as string) || defaultEx;

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
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

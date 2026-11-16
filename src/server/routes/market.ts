import { Router, Request, Response } from "express";
import { ExchangeManager } from "../../engine/exchange-manager";

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

export function createMarketRouter(exchangeManager: ExchangeManager): Router {
  const router = Router();

  router.get("/symbols", (req: Request, res: Response) => {
    res.json({ ok: true, data: POPULAR_SYMBOLS });
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

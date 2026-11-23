import { Router, Request, Response } from "express";
import { getDatabase } from "../../db/database";
import { ExchangeManager } from "../../engine/exchange-manager";
import { ExchangeAccount, Order } from "../../engine/types";

export function createOrdersRouter(exchangeManager: ExchangeManager): Router {
  const router = Router();
  const db = getDatabase();

  // List recent orders
  router.get("/", (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const status = req.query.status as string;

      let sql = `
        SELECT o.*, b.name as bot_name, e.name as exchange_name
        FROM orders o
        LEFT JOIN trading_bots b ON o.bot_id = b.id
        LEFT JOIN exchange_accounts e ON o.exchange_account_id = e.id
      `;
      const params: any[] = [];

      if (status) {
        sql += " WHERE o.status = ?";
        params.push(status);
      }

      sql += " ORDER BY o.created_at DESC LIMIT ?";
      params.push(limit);

      const orders = db.prepare(sql).all(...params);
      res.json({ ok: true, data: orders });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // List executed trades
  router.get("/trades", (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const trades = db.prepare(`
        SELECT t.*, b.name as bot_name
        FROM trades t
        LEFT JOIN trading_bots b ON t.bot_id = b.id
        ORDER BY t.timestamp DESC LIMIT ?
      `).all(limit);

      res.json({ ok: true, data: trades });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Place manual order
  router.post("/manual", async (req: Request, res: Response) => {
    try {
      const { exchange_account_id, symbol, side, type, price, amount } = req.body;

      if (!exchange_account_id || !symbol || !side || !type || !amount) {
        return res.status(400).json({ ok: false, error: "Missing required order parameters" });
      }

      const account = db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(exchange_account_id) as ExchangeAccount | undefined;
      if (!account) return res.status(404).json({ ok: false, error: "Exchange account not found" });

      let numPrice = Number(price) || 0;
      const numAmount = Number(amount);

      if (type === "market" && numPrice <= 0) {
        try {
          const ticker = await exchangeManager.fetchTicker(symbol.toUpperCase(), account.exchange_id);
          if (ticker?.last > 0) numPrice = ticker.last;
        } catch {}
      }

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
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Cancel order
  router.post("/:id/cancel", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as unknown as Order | undefined;
      if (!order) return res.status(404).json({ ok: false, error: "Order not found" });

      const account = db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(order.exchange_account_id) as unknown as ExchangeAccount | undefined;
      if (!account) return res.status(404).json({ ok: false, error: "Associated exchange account not found" });

      const success = await exchangeManager.cancelOrder(order, account);
      if (!success) {
        return res.status(400).json({ ok: false, error: "Failed to cancel order" });
      }

      res.json({ ok: true, message: "Order canceled successfully" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

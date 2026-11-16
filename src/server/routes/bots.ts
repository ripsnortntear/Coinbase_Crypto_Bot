import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getDatabase } from "../../db/database";
import { BotRunner } from "../../engine/bot-runner";

export function createBotsRouter(botRunner: BotRunner): Router {
  const router = Router();
  const db = getDatabase();

  // List all bots
  router.get("/", (req: Request, res: Response) => {
    try {
      const bots = db.prepare(`
        SELECT b.*, e.name as exchange_name, e.is_paper
        FROM trading_bots b
        JOIN exchange_accounts e ON b.exchange_account_id = e.id
        ORDER BY b.created_at DESC
      `).all();

      res.json({ ok: true, data: bots });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Create new bot
  router.post("/", async (req: Request, res: Response) => {
    try {
      const {
        name,
        exchange_account_id,
        symbol,
        strategy_type,
        allocated_capital,
        config,
      } = req.body;

      if (!name || !exchange_account_id || !symbol || !strategy_type) {
        return res.status(400).json({ ok: false, error: "Missing required fields" });
      }

      const botId = `bot-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const botConfig = { ...(config || {}) };

      if (strategy_type === "dca") {
        const cap = Number(allocated_capital) || 1000.0;
        botConfig.baseOrderAmount = Math.max(1.25, Number((cap * 0.25).toFixed(2)));
        botConfig.safetyOrderAmount = Math.max(1.25, Number((cap * 0.20).toFixed(2)));
        botConfig.takeProfitPercentage = Math.max(2.0, Number(botConfig.takeProfitPercentage ?? 2.5));
        botConfig.priceDropPercentage = Math.max(1.2, Number(botConfig.priceDropPercentage ?? 1.8));
      } else if (botConfig.takeProfitPercentage !== undefined) {
        botConfig.takeProfitPercentage = Math.max(2.0, Number(botConfig.takeProfitPercentage));
      }

      db.prepare(`
        INSERT INTO trading_bots (
          id, name, exchange_account_id, symbol, strategy_type, status,
          config_json, allocated_capital, realized_pnl, unrealized_pnl,
          total_trades, winning_trades, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, 0.0, 0.0, 0, 0, ?, ?)
      `).run(
        botId,
        name,
        exchange_account_id,
        symbol.toUpperCase(),
        strategy_type,
        JSON.stringify(botConfig),
        Number(allocated_capital) || 1000.0,
        now,
        now
      );

      db.prepare(`
        INSERT INTO system_logs (level, bot_id, symbol, message, timestamp)
        VALUES ('info', ?, ?, ?, ?)
      `).run(botId, symbol, `Created new ${strategy_type} bot: ${name}`, now);

      const created = db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId);
      res.json({ ok: true, data: created });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Start bot
  router.post("/:id/start", async (req: Request, res: Response) => {
    try {
      const botId = String(req.params.id);
      const success = await botRunner.startBot(botId);
      if (!success) {
        return res.status(400).json({ ok: false, error: "Failed to start bot" });
      }
      res.json({ ok: true, message: "Bot started successfully" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Pause bot
  router.post("/:id/pause", async (req: Request, res: Response) => {
    try {
      const botId = String(req.params.id);
      const success = await botRunner.pauseBot(botId);
      if (!success) {
        return res.status(400).json({ ok: false, error: "Failed to pause bot" });
      }
      res.json({ ok: true, message: "Bot paused successfully" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Stop bot
  router.post("/:id/stop", async (req: Request, res: Response) => {
    try {
      const botId = String(req.params.id);
      const success = await botRunner.stopBot(botId);
      if (!success) {
        return res.status(400).json({ ok: false, error: "Failed to stop bot" });
      }
      res.json({ ok: true, message: "Bot stopped and orders canceled" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Update bot capital & configuration
  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      const botId = String(req.params.id);
      const { allocated_capital, name, config: incomingConfig, baseOrderAmount, safetyOrderAmount } = req.body;
      const bot = db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId) as any;
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
      } else {
        if (baseOrderAmount !== undefined) config.baseOrderAmount = Number(baseOrderAmount);
        if (safetyOrderAmount !== undefined) config.safetyOrderAmount = Number(safetyOrderAmount);
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
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Delete bot
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const botId = String(req.params.id);
      await botRunner.stopBot(botId);
      db.prepare("DELETE FROM trading_bots WHERE id = ?").run(botId);
      res.json({ ok: true, message: "Bot deleted successfully" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

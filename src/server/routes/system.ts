import { Router, Request, Response } from "express";
import { getDatabase } from "../../db/database";
import { BotRunner } from "../../engine/bot-runner";
import { ExchangeManager } from "../../engine/exchange-manager";
import { RegimeGuard } from "../../engine/regime-guard";
import { MlPredictor } from "../../engine/ml-predictor";

export function createSystemRouter(botRunner: BotRunner, exchangeManager: ExchangeManager): Router {
  const router = Router();
  const db = getDatabase();

  // Health check endpoint for system monitoring & watchdogs
  router.get("/health", (req: Request, res: Response) => {
    try {
      // Basic DB check
      db.prepare("SELECT 1").get();
      res.json({
        ok: true,
        status: "healthy",
        service: "crypto-bot",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, status: "degraded", error: err.message });
    }
  });

  // System Status details (PID, memory, node, uptime)
  router.get("/status", (req: Request, res: Response) => {
    try {
      const mem = process.memoryUsage();
      const activeBotsCount = db.prepare("SELECT COUNT(*) as count FROM trading_bots WHERE status = 'active'").get() as { count: number };
      const totalBotsCount = db.prepare("SELECT COUNT(*) as count FROM trading_bots").get() as { count: number };

      res.json({
        ok: true,
        data: {
          pid: process.pid,
          uptime: process.uptime(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: {
            rssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
            heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
            heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
          },
          activeBots: activeBotsCount.count,
          totalBots: totalBotsCount.count,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Graceful Restart Trigger
  router.post("/restart", (req: Request, res: Response) => {
    try {
      db.prepare("INSERT INTO system_logs (level, message, timestamp) VALUES ('info', 'Service restart requested by administrator via dashboard', ?)").run(new Date().toISOString());
      res.json({ ok: true, message: "Engine service restart initiated. Restarting in 1 second..." });

      // Exit process gracefully after sending HTTP response; systemd Restart=always will immediately restart the daemon
      setTimeout(() => {
        console.log("[System] Graceful service restart initiated by administrator.");
        process.exit(0);
      }, 800);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Overview dashboard stats
  router.get("/overview", async (req: Request, res: Response) => {
    try {
      const activeBotsCount = db.prepare("SELECT COUNT(*) as count FROM trading_bots WHERE status = 'active'").get() as { count: number };
      const totalBotsCount = db.prepare("SELECT COUNT(*) as count FROM trading_bots").get() as { count: number };
      const pnlStats = db.prepare(`
        SELECT SUM(realized_pnl) as totalPnl,
               SUM(winning_trades) as winningTrades,
               SUM(total_trades) as totalBotClosedTrades
        FROM trading_bots
      `).get() as { totalPnl: number | null; winningTrades: number | null; totalBotClosedTrades: number | null };

      // Total executed trades count from trades table directly
      const tradeCountStat = db.prepare("SELECT COUNT(*) as count FROM trades").get() as { count: number };
      const totalTradesCount = tradeCountStat ? tradeCountStat.count : 0;

      // Closed round-trips for bot win rate
      const totalClosedTrades = pnlStats.totalBotClosedTrades || 0;

      const panicSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'panic_active'").get() as { value: string } | undefined;

      // Live portfolio balance computation
      const liveAccount = db.prepare("SELECT * FROM exchange_accounts WHERE is_paper = 0 AND is_active = 1 LIMIT 1").get() as any;
      let livePortfolio = { totalUsd: 0, balances: {} as any, breakdown: "No live account connected", accountName: "None" };

      if (liveAccount) {
        try {
          const calc = await exchangeManager.calculateTotalPortfolioUsd(liveAccount);
          livePortfolio = {
            totalUsd: calc.totalUsd,
            balances: calc.balances,
            breakdown: calc.breakdown,
            accountName: liveAccount.name,
          };
        } catch (balErr: any) {
          console.warn("[SystemRouter] Failed fetching live balance:", balErr.message);
        }
      }

      const regime = RegimeGuard.getInstance()?.getSnapshot() || null;
      const circuitBreaker = botRunner.checkDailyDrawdownCircuitBreaker();

      res.json({
        ok: true,
        data: {
          activeBots: activeBotsCount.count,
          totalBots: totalBotsCount.count,
          totalPnl: pnlStats.totalPnl || 0.0,
          totalTrades: totalTradesCount,
          winningTrades: pnlStats.winningTrades || 0,
          winRate: totalClosedTrades ? Math.round(((pnlStats.winningTrades || 0) / totalClosedTrades) * 100) : (pnlStats.winningTrades ? 100 : 0),
          panicActive: panicSetting?.value === "true",
          livePortfolio,
          paperBalances: {},
          regime,
          circuitBreaker,
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Query logs
  router.get("/logs", (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 100;
      const logs = db.prepare(`
        SELECT l.*, b.name as bot_name
        FROM system_logs l
        LEFT JOIN trading_bots b ON l.bot_id = b.id
        ORDER BY l.timestamp DESC LIMIT ?
      `).all(limit);

      res.json({ ok: true, data: logs });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Emergency Panic Kill-Switch
  router.post("/panic", async (req: Request, res: Response) => {
    try {
      const result = await botRunner.panicKillSwitch();
      res.json({
        ok: true,
        message: "EMERGENCY PANIC KILL SWITCH EXECUTED! All bots paused and open orders canceled.",
        data: result,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reset Panic Flag
  router.post("/panic/reset", (req: Request, res: Response) => {
    try {
      db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'panic_active'").run();
      db.prepare("INSERT INTO system_logs (level, message, timestamp) VALUES ('info', 'Emergency panic status cleared by administrator', ?)").run(new Date().toISOString());
      res.json({ ok: true, message: "Panic state cleared" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Reset Paper Trading Balances
  router.post("/paper/reset", (req: Request, res: Response) => {
    try {
      exchangeManager.getPaperEngine().resetBalances();
      db.prepare("INSERT INTO system_logs (level, message, timestamp) VALUES ('info', 'Paper trading balances reset to defaults ($25,000 USDT, $10,000 USD)', ?)").run(new Date().toISOString());
      res.json({ ok: true, message: "Paper balances reset to default portfolio" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Market Regime Guard & Risk Settings
  router.get("/regime", (req: Request, res: Response) => {
    try {
      const guard = RegimeGuard.getInstance();
      const regime = guard ? guard.getSnapshot() : null;
      const circuitBreaker = botRunner.checkDailyDrawdownCircuitBreaker();
      const rows = db.prepare("SELECT key, value FROM system_settings").all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      for (const r of rows) settings[r.key] = r.value;
      res.json({ ok: true, data: { regime, circuitBreaker, settings } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/regime/refresh", async (req: Request, res: Response) => {
    try {
      const guard = RegimeGuard.getInstance();
      if (!guard) return res.status(503).json({ ok: false, error: "RegimeGuard not initialized" });
      const snapshot = await guard.refresh();
      res.json({ ok: true, data: snapshot });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get("/ml", (req: Request, res: Response) => {
    try {
      res.json({ ok: true, data: MlPredictor.getInstance().getAllModels() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/settings", (req: Request, res: Response) => {
    try {
      const {
        regime_guard_enabled,
        maker_first_enabled,
        max_daily_loss_usd,
        circuit_breaker_tripped,
        ml_filter_enabled,
        max_coin_exposure_pct,
      } = req.body || {};
      const upsert = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
      if (regime_guard_enabled !== undefined) {
        upsert.run("regime_guard_enabled", String(Boolean(regime_guard_enabled)));
      }
      if (maker_first_enabled !== undefined) {
        upsert.run("maker_first_enabled", String(Boolean(maker_first_enabled)));
      }
      if (max_daily_loss_usd !== undefined && Number(max_daily_loss_usd) > 0) {
        upsert.run("max_daily_loss_usd", String(Number(max_daily_loss_usd)));
      }
      if (circuit_breaker_tripped !== undefined) {
        upsert.run("circuit_breaker_tripped", String(Boolean(circuit_breaker_tripped)));
      }
      if (ml_filter_enabled !== undefined) {
        upsert.run("ml_filter_enabled", String(Boolean(ml_filter_enabled)));
      }
      if (max_coin_exposure_pct !== undefined && Number(max_coin_exposure_pct) > 0 && Number(max_coin_exposure_pct) <= 100) {
        upsert.run("max_coin_exposure_pct", String(Number(max_coin_exposure_pct)));
      }
      db.prepare("INSERT INTO system_logs (level, message, timestamp) VALUES ('info', 'Risk & execution settings updated by administrator', ?)").run(new Date().toISOString());
      res.json({ ok: true, message: "Settings updated" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

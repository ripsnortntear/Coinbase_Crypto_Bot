import { Router, Request, Response } from "express";
import { getDatabase } from "../../db/database";
import { BotRunner } from "../../engine/bot-runner";
import { ExchangeManager } from "../../engine/exchange-manager";

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

  return router;
}

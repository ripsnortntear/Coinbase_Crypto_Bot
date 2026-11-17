import crypto from "crypto";
import { getDatabase } from "../db/database";
import { ExchangeManager } from "./exchange-manager";
import { StrategyOptimizer } from "./optimizer";
import { BotRunner } from "./bot-runner";
import { StrategyType } from "./types";

const STABLE_BASES = new Set(["USDT", "USDC", "DAI", "PYUSD", "TUSD", "USDP", "GUSD", "EURC", "FDUSD"]);
const FALLBACK_PAIRS = [
  "ETH/USD", "BTC/USD", "SOL/USD", "ZEC/USD", "XRP/USD",
  "HYPE/USD", "NEAR/USD", "DOGE/USD", "SUI/USD", "AERO/USD",
  "ICP/USD", "LINK/USD", "AVAX/USD",
];

export interface RotatorCandidate {
  symbol: string;
  strategyType: StrategyType;
  returnPct: number;
  winRate: number;
  trades: number;
  maxDD: number;
  sharpe: number;
  score: number;
  config: Record<string, any>;
}

export interface RotatorReport {
  ranAt: string;
  marketsEvaluated: number;
  topCandidates: RotatorCandidate[];
  deployedBots: string[];
  removedBots: string[];
  keptOpenBots: string[];
}

export class DailyRotator {
  private static instance: DailyRotator | null = null;
  private db = getDatabase();
  private botRunner: BotRunner;
  private exchangeManager: ExchangeManager;
  private optimizer: StrategyOptimizer;
  private interval: NodeJS.Timeout | null = null;
  private isRunningSweep = false;
  private lastReport: RotatorReport | null = null;

  private constructor(botRunner: BotRunner, exchangeManager: ExchangeManager) {
    this.botRunner = botRunner;
    this.exchangeManager = exchangeManager;
    this.optimizer = new StrategyOptimizer(exchangeManager);
  }

  public static init(botRunner: BotRunner, exchangeManager: ExchangeManager): DailyRotator {
    if (!DailyRotator.instance) {
      DailyRotator.instance = new DailyRotator(botRunner, exchangeManager);
    }
    return DailyRotator.instance;
  }

  public static getInstance(): DailyRotator | null {
    return DailyRotator.instance;
  }

  public start(): void {
    if (this.interval) return;
    // Check once per hour whether 24h have elapsed since last rotation
    this.interval = setInterval(() => {
      this.checkAndRunIfDue().catch(() => {});
    }, 60 * 60 * 1000);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public isEnabled(): boolean {
    try {
      const row = this.db.prepare("SELECT value FROM system_settings WHERE key = 'auto_rotate_enabled'").get() as { value: string } | undefined;
      return row ? row.value !== "false" : true;
    } catch {
      return true;
    }
  }

  public getLastReport(): RotatorReport | null {
    return this.lastReport;
  }

  private async checkAndRunIfDue(): Promise<void> {
    if (!this.isEnabled() || this.isRunningSweep) return;
    const row = this.db.prepare("SELECT value FROM system_settings WHERE key = 'last_auto_rotate_ts'").get() as { value: string } | undefined;
    const lastTs = row ? Number(row.value) : 0;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - lastTs >= oneDayMs) {
      await this.runRotation();
    }
  }

  private async getTop13LiquidMarkets(): Promise<string[]> {
    try {
      const ex = this.exchangeManager.getPublicExchange("coinbase");
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
        .sort((a: any, b: any) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, 13)
        .map((t: any) => t.symbol);

      if (pairs.length >= 5) return pairs;
    } catch {}
    return FALLBACK_PAIRS;
  }

  public async runRotation(): Promise<RotatorReport> {
    if (this.isRunningSweep) {
      throw new Error("Daily Hyperopt rotation is already running");
    }
    this.isRunningSweep = true;

    const deployedBots: string[] = [];
    const removedBots: string[] = [];
    const keptOpenBots: string[] = [];

    try {
      const pairs = await this.getTop13LiquidMarkets();
      const candidates: RotatorCandidate[] = [];

      // Sweep both DCA and Bollinger across the 13 most liquid Coinbase markets (240 x 1h = 10 days)
      for (const symbol of pairs) {
        for (const strategyType of ["dca", "bollinger"] as StrategyType[]) {
          try {
            const res = await this.optimizer.optimize({
              symbol,
              strategyType,
              timeframe: "1h",
              candleLimit: 240,
              initialCapital: 1000,
              executionMode: "maker",
            });
            const best = res.topResults?.[0];
            if (best) {
              candidates.push({
                symbol,
                strategyType,
                returnPct: best.metrics.totalReturnPct,
                winRate: best.metrics.winRate,
                trades: best.metrics.totalTrades,
                maxDD: best.metrics.maxDrawdownPct,
                sharpe: best.metrics.sharpeRatio,
                score: best.score,
                config: best.config,
              });
            }
          } catch {}
        }
      }

      // Deduplicate by symbol (keep best strategy per symbol) and rank descending
      const bestPerSymbol = new Map<string, RotatorCandidate>();
      for (const c of candidates) {
        const existing = bestPerSymbol.get(c.symbol);
        if (!existing || c.score > existing.score) {
          bestPerSymbol.set(c.symbol, c);
        }
      }

      const ranked = Array.from(bestPerSymbol.values()).sort((a, b) => b.score - a.score);
      // Select top 2 profitable markets (returnPct > 0), or top 1 if only 1 is profitable
      const winners = ranked.filter((c) => c.returnPct > 0).slice(0, 2);
      const winnerKeys = new Set(winners.map((w) => `${w.symbol}:${w.strategyType}`));

      const account = this.db.prepare("SELECT * FROM exchange_accounts WHERE is_paper = 0 AND is_active = 1 LIMIT 1").get() as any;
      if (account) {
        const balances = await this.exchangeManager.fetchBalances(account, true);
        const existingBots = this.db.prepare("SELECT * FROM trading_bots WHERE exchange_account_id = ?").all(account.id) as any[];

        // 1. Safely remove non-winning bots ONLY if they have no open asset position on exchange
        for (const bot of existingBots) {
          const key = `${bot.symbol}:${bot.strategy_type}`;
          if (winnerKeys.has(key)) continue;

          const baseAsset = String(bot.symbol).split("/")[0];
          const freeBase = Number(balances[baseAsset]?.free || 0);
          let assetUsd = 0;
          try {
            const t = await this.exchangeManager.fetchTicker(bot.symbol, account.exchange_id);
            assetUsd = freeBase * (t.last || 0);
          } catch {}

          if (assetUsd >= 1.5) {
            keptOpenBots.push(`${bot.name} (holding $${assetUsd.toFixed(2)} ${baseAsset})`);
            continue;
          }

          // Safe to remove flat underperforming bot & its associated trades/orders
          await this.botRunner.stopBot(bot.id);
          this.db.prepare("DELETE FROM trades WHERE bot_id = ?").run(bot.id);
          this.db.prepare("DELETE FROM orders WHERE bot_id = ?").run(bot.id);
          this.db.prepare("DELETE FROM trading_bots WHERE id = ?").run(bot.id);
          removedBots.push(`${bot.name} (${bot.symbol})`);
        }

        // 2. Deploy or update winning bots using available free USD + USDC
        const freeCash = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);
        const perBotCapital = winners.length > 0 ? Math.max(4.0, Number((freeCash / winners.length).toFixed(2))) : 0;

        for (const w of winners) {
          const existing = this.db.prepare(
            "SELECT * FROM trading_bots WHERE exchange_account_id = ? AND symbol = ? AND strategy_type = ?"
          ).get(account.id, w.symbol, w.strategyType) as any;

          const botConfig =
            w.strategyType === "dca"
              ? {
                  baseOrderAmount: Math.max(1.25, Number((perBotCapital * 0.25).toFixed(2))),
                  safetyOrderAmount: Math.max(1.25, Number((perBotCapital * 0.20).toFixed(2))),
                  maxSafetyOrders: 5,
                  priceDropPercentage: Math.max(1.2, Number(w.config.priceDropPercentage || 1.8)),
                  takeProfitPercentage: Math.max(2.0, Number(w.config.takeProfitPercentage || 2.5)),
                  trailingTakeProfitPercentage: Number(w.config.trailingTakeProfitPercentage || 0) || undefined,
                }
              : {
                  period: 20,
                  stdDev: 2,
                  timeframe: "1h",
                  orderAmount: Math.max(2.0, Number((perBotCapital * 0.5).toFixed(2))),
                  takeProfitPercentage: Math.max(2.0, Number(w.config.takeProfitPercentage || 4.0)),
                  stopLossPercentage: 6.0,
                };

          if (existing) {
            this.db.prepare("UPDATE trading_bots SET config_json = ?, updated_at = datetime('now') WHERE id = ?")
              .run(JSON.stringify(botConfig), existing.id);
            if (existing.status !== "active") {
              await this.botRunner.startBot(existing.id, true);
            }
            deployedBots.push(`${existing.name} (updated ${w.symbol} ${w.strategyType} TP +${botConfig.takeProfitPercentage}%)`);
          } else if (freeCash >= 4.0) {
            const botId = `bot-${crypto.randomUUID()}`;
            const base = w.symbol.split("/")[0];
            const name = `Auto ${base} ${w.strategyType === "dca" ? "DCA" : "Bollinger"}`;
            const now = new Date().toISOString();
            this.db.prepare(`
              INSERT INTO trading_bots (
                id, name, exchange_account_id, symbol, strategy_type, status,
                config_json, allocated_capital, realized_pnl, unrealized_pnl,
                total_trades, winning_trades, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, 0.0, 0.0, 0, 0, ?, ?)
            `).run(botId, name, account.id, w.symbol, w.strategyType, JSON.stringify(botConfig), perBotCapital, now, now);
            await this.botRunner.startBot(botId, true);
            deployedBots.push(`${name} (${w.symbol} ${w.strategyType} TP +${botConfig.takeProfitPercentage}%)`);
          }
        }
      }

      const report: RotatorReport = {
        ranAt: new Date().toISOString(),
        marketsEvaluated: pairs.length,
        topCandidates: ranked.slice(0, 6),
        deployedBots,
        removedBots,
        keptOpenBots,
      };
      this.lastReport = report;

      this.db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('last_auto_rotate_ts', ?)").run(String(Date.now()));
      this.db.prepare(`
        INSERT INTO system_logs (level, message, metadata_json, timestamp)
        VALUES ('info', ?, ?, ?)
      `).run(
        `🤖 Daily Hyperopt Rotator finished (${pairs.length} markets): Deployed [${deployedBots.join(", ") || "None"}], Removed [${removedBots.join(", ") || "None"}]`,
        JSON.stringify(report),
        report.ranAt
      );

      return report;
    } finally {
      this.isRunningSweep = false;
    }
  }
}

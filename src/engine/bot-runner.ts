import crypto from "crypto";
import EventEmitter from "events";
import { getDatabase } from "../db/database";
import { ExchangeManager } from "./exchange-manager";
import { TradingBot, ExchangeAccount, TickerData, BotStatus } from "./types";
import { BaseStrategy } from "./strategies/base-strategy";
import { GridStrategy } from "./strategies/grid-strategy";
import { DcaStrategy } from "./strategies/dca-strategy";
import { MomentumStrategy } from "./strategies/momentum-strategy";
import { BollingerStrategy } from "./strategies/bollinger-strategy";
import { RebalanceStrategy } from "./strategies/rebalance-strategy";
import { MarketMakerStrategy } from "./strategies/market-maker-strategy";
import { CustomRuleStrategy } from "./strategies/custom-rule-strategy";
import { StrategyPluginLoader } from "./strategy-plugins";
import { MlPredictor } from "./ml-predictor";
import { RegimeGuard } from "./regime-guard";

export class BotRunner extends EventEmitter {
  private db = getDatabase();
  private exchangeManager: ExchangeManager;
  private activeStrategies: Map<string, BaseStrategy> = new Map();
  private isRunning = false;
  private loopInterval: NodeJS.Timeout | null = null;
  private candleInterval: NodeJS.Timeout | null = null;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private mlInterval: NodeJS.Timeout | null = null;
  private activeSymbols: Set<string> = new Set(["ETH/USD", "BTC/USD", "SOL/USD", "BTC/USDT", "ETH/USDT"]);

  constructor(exchangeManager: ExchangeManager) {
    super();
    this.exchangeManager = exchangeManager;
  }

  public getExchangeManager(): ExchangeManager {
    return this.exchangeManager;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Load active bots from database
    const activeBots = this.db.prepare("SELECT * FROM trading_bots WHERE status = 'active'").all() as unknown as TradingBot[];
    for (const bot of activeBots) {
      await this.startBot(bot.id, false);
    }

    // Main Ticker & Strategy Evaluation Loop (Every 2.5s)
    this.loopInterval = setInterval(() => this.tickLoop(), 2500);

    // Candle Analysis Loop (Every 30s)
    this.candleInterval = setInterval(() => this.candleLoop(), 30000);

    // Live Exchange Order Reconciliation Loop (Every 15s)
    this.reconcileInterval = setInterval(() => this.reconcileLiveOrders(), 15000);
    // Initial immediate reconciliation
    setTimeout(() => this.reconcileLiveOrders(), 2000);

    // Start Market Regime Guard (Fear & Greed + BTC Volatility)
    RegimeGuard.init(this.exchangeManager).start();

    // Load hot-swappable strategy plugins
    StrategyPluginLoader.loadAll();

    // Continuous ML Retraining Loop (initial at 6s, then every 15 minutes)
    setTimeout(() => this.retrainMlModels(), 6000);
    this.mlInterval = setInterval(() => this.retrainMlModels(), 15 * 60 * 1000);

    console.log(`[BotRunner] Trading engine active with ${this.activeStrategies.size} running bots.`);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.loopInterval) clearInterval(this.loopInterval);
    if (this.candleInterval) clearInterval(this.candleInterval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    if (this.mlInterval) clearInterval(this.mlInterval);
    RegimeGuard.getInstance()?.stop();
    this.activeStrategies.clear();
    console.log("[BotRunner] Trading engine stopped.");
  }

  public async startBot(botId: string, updateDb = true): Promise<boolean> {
    const bot = this.db.prepare("SELECT * FROM trading_bots WHERE id = ?").get(botId) as TradingBot | undefined;
    if (!bot) return false;

    const account = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(bot.exchange_account_id) as ExchangeAccount | undefined;
    if (!account) return false;

    let strategy: BaseStrategy;
    switch (bot.strategy_type) {
      case "grid":
        strategy = new GridStrategy(bot, account, this.exchangeManager);
        break;
      case "dca":
        strategy = new DcaStrategy(bot, account, this.exchangeManager);
        break;
      case "momentum_rsi":
        strategy = new MomentumStrategy(bot, account, this.exchangeManager);
        break;
      case "bollinger":
        strategy = new BollingerStrategy(bot, account, this.exchangeManager);
        break;
      case "rebalance":
        strategy = new RebalanceStrategy(bot, account, this.exchangeManager);
        break;
      case "market_maker":
        strategy = new MarketMakerStrategy(bot, account, this.exchangeManager);
        break;
      case "custom_rule":
        strategy = new CustomRuleStrategy(bot, account, this.exchangeManager);
        break;
      default: {
        const PluginClass = StrategyPluginLoader.get(bot.strategy_type);
        if (!PluginClass) return false;
        strategy = new PluginClass(bot, account, this.exchangeManager);
        break;
      }
    }

    await strategy.initialize();
    this.activeStrategies.set(bot.id, strategy);
    this.activeSymbols.add(bot.symbol);

    if (updateDb) {
      this.db.prepare("UPDATE trading_bots SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(botId);
    }

    this.emit("bot_status", { botId, status: "active" });
    return true;
  }

  public async pauseBot(botId: string): Promise<boolean> {
    this.activeStrategies.delete(botId);
    this.db.prepare("UPDATE trading_bots SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(botId);
    this.emit("bot_status", { botId, status: "paused" });
    return true;
  }

  public async stopBot(botId: string): Promise<boolean> {
    this.activeStrategies.delete(botId);
    this.db.prepare("UPDATE trading_bots SET status = 'stopped', updated_at = datetime('now') WHERE id = ?").run(botId);

    // Cancel open orders for this bot
    const openOrders = this.db.prepare("SELECT * FROM orders WHERE bot_id = ? AND status = 'open'").all(botId) as any[];
    for (const ord of openOrders) {
      const acc = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(ord.exchange_account_id) as any;
      if (acc) {
        await this.exchangeManager.cancelOrder(ord, acc);
      }
    }

    this.emit("bot_status", { botId, status: "stopped" });
    return true;
  }

  public async panicKillSwitch(): Promise<{ canceledOrders: number; pausedBots: number }> {
    console.warn("[BotRunner] EMERGENCY PANIC KILL SWITCH ACTIVATED!");

    // Mark panic in settings
    this.db.prepare("UPDATE system_settings SET value = 'true' WHERE key = 'panic_active'").run();

    let pausedBots = 0;
    let canceledOrders = 0;

    // Pause all running strategies
    for (const botId of Array.from(this.activeStrategies.keys())) {
      await this.pauseBot(botId);
      pausedBots++;
    }

    // Cancel all open orders across paper and live
    const allOpenOrders = this.db.prepare("SELECT * FROM orders WHERE status = 'open'").all() as any[];
    for (const ord of allOpenOrders) {
      const acc = this.db.prepare("SELECT * FROM exchange_accounts WHERE id = ?").get(ord.exchange_account_id) as any;
      if (acc) {
        await this.exchangeManager.cancelOrder(ord, acc);
        canceledOrders++;
      }
    }

    this.db.prepare(`
      INSERT INTO system_logs (level, message, metadata_json, timestamp)
      VALUES ('warn', 'EMERGENCY PANIC KILL SWITCH EXECUTED', ?, ?)
    `).run(JSON.stringify({ canceledOrders, pausedBots }), new Date().toISOString());

    this.emit("panic", { active: true, canceledOrders, pausedBots });
    return { canceledOrders, pausedBots };
  }

  private async tickLoop(): Promise<void> {
    for (const symbol of this.activeSymbols) {
      try {
        const ticker = await this.exchangeManager.fetchTicker(symbol);
        this.emit("ticker", ticker);

        // Match paper orders against this fresh ticker
        const trades = this.exchangeManager.getPaperEngine().matchOrdersAgainstTicker(ticker);
        for (const trd of trades) {
          this.emit("trade", trd);
        }

        // Notify active strategies for this symbol
        for (const [botId, strategy] of this.activeStrategies.entries()) {
          const bot = this.db.prepare("SELECT symbol FROM trading_bots WHERE id = ?").get(botId) as any;
          if (bot && bot.symbol === symbol) {
            await strategy.onTick(ticker);
          }
        }
      } catch (err: any) {
        // Ticker fetch error (e.g. temporary network blip)
      }
    }
  }

  private async candleLoop(): Promise<void> {
    this.checkDailyDrawdownCircuitBreaker();
    for (const symbol of this.activeSymbols) {
      try {
        const candles = await this.exchangeManager.fetchOHLCV(symbol, "5m", 50);
        for (const [botId, strategy] of this.activeStrategies.entries()) {
          const bot = this.db.prepare("SELECT symbol FROM trading_bots WHERE id = ?").get(botId) as any;
          if (bot && bot.symbol === symbol) {
            await strategy.onCandle(candles);
          }
        }
      } catch (err: any) {}
    }
  }

  public checkDailyDrawdownCircuitBreaker(): { tripped: boolean; dailyPnl: number; maxDailyLossUsd: number } {
    try {
      const maxLossRow = this.db.prepare("SELECT value FROM system_settings WHERE key = 'max_daily_loss_usd'").get() as { value: string } | undefined;
      const trippedRow = this.db.prepare("SELECT value FROM system_settings WHERE key = 'circuit_breaker_tripped'").get() as { value: string } | undefined;
      const maxDailyLossUsd = Math.abs(Number(maxLossRow?.value || 1000));
      const alreadyTripped = trippedRow?.value === "true";

      const pnlRow = this.db.prepare(`
        SELECT COALESCE(SUM(realized_pnl), 0) as dailyPnl
        FROM trades
        WHERE timestamp >= datetime('now', '-24 hours')
      `).get() as { dailyPnl: number };
      const dailyPnl = Number((pnlRow?.dailyPnl || 0).toFixed(4));

      if (maxDailyLossUsd > 0 && dailyPnl <= -maxDailyLossUsd && !alreadyTripped) {
        this.db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('circuit_breaker_tripped', 'true')").run();
        this.db.prepare(`
          INSERT INTO system_logs (level, message, metadata_json, timestamp)
          VALUES ('warn', ?, ?, ?)
        `).run(
          `🛑 GLOBAL CIRCUIT BREAKER TRIPPED! 24h Realized PnL ($${dailyPnl.toFixed(2)}) breached -$${maxDailyLossUsd.toFixed(2)} limit. New buys paused.`,
          JSON.stringify({ dailyPnl, maxDailyLossUsd }),
          new Date().toISOString()
        );
        this.emit("circuit_breaker", { tripped: true, dailyPnl, maxDailyLossUsd });
        return { tripped: true, dailyPnl, maxDailyLossUsd };
      }

      return { tripped: alreadyTripped, dailyPnl, maxDailyLossUsd };
    } catch {
      return { tripped: false, dailyPnl: 0, maxDailyLossUsd: 1000 };
    }
  }

  public async retrainMlModels(): Promise<void> {
    const ml = MlPredictor.getInstance();
    for (const symbol of this.activeSymbols) {
      try {
        const candles = await this.exchangeManager.fetchOHLCV(symbol, "1h", 250);
        if (candles && candles.length >= 60) {
          ml.retrain(symbol, candles);
        }
      } catch {}
    }
  }

  private async reconcileLiveOrders(): Promise<void> {
    try {
      const openLiveOrders = this.db.prepare(
        "SELECT * FROM orders WHERE status = 'open' AND is_paper = 0"
      ).all() as any[];

      for (const order of openLiveOrders) {
        if (!order.exchange_order_id) continue;
        const account = this.db.prepare(
          "SELECT * FROM exchange_accounts WHERE id = ?"
        ).get(order.exchange_account_id) as any;
        if (!account) continue;

        try {
          const ex = this.exchangeManager.getAuthenticatedExchange(account);
          if (!ex) continue;
          const exOrder = await ex.fetchOrder(order.exchange_order_id, order.symbol);
          if (exOrder) {
            const status = exOrder.status; // closed, canceled, open, etc.
            if (status === "closed") {
              const filled = exOrder.filled !== undefined && exOrder.filled > 0 ? exOrder.filled : order.amount;
              const avgPrice = exOrder.average || exOrder.price || order.price;
              const cost = exOrder.cost || (filled * avgPrice);
              const fee = (exOrder.fee && exOrder.fee.cost) ? exOrder.fee.cost : 0;
              const now = new Date().toISOString();

              this.db.prepare(`
                UPDATE orders
                SET status = 'filled', filled_amount = ?, cost = ?, fee = ?, updated_at = ?
                WHERE id = ?
              `).run(filled, cost, fee, now, order.id);

              const existingTrade = this.db.prepare(
                "SELECT id FROM trades WHERE order_id = ?"
              ).get(order.id);
              if (!existingTrade) {
                let realizedPnl = 0;
                if (order.side === "sell" && order.bot_id) {
                  const lastSell = this.db.prepare(`
                    SELECT MAX(timestamp) as lastSellTime FROM trades WHERE bot_id = ? AND side = 'sell'
                  `).get(order.bot_id) as { lastSellTime: string | null };

                  const buyStats = lastSell && lastSell.lastSellTime
                    ? (this.db.prepare(`
                        SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
                        FROM trades WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
                      `).get(order.bot_id, lastSell.lastSellTime) as { totalCost: number | null; totalAmount: number | null })
                    : (this.db.prepare(`
                        SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
                        FROM trades WHERE bot_id = ? AND side = 'buy'
                      `).get(order.bot_id) as { totalCost: number | null; totalAmount: number | null });

                  if (buyStats.totalCost && buyStats.totalAmount && buyStats.totalAmount > 0) {
                    const avgBuy = buyStats.totalCost / buyStats.totalAmount;
                    realizedPnl = Number(((avgPrice - avgBuy) * filled - fee).toFixed(4));
                  }

                  const isWin = realizedPnl > 0 ? 1 : 0;
                  this.db.prepare(`
                    UPDATE trading_bots
                    SET realized_pnl = realized_pnl + ?,
                        total_trades = total_trades + 1,
                        winning_trades = winning_trades + ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                  `).run(realizedPnl, isWin, order.bot_id);
                }

                const tradeId = `live-trd-${crypto.randomUUID()}`;
                this.db.prepare(`
                  INSERT INTO trades (
                    id, bot_id, order_id, symbol, side, price, amount, cost, fee, realized_pnl, is_paper, timestamp
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                `).run(tradeId, order.bot_id, order.id, order.symbol, order.side, avgPrice, filled, cost, fee, realizedPnl, now);

                this.emit("trade", { id: tradeId, symbol: order.symbol, side: order.side, price: avgPrice, amount: filled, realized_pnl: realizedPnl });
              }
              console.log(`[OrderReconciliation] Order ${order.exchange_order_id} filled: ${filled} ${order.symbol} @ $${avgPrice}`);
            } else if (status === "canceled" || status === "expired" || status === "rejected") {
              this.db.prepare(`
                UPDATE orders SET status = 'canceled', updated_at = datetime('now') WHERE id = ?
              `).run(order.id);
              console.log(`[OrderReconciliation] Order ${order.exchange_order_id} marked canceled`);
            }
          }
        } catch (err: any) {
          // Order query error or network blip
        }
      }
    } catch (e) {}
  }
}

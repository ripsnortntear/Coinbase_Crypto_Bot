import { TradingBot, TickerData, Candle, Order, ExchangeAccount } from "../types";
import { ExchangeManager } from "../exchange-manager";
import { getDatabase } from "../../db/database";
import { RegimeGuard } from "../regime-guard";
import { MlPredictor } from "../ml-predictor";
import { DailyRotator } from "../daily-rotator";

export abstract class BaseStrategy {
  protected bot: TradingBot;
  protected account: ExchangeAccount;
  protected exchangeManager: ExchangeManager;
  protected db = getDatabase();

  constructor(bot: TradingBot, account: ExchangeAccount, exchangeManager: ExchangeManager) {
    this.bot = bot;
    this.account = account;
    this.exchangeManager = exchangeManager;
  }

  public abstract onTick(ticker: TickerData): Promise<void>;
  public abstract onCandle(candles: Candle[]): Promise<void>;
  public abstract initialize(): Promise<void>;

  protected log(level: "info" | "warn" | "error" | "trade", message: string, metadata: any = {}): void {
    try {
      this.db.prepare(`
        INSERT INTO system_logs (level, bot_id, symbol, message, metadata_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(level, this.bot.id, this.bot.symbol, message, JSON.stringify(metadata), new Date().toISOString());
    } catch (err) {
      console.error(`[Strategy Log Error]`, err);
    }
  }

  protected getOpenOrders(): Order[] {
    return this.db.prepare(`
      SELECT * FROM orders
      WHERE bot_id = ? AND status = 'open'
    `).all(this.bot.id) as unknown as Order[];
  }

  protected canEnterBuy(): { allowed: boolean; reason?: string } {
    try {
      const cb = this.db.prepare("SELECT value FROM system_settings WHERE key = 'circuit_breaker_tripped'").get() as { value: string } | undefined;
      if (cb && cb.value === "true") {
        return { allowed: false, reason: "Global Daily Drawdown Circuit Breaker is TRIPPED" };
      }
      const panic = this.db.prepare("SELECT value FROM system_settings WHERE key = 'panic_active'").get() as { value: string } | undefined;
      if (panic && panic.value === "true") {
        return { allowed: false, reason: "Emergency Panic Stop is ACTIVE" };
      }
      if (DailyRotator.getInstance()?.isPendingRotation(this.bot.id)) {
        return { allowed: false, reason: "Bot is queued for Hyperopt rotation after closing current position" };
      }
    } catch {}

    const guard = RegimeGuard.getInstance();
    if (guard) {
      const res = guard.canOpenNewPosition();
      if (!res.allowed) {
        return { allowed: false, reason: res.reason };
      }
    }

    // Optional Continuous ML Filter
    try {
      const mlRow = this.db.prepare("SELECT value FROM system_settings WHERE key = 'ml_filter_enabled'").get() as { value: string } | undefined;
      if (mlRow && mlRow.value === "true") {
        const pred = MlPredictor.getInstance().predict(this.bot.symbol);
        if (pred.probUp < 0.42) {
          return {
            allowed: false,
            reason: `ML Predictor bearish (${(pred.probUp * 100).toFixed(1)}% up prob, val acc ${pred.accuracy}%)`,
          };
        }
      }
    } catch {}

    return { allowed: true };
  }

  protected async checkExposureCap(): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const row = this.db.prepare("SELECT value FROM system_settings WHERE key = 'max_coin_exposure_pct'").get() as { value: string } | undefined;
      const maxPct = Number(row?.value || 50);
      if (maxPct >= 100 || maxPct <= 0) return { allowed: true };

      const baseAsset = this.bot.symbol.split("/")[0];
      const portfolio = await this.exchangeManager.calculateTotalPortfolioUsd(this.account);
      if (portfolio.totalUsd <= 0) return { allowed: true };

      const assetInfo = portfolio.balances[baseAsset];
      if (!assetInfo || assetInfo.total <= 0) return { allowed: true };

      const ticker = await this.exchangeManager.fetchTicker(this.bot.symbol, this.account.exchange_id);
      const assetUsd = assetInfo.total * (ticker.last || 0);
      const exposurePct = (assetUsd / portfolio.totalUsd) * 100;

      if (exposurePct >= maxPct) {
        return {
          allowed: false,
          reason: `${baseAsset} exposure is ${exposurePct.toFixed(1)}% (cap: ${maxPct}%)`,
        };
      }
    } catch {}
    return { allowed: true };
  }

  protected async placeOrder(
    side: "buy" | "sell",
    type: "limit" | "market",
    price: number,
    amount: number,
    makerFirst = false
  ): Promise<Order> {
    const order = await this.exchangeManager.createOrder(this.account, {
      bot_id: this.bot.id,
      symbol: this.bot.symbol,
      side,
      type,
      price,
      amount,
      makerFirst,
    });

    this.log("trade", `Placed ${side.toUpperCase()} ${order.type.toUpperCase()} order: ${amount} ${this.bot.symbol} @ $${price.toFixed(2)}`, {
      orderId: order.id,
      side,
      type: order.type,
      price,
      amount,
    });

    if (side === "sell" && order.status === "filled") {
      setTimeout(() => {
        DailyRotator.getInstance()?.onBotClosedPosition(this.bot.id).catch(() => {});
      }, 1500);
    }

    return order;
  }

  protected async cancelOrder(order: Order): Promise<boolean> {
    const success = await this.exchangeManager.cancelOrder(order, this.account);
    if (success) {
      this.log("info", `Canceled ${order.side} order #${order.id.slice(0, 8)}`);
    }
    return success;
  }
}

import { TradingBot, TickerData, Candle, Order, ExchangeAccount } from "../types";
import { ExchangeManager } from "../exchange-manager";
import { getDatabase } from "../../db/database";

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

  protected async placeOrder(
    side: "buy" | "sell",
    type: "limit" | "market",
    price: number,
    amount: number
  ): Promise<Order> {
    const order = await this.exchangeManager.createOrder(this.account, {
      bot_id: this.bot.id,
      symbol: this.bot.symbol,
      side,
      type,
      price,
      amount,
    });

    this.log("trade", `Placed ${side.toUpperCase()} ${type.toUpperCase()} order: ${amount} ${this.bot.symbol} @ $${price.toFixed(2)}`, {
      orderId: order.id,
      side,
      type,
      price,
      amount,
    });

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

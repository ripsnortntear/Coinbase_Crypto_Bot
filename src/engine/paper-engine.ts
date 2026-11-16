import crypto from "crypto";
import { getDatabase } from "../db/database";
import { Order, Trade, TickerData } from "./types";

const TAKER_FEE_RATE = 0.001; // 0.1% standard spot fee

export class PaperEngine {
  private db = getDatabase();

  public getBalances(): Record<string, { free: number; used: number; total: number }> {
    const rows = this.db.prepare("SELECT currency, free, used FROM paper_balances").all() as {
      currency: string;
      free: number;
      used: number;
    }[];

    const balances: Record<string, { free: number; used: number; total: number }> = {};
    for (const row of rows) {
      balances[row.currency] = {
        free: row.free,
        used: row.used,
        total: row.free + row.used,
      };
    }
    return balances;
  }

  public resetBalances(initialBalances?: Record<string, number>): void {
    const defaults: Record<string, number> = initialBalances || {
      USDT: 25000.0,
      USD: 10000.0,
      BTC: 0.5,
      ETH: 5.0,
      SOL: 50.0,
    };

    const stmt = this.db.prepare(`
      INSERT INTO paper_balances (currency, free, used, updated_at)
      VALUES (?, ?, 0.0, datetime('now'))
      ON CONFLICT(currency) DO UPDATE SET free = excluded.free, used = 0.0, updated_at = datetime('now')
    `);

    for (const [cur, amt] of Object.entries(defaults)) {
      stmt.run(cur, amt);
    }
  }

  public placeOrder(order: {
    bot_id: string | null;
    exchange_account_id: string;
    symbol: string;
    side: "buy" | "sell";
    type: "limit" | "market";
    price: number;
    amount: number;
  }): Order {
    const [base, quote] = order.symbol.split("/");
    const balances = this.getBalances();
    const orderId = `paper-ord-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    if (order.side === "buy") {
      const requiredQuote = order.price * order.amount;
      const quoteBal = balances[quote]?.free || 0;
      if (quoteBal < requiredQuote) {
        throw new Error(`Insufficient paper ${quote} balance: has ${quoteBal.toFixed(4)}, requires ${requiredQuote.toFixed(4)}`);
      }

      // Reserve quote currency
      this.db.prepare(
        "UPDATE paper_balances SET free = free - ?, used = used + ?, updated_at = datetime('now') WHERE currency = ?"
      ).run(requiredQuote, requiredQuote, quote);
    } else {
      // Sell base currency
      const baseBal = balances[base]?.free || 0;
      if (baseBal < order.amount) {
        throw new Error(`Insufficient paper ${base} balance: has ${baseBal.toFixed(4)}, requires ${order.amount.toFixed(4)}`);
      }

      // Reserve base currency
      this.db.prepare(
        "UPDATE paper_balances SET free = free - ?, used = used + ?, updated_at = datetime('now') WHERE currency = ?"
      ).run(order.amount, order.amount, base);
    }

    const createdOrder: Order = {
      id: orderId,
      bot_id: order.bot_id,
      exchange_account_id: order.exchange_account_id,
      exchange_order_id: `sim-${Date.now()}`,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.amount,
      filled_amount: 0,
      cost: 0,
      fee: 0,
      status: "open",
      is_paper: 1,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO orders (
        id, bot_id, exchange_account_id, exchange_order_id, symbol, side, type,
        price, amount, filled_amount, cost, fee, status, is_paper, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createdOrder.id,
      createdOrder.bot_id,
      createdOrder.exchange_account_id,
      createdOrder.exchange_order_id,
      createdOrder.symbol,
      createdOrder.side,
      createdOrder.type,
      createdOrder.price,
      createdOrder.amount,
      createdOrder.filled_amount,
      createdOrder.cost,
      createdOrder.fee,
      createdOrder.status,
      createdOrder.is_paper,
      createdOrder.created_at,
      createdOrder.updated_at
    );

    return createdOrder;
  }

  public matchOrdersAgainstTicker(ticker: TickerData): Trade[] {
    const openOrders = this.db.prepare(`
      SELECT * FROM orders
      WHERE is_paper = 1 AND status = 'open' AND symbol = ?
    `).all(ticker.symbol) as unknown as Order[];

    const executedTrades: Trade[] = [];

    for (const order of openOrders) {
      let isFilled = false;
      let fillPrice = order.price;

      if (order.type === "market") {
        isFilled = true;
        fillPrice = order.side === "buy" ? ticker.ask || ticker.last : ticker.bid || ticker.last;
      } else if (order.type === "limit") {
        // Buy limit fills when market price drops to or below order price
        if (order.side === "buy" && (ticker.low <= order.price || ticker.last <= order.price)) {
          isFilled = true;
          fillPrice = Math.min(order.price, ticker.last);
        }
        // Sell limit fills when market price rises to or above order price
        else if (order.side === "sell" && (ticker.high >= order.price || ticker.last >= order.price)) {
          isFilled = true;
          fillPrice = Math.max(order.price, ticker.last);
        }
      }

      if (isFilled) {
        const trade = this.executeFill(order, fillPrice);
        if (trade) executedTrades.push(trade);
      }
    }

    return executedTrades;
  }

  private executeFill(order: Order, fillPrice: number): Trade | null {
    const [base, quote] = order.symbol.split("/");
    const cost = fillPrice * order.amount;
    const fee = cost * TAKER_FEE_RATE;
    const tradeId = `paper-trd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    if (order.side === "buy") {
      const reservedQuote = order.price * order.amount;
      const leftoverReserved = Math.max(0, reservedQuote - cost);

      // Release reserved quote, credit purchased base asset, deduct fee from quote
      this.db.prepare(`
        UPDATE paper_balances
        SET used = MAX(0, used - ?),
            free = free + ?,
            updated_at = datetime('now')
        WHERE currency = ?
      `).run(reservedQuote, leftoverReserved, quote);

      this.db.prepare(`
        INSERT INTO paper_balances (currency, free, used, updated_at)
        VALUES (?, ?, 0, datetime('now'))
        ON CONFLICT(currency) DO UPDATE SET free = free + excluded.free, updated_at = datetime('now')
      `).run(base, order.amount);

      // Deduct fee
      this.db.prepare(`
        UPDATE paper_balances
        SET free = MAX(0, free - ?), updated_at = datetime('now')
        WHERE currency = ?
      `).run(fee, quote);
    } else {
      // Sell: Release used base asset, credit quote proceeds minus fee
      this.db.prepare(`
        UPDATE paper_balances
        SET used = MAX(0, used - ?),
            updated_at = datetime('now')
        WHERE currency = ?
      `).run(order.amount, base);

      const netQuote = Math.max(0, cost - fee);
      this.db.prepare(`
        INSERT INTO paper_balances (currency, free, used, updated_at)
        VALUES (?, ?, 0, datetime('now'))
        ON CONFLICT(currency) DO UPDATE SET free = free + excluded.free, updated_at = datetime('now')
      `).run(quote, netQuote);
    }

    // Update order status
    this.db.prepare(`
      UPDATE orders
      SET status = 'filled',
          filled_amount = amount,
          cost = ?,
          fee = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(cost, fee, order.id);

    // Calculate realized PnL if bot is tracking
    let realizedPnl = 0;
    if (order.side === "sell" && order.bot_id) {
      // Find average buy price for the active cycle of this bot
      const lastSell = this.db.prepare(`
        SELECT MAX(timestamp) as lastSellTime
        FROM trades
        WHERE bot_id = ? AND side = 'sell'
      `).get(order.bot_id) as { lastSellTime: string | null };

      const buyStats = lastSell && lastSell.lastSellTime
        ? (this.db.prepare(`
            SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
            FROM trades
            WHERE bot_id = ? AND side = 'buy' AND timestamp > ?
          `).get(order.bot_id, lastSell.lastSellTime) as { totalCost: number | null; totalAmount: number | null })
        : (this.db.prepare(`
            SELECT SUM(cost) as totalCost, SUM(amount) as totalAmount
            FROM trades
            WHERE bot_id = ? AND side = 'buy'
          `).get(order.bot_id) as { totalCost: number | null; totalAmount: number | null });

      if (buyStats.totalCost && buyStats.totalAmount && buyStats.totalAmount > 0) {
        const avgBuy = buyStats.totalCost / buyStats.totalAmount;
        realizedPnl = Number(((fillPrice - avgBuy) * order.amount - fee).toFixed(4));
      }
    }

    // Insert trade record
    const trade: Trade = {
      id: tradeId,
      bot_id: order.bot_id,
      order_id: order.id,
      symbol: order.symbol,
      side: order.side,
      price: fillPrice,
      amount: order.amount,
      cost,
      fee,
      realized_pnl: realizedPnl,
      is_paper: 1,
      timestamp: now,
    };

    this.db.prepare(`
      INSERT INTO trades (
        id, bot_id, order_id, symbol, side, price, amount, cost, fee, realized_pnl, is_paper, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id,
      trade.bot_id,
      trade.order_id,
      trade.symbol,
      trade.side,
      trade.price,
      trade.amount,
      trade.cost,
      trade.fee,
      trade.realized_pnl,
      trade.is_paper,
      trade.timestamp
    );

    // Update bot metrics on completed sell round-trip
    if (order.side === "sell" && order.bot_id) {
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

    return trade;
  }

  public cancelOrder(orderId: string): Order | null {
    const order = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as Order | undefined;
    if (!order || order.status !== "open") return null;

    const [base, quote] = order.symbol.split("/");

    if (order.side === "buy") {
      const reservedQuote = order.price * order.amount;
      this.db.prepare(`
        UPDATE paper_balances
        SET free = free + ?, used = MAX(0, used - ?), updated_at = datetime('now')
        WHERE currency = ?
      `).run(reservedQuote, reservedQuote, quote);
    } else {
      this.db.prepare(`
        UPDATE paper_balances
        SET free = free + ?, used = MAX(0, used - ?), updated_at = datetime('now')
        WHERE currency = ?
      `).run(order.amount, order.amount, base);
    }

    this.db.prepare(`
      UPDATE orders
      SET status = 'canceled', updated_at = datetime('now')
      WHERE id = ?
    `).run(orderId);

    order.status = "canceled";
    return order;
  }
}

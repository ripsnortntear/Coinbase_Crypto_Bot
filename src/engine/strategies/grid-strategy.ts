import { BaseStrategy } from "./base-strategy";
import { TickerData, Candle, GridConfig, Order } from "../types";

export class GridStrategy extends BaseStrategy {
  private config: GridConfig;
  private gridLevels: number[] = [];
  private isInitialized = false;
  private lastBalanceCheck = 0;

  constructor(bot: any, account: any, exchangeManager: any) {
    super(bot, account, exchangeManager);
    this.config = JSON.parse(bot.config_json || "{}");
  }

  public async initialize(): Promise<void> {
    const { upperPrice, lowerPrice, grids } = this.config;
    if (!upperPrice || !lowerPrice || !grids || grids < 2 || upperPrice <= lowerPrice) {
      this.log("error", "Invalid Grid configuration bounds (requires grids >= 2 and upperPrice > lowerPrice)");
      return;
    }

    try {
      const balances = await this.exchangeManager.fetchBalances(this.account);
      const freeUsd = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);
      this.log("info", `Grid Strategy connected to Coinbase. Detected $${freeUsd.toFixed(2)} USD cash. Auto-capital absorption ACTIVE.`);
    } catch (err: any) {
      console.warn("[GridStrategy] Init balance check notice:", err.message);
    }

    this.rebuildGridLevels();
    this.isInitialized = true;
  }

  private rebuildGridLevels(): void {
    const { upperPrice, lowerPrice, grids } = this.config;
    this.gridLevels = [];
    const step = (upperPrice - lowerPrice) / (grids - 1);
    for (let i = 0; i < grids; i++) {
      this.gridLevels.push(Number((lowerPrice + i * step).toFixed(2)));
    }
    this.log("info", `Grid Strategy active with ${grids} levels [$${lowerPrice} - $${upperPrice}], step: $${step.toFixed(2)}`);
  }

  public async onTick(ticker: TickerData): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 1. Auto-Capital Absorption Engine (ACAE): Sync live Coinbase balance every 15s
    await this.syncLiveCapital(ticker.last);

    // 2. Stop Loss Check
    if (this.config.stopLossPrice && ticker.last <= this.config.stopLossPrice) {
      this.log("warn", `Stop Loss triggered @ $${ticker.last}. Canceling grid orders.`);
      const openOrders = this.getOpenOrders();
      for (const ord of openOrders) {
        await this.cancelOrder(ord);
      }
      return;
    }

    const openOrders = this.getOpenOrders();
    const openBuyPrices = new Set(openOrders.filter((o) => o.side === "buy").map((o) => o.price.toFixed(2)));
    const openSellPrices = new Set(openOrders.filter((o) => o.side === "sell").map((o) => o.price.toFixed(2)));

    // Allocate order size per grid dynamically based on total absorbed capital
    const capitalPerGrid = this.bot.allocated_capital / this.config.grids;

    for (const level of this.gridLevels) {
      const levelKey = level.toFixed(2);
      const amount = Number((capitalPerGrid / level).toFixed(5));
      if (amount <= 0) continue;

      // Below current price -> buy order
      if (level < ticker.last * 0.998) {
        if (!openBuyPrices.has(levelKey) && openOrders.length < 20) {
          try {
            await this.placeOrder("buy", "limit", level, amount);
            openBuyPrices.add(levelKey);
          } catch (err: any) {
            // Insufficient balance or other error, suppress repetitive logging
            break;
          }
        }
      }
      // Above current price -> sell order
      else if (level > ticker.last * 1.002) {
        if (!openSellPrices.has(levelKey) && openOrders.length < 20) {
          try {
            await this.placeOrder("sell", "limit", level, amount);
            openSellPrices.add(levelKey);
          } catch (err: any) {
            break;
          }
        }
      }
    }
  }

  /**
   * Auto-Capital Absorption Engine (ACAE):
   * Polls Coinbase balance every 15s. Automatically absorbs newly deposited USD / USDC,
   * dynamically adjusts bot allocated capital, and auto-scales grid order amounts.
   */
  private async syncLiveCapital(currentPrice: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < 15000) return;
    this.lastBalanceCheck = now;

    try {
      const balances = await this.exchangeManager.fetchBalances(this.account);
      const freeUsd = Number(balances["USD"]?.free || 0) + Number(balances["USDC"]?.free || 0);

      // Determine base currency for symbol (e.g., ETH from ETH/USD)
      const baseCoin = this.bot.symbol.split("/")[0] || "ETH";
      const coinBal = Number(balances[baseCoin]?.total || 0);
      const positionValue = coinBal * currentPrice;
      const totalAvailable = Number((freeUsd + positionValue).toFixed(2));

      // Auto-scale capital when new deposits appear or balance changes by >= $0.50
      if (totalAvailable >= 1.0 && Math.abs(totalAvailable - this.bot.allocated_capital) >= 0.50) {
        const oldCap = this.bot.allocated_capital;
        this.bot.allocated_capital = totalAvailable;

        this.db.prepare(`
          UPDATE trading_bots
          SET allocated_capital = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(totalAvailable, this.bot.id);

        const newPerGrid = (totalAvailable / this.config.grids).toFixed(2);
        this.log(
          "info",
          `Auto-Capital Absorption (Grid): Synced Coinbase live funds ($${oldCap.toFixed(2)} ➔ $${totalAvailable.toFixed(2)}). Dynamic Grid Allocation: $${newPerGrid} per level.`
        );
      }
    } catch (err: any) {
      console.warn(`[GridStrategy] Balance sync notice: ${err.message}`);
    }
  }

  public async onCandle(_candles: Candle[]): Promise<void> {
    // Grid strategies primarily operate on real-time order book ticks
  }
}

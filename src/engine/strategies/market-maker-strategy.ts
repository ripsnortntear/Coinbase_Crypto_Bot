import { BaseStrategy } from "./base-strategy";
import { TickerData, Candle, MarketMakerConfig } from "../types";

export class MarketMakerStrategy extends BaseStrategy {
  private config: MarketMakerConfig;
  private lastQuotedMid = 0;
  private isQuoting = false;

  constructor(bot: any, account: any, exchangeManager: any) {
    super(bot, account, exchangeManager);
    const raw = JSON.parse(bot.config_json || "{}");
    // Minimum 1.0% total spread (0.5% per side) to beat 0.40% maker fees per side (0.80% round-trip)
    this.config = {
      spreadPct: Math.max(1.0, Number(raw.spreadPct || 1.2)),
      orderAmountUsd: Math.max(5.0, Number(raw.orderAmountUsd || 25)),
      maxInventoryUsd: Math.max(25.0, Number(raw.maxInventoryUsd || 250)),
      refreshTolerancePct: Math.max(0.1, Number(raw.refreshTolerancePct || 0.25)),
    };
  }

  public async initialize(): Promise<void> {
    this.log(
      "info",
      `📊 Continuous Market Maker active for ${this.bot.symbol} | Spread: ${this.config.spreadPct}% | Order: $${this.config.orderAmountUsd} | Max Inventory: $${this.config.maxInventoryUsd}`
    );
  }

  public async onTick(ticker: TickerData): Promise<void> {
    if (this.isQuoting || ticker.last <= 0) return;

    const mid = ticker.bid > 0 && ticker.ask > 0 ? (ticker.bid + ticker.ask) / 2 : ticker.last;
    const movePct = this.lastQuotedMid > 0 ? (Math.abs(mid - this.lastQuotedMid) / this.lastQuotedMid) * 100 : 999;
    const openOrders = this.getOpenOrders();

    // Requote if missing either side or mid-price shifted beyond tolerance
    if (openOrders.length >= 2 && movePct < (this.config.refreshTolerancePct || 0.25)) {
      return;
    }

    this.isQuoting = true;
    try {
      // Cancel stale quotes
      for (const ord of openOrders) {
        await this.cancelOrder(ord);
      }

      // Compute inventory skew so heavy inventory lowers ask/bid slightly to mean-revert
      const baseAsset = this.bot.symbol.split("/")[0];
      const balances = await this.exchangeManager.fetchBalances(this.account);
      const freeBase = Number(balances[baseAsset]?.free || 0);
      const inventoryUsd = freeBase * mid;
      const inventoryRatio = Math.min(1, inventoryUsd / this.config.maxInventoryUsd);
      const skewPct = inventoryRatio * 0.25; // up to 0.25% downward skew when inventory is full

      const halfSpread = this.config.spreadPct / 200;
      const bidPrice = Number((mid * (1 - halfSpread - skewPct / 100)).toFixed(2));
      const askPrice = Number((mid * (1 + halfSpread - skewPct / 100)).toFixed(2));
      const orderQty = Number((this.config.orderAmountUsd / mid).toFixed(5));

      if (orderQty <= 0) return;

      // Place Bid if below max inventory and guards allow
      const guard = this.canEnterBuy();
      if (guard.allowed && inventoryUsd < this.config.maxInventoryUsd) {
        await this.placeOrder("buy", "limit", bidPrice, orderQty);
      }

      // Place Ask if we hold enough base asset
      if (freeBase >= orderQty) {
        await this.placeOrder("sell", "limit", askPrice, orderQty);
      }

      this.lastQuotedMid = mid;
    } catch (err: any) {
      this.log("error", `Market Maker quote error: ${err.message}`);
    } finally {
      this.isQuoting = false;
    }
  }

  public async onCandle(_candles: Candle[]): Promise<void> {}
}

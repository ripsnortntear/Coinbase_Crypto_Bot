import { BaseStrategy } from "./base-strategy";
import { TickerData, Candle, RebalanceConfig } from "../types";

export class RebalanceStrategy extends BaseStrategy {
  private config: RebalanceConfig;
  private lastCheckTime = 0;
  private isRebalancing = false;

  constructor(bot: any, account: any, exchangeManager: any) {
    super(bot, account, exchangeManager);
    const raw = JSON.parse(bot.config_json || "{}");
    this.config = {
      targets: raw.targets && typeof raw.targets === "object"
        ? raw.targets
        : { BTC: 40, ETH: 40, USD: 20 },
      driftThresholdPct: Math.max(1.0, Number(raw.driftThresholdPct || 3.0)),
      checkIntervalMs: Number(raw.checkIntervalMs || 60000),
    };
  }

  public async initialize(): Promise<void> {
    const summary = Object.entries(this.config.targets)
      .map(([k, v]) => `${k}: ${v}%`)
      .join(", ");
    this.log("info", `⚖️ Portfolio Rebalancer active (${summary}, drift trigger: ${this.config.driftThresholdPct}%)`);
  }

  public async onTick(_ticker: TickerData): Promise<void> {
    const now = Date.now();
    if (this.isRebalancing || now - this.lastCheckTime < (this.config.checkIntervalMs || 60000)) {
      return;
    }
    this.lastCheckTime = now;
    this.isRebalancing = true;

    try {
      const portfolio = await this.exchangeManager.calculateTotalPortfolioUsd(this.account);
      if (portfolio.totalUsd < 10) return;

      const assets = Object.keys(this.config.targets).filter((a) => a !== "USD" && a !== "USDC");
      const prices: Record<string, number> = {};
      const currentValues: Record<string, number> = {};

      for (const asset of assets) {
        const bal = portfolio.balances[asset]?.total || 0;
        const sym = `${asset}/USD`;
        try {
          const t = await this.exchangeManager.fetchTicker(sym, this.account.exchange_id);
          prices[asset] = t.last;
          currentValues[asset] = bal * t.last;
        } catch {
          prices[asset] = 0;
          currentValues[asset] = 0;
        }
      }

      // First sell overweight assets to free up USD, then buy underweight assets
      for (const asset of assets) {
        const targetPct = Number(this.config.targets[asset] || 0);
        const curPct = (currentValues[asset] / portfolio.totalUsd) * 100;
        const drift = curPct - targetPct;

        if (drift >= this.config.driftThresholdPct && prices[asset] > 0) {
          const excessUsd = (drift / 100) * portfolio.totalUsd;
          if (excessUsd >= 5.0) {
            const amount = Number((excessUsd / prices[asset]).toFixed(5));
            if (amount > 0) {
              this.log("info", `⚖️ Rebalance SELL ${asset}: ${curPct.toFixed(1)}% vs target ${targetPct}% (+${drift.toFixed(1)}% drift)`);
              await this.exchangeManager.createOrder(this.account, {
                bot_id: this.bot.id,
                symbol: `${asset}/USD`,
                side: "sell",
                type: "market",
                price: prices[asset],
                amount,
                makerFirst: true,
              });
            }
          }
        }
      }

      const guard = this.canEnterBuy();
      if (!guard.allowed) return;

      for (const asset of assets) {
        const targetPct = Number(this.config.targets[asset] || 0);
        const curPct = (currentValues[asset] / portfolio.totalUsd) * 100;
        const drift = targetPct - curPct;

        if (drift >= this.config.driftThresholdPct && prices[asset] > 0) {
          const neededUsd = (drift / 100) * portfolio.totalUsd;
          if (neededUsd >= 5.0) {
            const amount = Number((neededUsd / prices[asset]).toFixed(5));
            if (amount > 0) {
              this.log("info", `⚖️ Rebalance BUY ${asset}: ${curPct.toFixed(1)}% vs target ${targetPct}% (-${drift.toFixed(1)}% drift)`);
              await this.exchangeManager.createOrder(this.account, {
                bot_id: this.bot.id,
                symbol: `${asset}/USD`,
                side: "buy",
                type: "market",
                price: prices[asset],
                amount,
                makerFirst: true,
              });
            }
          }
        }
      }
    } catch (err: any) {
      this.log("error", `Rebalance check error: ${err.message}`);
    } finally {
      this.isRebalancing = false;
    }
  }

  public async onCandle(_candles: Candle[]): Promise<void> {}
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegimeGuard = void 0;
const database_1 = require("../db/database");
class RegimeGuard {
    static instance = null;
    exchangeManager;
    refreshInterval = null;
    snapshot = {
        regime: "NEUTRAL",
        fngValue: 50,
        fngLabel: "Neutral",
        btcChange1hPct: 0,
        btcChange24hPct: 0,
        btcVolatility24hPct: 0,
        allowNewBuys: true,
        reason: "Initializing market regime telemetry...",
        updatedAt: new Date().toISOString(),
    };
    constructor(exchangeManager) {
        this.exchangeManager = exchangeManager;
    }
    static init(exchangeManager) {
        if (!RegimeGuard.instance) {
            RegimeGuard.instance = new RegimeGuard(exchangeManager);
        }
        return RegimeGuard.instance;
    }
    static getInstance() {
        return RegimeGuard.instance;
    }
    start() {
        if (this.refreshInterval)
            return;
        // Initial fetch after 3s so startup stays instant, then every 5 minutes
        setTimeout(() => {
            this.refresh().catch(() => { });
        }, 3000);
        this.refreshInterval = setInterval(() => {
            this.refresh().catch(() => { });
        }, 5 * 60 * 1000);
    }
    stop() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }
    getSnapshot() {
        const enabled = this.isEnabled();
        return {
            ...this.snapshot,
            allowNewBuys: !enabled || this.snapshot.regime !== "CRASH_RISK",
        };
    }
    isEnabled() {
        try {
            const db = (0, database_1.getDatabase)();
            const row = db.prepare("SELECT value FROM system_settings WHERE key = 'regime_guard_enabled'").get();
            return row ? row.value !== "false" : true;
        }
        catch {
            return true;
        }
    }
    canOpenNewPosition() {
        if (!this.isEnabled()) {
            return { allowed: true, regime: this.snapshot.regime, reason: "Regime Guard disabled" };
        }
        if (this.snapshot.regime === "CRASH_RISK") {
            return {
                allowed: false,
                regime: this.snapshot.regime,
                reason: this.snapshot.reason,
            };
        }
        return {
            allowed: true,
            regime: this.snapshot.regime,
            reason: this.snapshot.reason,
        };
    }
    async refresh() {
        let fngValue = this.snapshot.fngValue;
        let fngLabel = this.snapshot.fngLabel;
        // 1. Fetch Free Crypto Fear & Greed Index (alternative.me)
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const res = await fetch("https://api.alternative.me/fng/?limit=1", { signal: controller.signal });
            clearTimeout(timeout);
            if (res.ok) {
                const json = (await res.json());
                const item = json?.data?.[0];
                if (item && item.value !== undefined) {
                    fngValue = Number(item.value);
                    fngLabel = String(item.value_classification || "Neutral");
                }
            }
        }
        catch {
            // Non-fatal: keep last known Fear & Greed reading
        }
        // 2. Fetch BTC/USD 1h Volatility & Trend from ExchangeManager
        let btcChange1hPct = 0;
        let btcChange24hPct = 0;
        let btcVolatility24hPct = 0;
        try {
            const candles = await this.exchangeManager.fetchOHLCV("BTC/USD", "1h", 24);
            if (candles.length >= 2) {
                const latest = candles[candles.length - 1];
                const prev1h = candles[candles.length - 2];
                const first24h = candles[0];
                if (prev1h.close > 0) {
                    btcChange1hPct = Number((((latest.close - prev1h.close) / prev1h.close) * 100).toFixed(2));
                }
                if (first24h.open > 0) {
                    btcChange24hPct = Number((((latest.close - first24h.open) / first24h.open) * 100).toFixed(2));
                }
                let rangeSum = 0;
                for (const c of candles) {
                    if (c.close > 0) {
                        rangeSum += ((c.high - c.low) / c.close) * 100;
                    }
                }
                btcVolatility24hPct = Number((rangeSum / candles.length).toFixed(2));
            }
        }
        catch {
            // Non-fatal
        }
        // 3. Classify Market Regime
        let regime = "NEUTRAL";
        let reason = `Normal conditions (F&G ${fngValue} [${fngLabel}], BTC 1h ${btcChange1hPct >= 0 ? "+" : ""}${btcChange1hPct}%, Vol ${btcVolatility24hPct}%)`;
        if (btcChange1hPct <= -4.5 ||
            btcChange24hPct <= -8.0 ||
            (fngValue <= 15 && btcChange1hPct <= -2.5)) {
            regime = "CRASH_RISK";
            reason = `Crash risk detected: BTC 1h ${btcChange1hPct}%, 24h ${btcChange24hPct}%, F&G ${fngValue} (${fngLabel}). New buy entries paused.`;
        }
        else if (fngValue <= 25 || btcVolatility24hPct >= 3.5 || btcChange1hPct <= -2.0) {
            regime = "CAUTION";
            reason = `Elevated caution: F&G ${fngValue} (${fngLabel}), BTC 1h ${btcChange1hPct}%, 24h range vol ${btcVolatility24hPct}%`;
        }
        else if (fngValue >= 60 && btcChange24hPct >= 1.5) {
            regime = "BULL";
            reason = `Bullish momentum: F&G ${fngValue} (${fngLabel}), BTC 24h +${btcChange24hPct}%`;
        }
        this.snapshot = {
            regime,
            fngValue,
            fngLabel,
            btcChange1hPct,
            btcChange24hPct,
            btcVolatility24hPct,
            allowNewBuys: !this.isEnabled() || regime !== "CRASH_RISK",
            reason,
            updatedAt: new Date().toISOString(),
        };
        return this.snapshot;
    }
}
exports.RegimeGuard = RegimeGuard;

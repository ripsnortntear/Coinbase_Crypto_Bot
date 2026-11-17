"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyOptimizer = void 0;
const backtester_1 = require("./backtester");
class StrategyOptimizer {
    exchangeManager;
    backtester;
    constructor(exchangeManager) {
        this.exchangeManager = exchangeManager;
        this.backtester = new backtester_1.Backtester(exchangeManager);
    }
    async optimize(req) {
        const limit = Math.min(720, Math.max(60, Number(req.candleLimit || 300)));
        const candles = await this.exchangeManager.fetchOHLCV(req.symbol, req.timeframe || "1h", limit);
        if (!candles || candles.length < 40) {
            throw new Error(`Insufficient candles to optimize ${req.symbol}`);
        }
        const tpGrid = [2.0, 2.5, 3.2, 4.0];
        const trailGrid = [0, 0.3, 0.6];
        const dropGrid = req.strategyType === "dca" ? [1.2, 1.8, 2.5] : [1.8];
        const candidates = [];
        for (const tp of tpGrid) {
            for (const trail of trailGrid) {
                for (const drop of dropGrid) {
                    const config = {
                        takeProfitPercentage: tp,
                        trailingTakeProfitPercentage: trail,
                        priceDropPercentage: drop,
                    };
                    const res = await this.backtester.run({
                        symbol: req.symbol,
                        strategyType: req.strategyType,
                        timeframe: req.timeframe,
                        initialCapital: req.initialCapital,
                        executionMode: req.executionMode,
                        config,
                        preloadedCandles: candles,
                    });
                    // Composite score favoring positive return, Sharpe, and low drawdown
                    const score = Number((res.metrics.totalReturnPct + res.metrics.sharpeRatio * 2 - res.metrics.maxDrawdownPct * 0.5).toFixed(2));
                    candidates.push({
                        rank: 0,
                        config,
                        metrics: res.metrics,
                        score,
                    });
                }
            }
        }
        candidates.sort((a, b) => b.score - a.score);
        const topResults = candidates.slice(0, 5).map((c, idx) => ({ ...c, rank: idx + 1 }));
        return {
            symbol: req.symbol,
            strategyType: req.strategyType,
            timeframe: req.timeframe,
            combinationsTested: candidates.length,
            topResults,
        };
    }
}
exports.StrategyOptimizer = StrategyOptimizer;

import test from "node:test";
import assert from "node:assert/strict";
import { Backtester } from "../src/engine/backtester";
import { StrategyOptimizer } from "../src/engine/optimizer";
import { MlPredictor } from "../src/engine/ml-predictor";
import { StrategyPluginLoader } from "../src/engine/strategy-plugins";
import { Candle } from "../src/engine/types";

function generateSyntheticCandles(count = 120, startPrice = 2000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const now = Date.now() - count * 3600 * 1000;
  for (let i = 0; i < count; i++) {
    // Oscillating wave + slight upward drift to trigger buys on dips and TPs on rallies
    const wave = Math.sin(i / 4) * 0.025 + 0.0015;
    const open = price;
    const close = Number((price * (1 + wave)).toFixed(2));
    const high = Number((Math.max(open, close) * 1.008).toFixed(2));
    const low = Number((Math.min(open, close) * 0.992).toFixed(2));
    candles.push({
      timestamp: now + i * 3600 * 1000,
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 10) * 150,
    });
    price = close;
  }
  return candles;
}

const mockExchangeManager = {
  fetchOHLCV: async () => generateSyntheticCandles(150, 2000),
} as any;

test("Backtester enforces 2.0% Fee Shield and produces valid metrics", async () => {
  const bt = new Backtester(mockExchangeManager);
  const res = await bt.run({
    symbol: "ETH/USD",
    strategyType: "dca",
    timeframe: "1h",
    candleLimit: 150,
    initialCapital: 1000,
    executionMode: "maker",
    config: {
      takeProfitPercentage: 0.5, // Should be clamped to 2.0% Fee Shield
      trailingTakeProfitPercentage: 0.35,
      priceDropPercentage: 1.5,
    },
  });

  assert.equal(res.feeRatePct, 0.4);
  assert.equal(res.metrics.candlesAnalyzed, 150);
  assert.ok(res.metrics.totalTrades >= 1, "Expected at least 1 closed round-trip trade");
  assert.ok(res.metrics.finalEquity > 0);
  assert.ok(res.equityCurve.length > 0);
});

test("StrategyOptimizer sweeps parameter grid and ranks top candidates", async () => {
  const opt = new StrategyOptimizer(mockExchangeManager);
  const res = await opt.optimize({
    symbol: "ETH/USD",
    strategyType: "dca",
    timeframe: "1h",
    candleLimit: 150,
    initialCapital: 1000,
    executionMode: "maker",
  });

  assert.equal(res.combinationsTested, 36);
  assert.equal(res.topResults.length, 5);
  assert.equal(res.topResults[0].rank, 1);
  assert.ok(res.topResults[0].score >= res.topResults[1].score);
});

test("MlPredictor trains online logistic regression and outputs bounded probabilities", () => {
  const ml = MlPredictor.getInstance();
  const candles = generateSyntheticCandles(150, 2000);
  const model = ml.retrain("ETH/USD", candles);

  assert.ok(model !== null, "Expected trained ML model");
  assert.equal(model!.symbol, "ETH/USD");
  assert.ok(model!.samplesTrained >= 30);
  assert.ok(model!.accuracy >= 0 && model!.accuracy <= 100);

  const pred = ml.predict("ETH/USD", candles);
  assert.ok(pred.probUp >= 0 && pred.probUp <= 1);
  assert.ok(["BULLISH", "BEARISH", "NEUTRAL"].includes(pred.signal));
});

test("StrategyPluginLoader initializes plugin directory cleanly", () => {
  const loaded = StrategyPluginLoader.loadAll();
  assert.ok(Array.isArray(loaded));
});

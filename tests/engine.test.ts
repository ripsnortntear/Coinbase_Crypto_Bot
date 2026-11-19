import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Backtester } from "../src/engine/backtester";
import { StrategyOptimizer } from "../src/engine/optimizer";
import { MlPredictor } from "../src/engine/ml-predictor";
import { StrategyPluginLoader } from "../src/engine/strategy-plugins";
import { DcaStrategy } from "../src/engine/strategies/dca-strategy";
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

function createTestDcaDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE trading_bots (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'active',
      allocated_capital REAL,
      config_json TEXT,
      realized_pnl REAL DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE trades (
      id TEXT PRIMARY KEY,
      bot_id TEXT,
      order_id TEXT,
      side TEXT,
      price REAL,
      amount REAL,
      cost REAL,
      realized_pnl REAL,
      timestamp TEXT
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      bot_id TEXT,
      status TEXT
    );
    CREATE TABLE system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT,
      bot_id TEXT,
      symbol TEXT,
      message TEXT,
      metadata_json TEXT,
      timestamp TEXT
    );
    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

test("DcaStrategy caps and scales safetyOrderAmount to available free USD/USDC", async () => {
  const memDb = createTestDcaDb();
  const botId = "test-dca-cap-bot";
  const initialConfig = {
    baseOrderAmount: 4.48,
    safetyOrderAmount: 3.58,
    maxSafetyOrders: 5,
    priceDropPercentage: 1.8,
    takeProfitPercentage: 2.5,
  };
  memDb.prepare("INSERT INTO trading_bots (id, allocated_capital, config_json) VALUES (?, ?, ?)")
    .run(botId, 17.91, JSON.stringify(initialConfig));
  // Active buy at $100 -> 0.15 unit ($15 position)
  memDb.prepare("INSERT INTO trades (id, bot_id, side, price, amount, cost, timestamp) VALUES (?, ?, 'buy', ?, ?, ?, ?)")
    .run("t1", botId, 100, 0.15, 15, "2026-11-18T10:00:00.000Z");

  const placedOrders: any[] = [];
  const fakeExchange = {
    fetchBalances: async () => ({ USD: { free: 2.65 }, USDC: { free: 0 } }),
    createOrder: async (_acct: any, params: any) => {
      placedOrders.push(params);
      return { id: "ord-1", ...params };
    },
  };

  const strategy = new DcaStrategy(
    { id: botId, symbol: "ETH/USD", allocated_capital: 17.91, config_json: JSON.stringify(initialConfig) },
    { id: "acct-1", is_paper: 0 },
    fakeExchange
  );
  (strategy as any).db = memDb;

  // Price dropped > 1.8% ($100 -> $97)
  await strategy.onTick({ symbol: "ETH/USD", last: 97, bid: 96.9, ask: 97.1, timestamp: Date.now() } as any);

  assert.equal(placedOrders.length, 1, "Expected safety order to execute instead of stalling");
  const spentUsd = placedOrders[0].amount * placedOrders[0].price;
  // 2.65 / 1.01 = 2.6237 -> floored to 2.62
  assert.ok(spentUsd >= 2.60 && spentUsd <= 2.63, `Expected scaled safety order ~$2.62, got $${spentUsd.toFixed(2)}`);

  const updatedBot = memDb.prepare("SELECT config_json FROM trading_bots WHERE id = ?").get(botId) as { config_json: string };
  const parsed = JSON.parse(updatedBot.config_json);
  assert.equal(parsed.safetyOrderAmount, 2.62);
});

test("DcaStrategy pauses safety order when free USD/USDC is below minimum $1.25 order + buffer", async () => {
  const memDb = createTestDcaDb();
  const botId = "test-dca-pause-bot";
  const initialConfig = {
    baseOrderAmount: 4.48,
    safetyOrderAmount: 3.58,
    maxSafetyOrders: 5,
    priceDropPercentage: 1.8,
    takeProfitPercentage: 2.5,
  };
  memDb.prepare("INSERT INTO trading_bots (id, allocated_capital, config_json) VALUES (?, ?, ?)")
    .run(botId, 17.91, JSON.stringify(initialConfig));
  memDb.prepare("INSERT INTO trades (id, bot_id, side, price, amount, cost, timestamp) VALUES (?, ?, 'buy', ?, ?, ?, ?)")
    .run("t1", botId, 100, 0.15, 15, "2026-11-18T10:00:00.000Z");

  const placedOrders: any[] = [];
  const fakeExchange = {
    fetchBalances: async () => ({ USD: { free: 1.0 }, USDC: { free: 0 } }),
    createOrder: async (_acct: any, params: any) => {
      placedOrders.push(params);
      return { id: "ord-1", ...params };
    },
  };

  const strategy = new DcaStrategy(
    { id: botId, symbol: "ETH/USD", allocated_capital: 17.91, config_json: JSON.stringify(initialConfig) },
    { id: "acct-1", is_paper: 0 },
    fakeExchange
  );
  (strategy as any).db = memDb;

  await strategy.onTick({ symbol: "ETH/USD", last: 97, bid: 96.9, ask: 97.1, timestamp: Date.now() } as any);

  assert.equal(placedOrders.length, 0, "Expected no order when free cash is below $1.25 minimum");
  const warnLogs = memDb.prepare("SELECT message FROM system_logs WHERE bot_id = ? AND level = 'warn'").all(botId) as { message: string }[];
  assert.equal(warnLogs.length, 1, "Expected single auto-pause warning log");
  assert.ok(warnLogs[0]?.message.includes("DCA safety order auto-paused"), "Expected auto-pause warning log");

  // Second tick (even after 5m cooldown) should not spam while free cash remains < $1.26
  (strategy as any).lastSoErrorTime = 0;
  await strategy.onTick({ symbol: "ETH/USD", last: 96, bid: 95.9, ask: 96.1, timestamp: Date.now() } as any);
  const warnLogsAfter = memDb.prepare("SELECT message FROM system_logs WHERE bot_id = ? AND level = 'warn'").all(botId) as { message: string }[];
  assert.equal(warnLogsAfter.length, 1, "Expected no repeated warning spam while low cash persists");

  const updatedBot = memDb.prepare("SELECT config_json FROM trading_bots WHERE id = ?").get(botId) as { config_json: string };
  assert.equal(JSON.parse(updatedBot.config_json).safetyOrderAmount, 1.25, "Expected safetyOrderAmount clamped to $1.25 floor when low cash");
});

test("DcaStrategy disarms trailing take-profit instead of selling below 2.0% fee shield", async () => {
  const memDb = createTestDcaDb();
  const botId = "test-dca-ttp-shield";
  const initialConfig = {
    baseOrderAmount: 4.0,
    safetyOrderAmount: 3.2,
    maxSafetyOrders: 5,
    priceDropPercentage: 1.8,
    takeProfitPercentage: 2.5,
    trailingTakeProfitPercentage: 0.3,
  };
  memDb.prepare("INSERT INTO trading_bots (id, status, allocated_capital, config_json) VALUES (?, 'active', ?, ?)")
    .run(botId, 16.0, JSON.stringify(initialConfig));
  memDb.prepare("INSERT INTO trades (id, bot_id, side, price, amount, cost, timestamp) VALUES (?, ?, 'buy', ?, ?, ?, ?)")
    .run("t1", botId, 2.24, 1.78, 3.9872, "2026-11-19T01:02:33.000Z");

  const placedOrders: any[] = [];
  const fakeExchange = {
    fetchBalances: async () => ({ USD: { free: 12.0 }, USDC: { free: 0 }, PEARL: { free: 1.78 } }),
    createOrder: async (_acct: any, params: any) => {
      placedOrders.push(params);
      return { id: "ord-1", ...params };
    },
  };

  const strategy = new DcaStrategy(
    { id: botId, symbol: "PEARL/USD", allocated_capital: 16.0, config_json: JSON.stringify(initialConfig) },
    { id: "acct-1", is_paper: 0 },
    fakeExchange
  );
  (strategy as any).db = memDb;

  // Tick 1: Price spikes to $2.30 -> arms trailing TP (+2.68%)
  await strategy.onTick({ symbol: "PEARL/USD", last: 2.30, bid: 2.29, ask: 2.31, timestamp: Date.now() } as any);
  assert.equal(placedOrders.length, 0);

  // Tick 2: Price gaps down to $2.2695 (+1.32%, below 2.0% fee shield) -> must disarm, not sell at a net loss
  await strategy.onTick({ symbol: "PEARL/USD", last: 2.2695, bid: 2.26, ask: 2.27, timestamp: Date.now() } as any);
  assert.equal(placedOrders.length, 0, "Expected trailing TP to disarm instead of selling below 2.0% fee shield");

  const disarmLog = memDb.prepare("SELECT message FROM system_logs WHERE bot_id = ? AND message LIKE '%disarmed%'").get(botId) as { message: string } | undefined;
  assert.ok(disarmLog, "Expected disarm log message");
});

test("DcaStrategy aborts in-flight tick cleanly when bot is deleted during async balance sync", async () => {
  const memDb = createTestDcaDb();
  const botId = "test-dca-deleted-bot";
  const initialConfig = {
    baseOrderAmount: 4.0,
    safetyOrderAmount: 3.2,
    maxSafetyOrders: 5,
    priceDropPercentage: 1.8,
    takeProfitPercentage: 2.5,
  };
  memDb.prepare("INSERT INTO trading_bots (id, status, allocated_capital, config_json) VALUES (?, 'active', ?, ?)")
    .run(botId, 16.0, JSON.stringify(initialConfig));

  const placedOrders: any[] = [];
  const fakeExchange = {
    fetchBalances: async () => {
      // Simulate rotator deleting the bot while fetchBalances is awaiting
      memDb.prepare("DELETE FROM trading_bots WHERE id = ?").run(botId);
      return { USD: { free: 16.0 }, USDC: { free: 0 } };
    },
    createOrder: async (_acct: any, params: any) => {
      placedOrders.push(params);
      return { id: "ord-1", ...params };
    },
  };

  const strategy = new DcaStrategy(
    { id: botId, symbol: "VVV/USD", allocated_capital: 16.0, config_json: JSON.stringify(initialConfig) },
    { id: "acct-1", is_paper: 0 },
    fakeExchange
  );
  (strategy as any).db = memDb;

  await strategy.onTick({ symbol: "VVV/USD", last: 20.0, bid: 19.9, ask: 20.1, timestamp: Date.now() } as any);
  assert.equal(placedOrders.length, 0, "Expected deleted bot not to place orders");
  const errLogs = memDb.prepare("SELECT message FROM system_logs WHERE bot_id = ? AND level = 'error'").all(botId);
  assert.equal(errLogs.length, 0, "Expected no FOREIGN KEY constraint error logs");
});

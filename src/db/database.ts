import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../config";

let dbInstance: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    if (!fs.existsSync(CONFIG.dataDir)) {
      fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    }

    dbInstance = new DatabaseSync(CONFIG.dbFile);
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA synchronous = NORMAL;");
    dbInstance.exec("PRAGMA foreign_keys = ON;");

    initSchema(dbInstance);
  }
  return dbInstance;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchange_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      api_key_encrypted TEXT DEFAULT '',
      api_secret_encrypted TEXT DEFAULT '',
      passphrase_encrypted TEXT DEFAULT '',
      is_paper INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trading_bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exchange_account_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      config_json TEXT NOT NULL DEFAULT '{}',
      allocated_capital REAL NOT NULL DEFAULT 1000.0,
      realized_pnl REAL NOT NULL DEFAULT 0.0,
      unrealized_pnl REAL NOT NULL DEFAULT 0.0,
      total_trades INTEGER NOT NULL DEFAULT 0,
      winning_trades INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      bot_id TEXT,
      exchange_account_id TEXT NOT NULL,
      exchange_order_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      filled_amount REAL NOT NULL DEFAULT 0.0,
      cost REAL NOT NULL DEFAULT 0.0,
      fee REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL,
      error_message TEXT,
      is_paper INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL,
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      bot_id TEXT,
      order_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      cost REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0.0,
      realized_pnl REAL NOT NULL DEFAULT 0.0,
      is_paper INTEGER NOT NULL DEFAULT 1,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      bot_id TEXT,
      symbol TEXT,
      message TEXT NOT NULL,
      metadata_json TEXT DEFAULT '{}',
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_balances (
      currency TEXT PRIMARY KEY,
      free REAL NOT NULL,
      used REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Permanently purge any paper simulation accounts, balances, and orders
  try {
    db.prepare("DELETE FROM exchange_accounts WHERE is_paper = 1 OR id LIKE 'paper-%'").run();
    db.prepare("DELETE FROM paper_balances").run();
    db.prepare("DELETE FROM orders WHERE is_paper = 1").run();
    db.prepare("DELETE FROM trades WHERE is_paper = 1").run();
  } catch (err) {}

  // Initialize default settings
  const defaultSettings: [string, string][] = [
    ["panic_active", "false"],
    ["max_daily_loss_usd", "1000"],
    ["max_open_orders_per_bot", "20"],
    ["circuit_breaker_tripped", "false"],
    ["regime_guard_enabled", "true"],
    ["maker_first_enabled", "true"],
  ];
  const insertSetting = db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)");
  for (const [k, v] of defaultSettings) {
    insertSetting.run(k, v);
  }
}

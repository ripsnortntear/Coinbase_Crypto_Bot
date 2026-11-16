#!/usr/bin/env node
/**
 * Coinbase Crypto Bot - Database & Initial Account Bootstrapper
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// Load .env
const envFile = process.env.ENV_FILE || path.resolve(__dirname, "../.env");
if (fs.existsSync(envFile)) {
  require("dotenv").config({ path: envFile });
}

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbFile = path.join(dataDir, "trading.db");
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exchange_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    exchange_id TEXT NOT NULL,
    api_key_encrypted TEXT DEFAULT '',
    api_secret_encrypted TEXT DEFAULT '',
    passphrase_encrypted TEXT DEFAULT '',
    is_paper INTEGER NOT NULL DEFAULT 0,
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
    allocated_capital REAL NOT NULL DEFAULT 100.0,
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
    is_paper INTEGER NOT NULL DEFAULT 0,
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
    is_paper INTEGER NOT NULL DEFAULT 0,
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

// System settings
const checkSettings = db.prepare("SELECT COUNT(*) as count FROM system_settings WHERE key = 'panic_active'").get();
if (checkSettings.count === 0) {
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('panic_active', 'false')").run();
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('max_daily_loss_usd', '1000')").run();
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('max_open_orders_per_bot', '20')").run();
}

// 1. Setup Admin User
const adminUser = process.env.ADMIN_USER || "admin";
const adminPass = process.env.ADMIN_PASS || "admin123";
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(adminPass, salt, 64).toString("hex");
const adminId = `usr-${crypto.randomUUID()}`;

db.prepare(`
  INSERT INTO admin_users (id, username, password_hash, salt, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, salt = excluded.salt, updated_at = datetime('now')
`).run(adminId, adminUser.trim(), hash, salt);

console.log(`[✓] Admin user "${adminUser.trim()}" initialized.`);

// 2. Encryption Helper
const encryptionKeyHex = process.env.ENCRYPTION_KEY;
if (!encryptionKeyHex) {
  console.error("[!] Warning: ENCRYPTION_KEY missing in environment.");
  process.exit(1);
}

const KEY_BUFFER = Buffer.from(encryptionKeyHex, "hex");
function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY_BUFFER, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

// 3. Connect Coinbase Account & Initial DCA Bot if provided
const apiKey = process.env.COINBASE_API_KEY || "";
const apiSecret = process.env.COINBASE_API_SECRET || "";

if (apiKey && apiSecret) {
  const encKey = encrypt(apiKey);
  const encSecret = encrypt(apiSecret);
  const accountId = `cb-acc-${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO exchange_accounts (
      id, name, exchange_id, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, is_paper, is_active
    ) VALUES (?, 'Coinbase Primary', 'coinbase', ?, ?, '', 0, 1)
  `).run(accountId, encKey, encSecret);

  console.log("[✓] Coinbase live exchange account connected and encrypted with AES-256-GCM.");

  // Deploy Initial Fee-Shielded DCA Bot
  const symbol = (process.env.COINBASE_SYMBOL || "ETH/USD").toUpperCase();
  const capital = parseFloat(process.env.COINBASE_CAPITAL || "25.0");
  const baseOrder = Math.max(1.25, Number((capital * 0.25).toFixed(2)));
  const safetyOrder = Math.max(1.25, Number((capital * 0.20).toFixed(2)));

  const botConfig = {
    baseOrderAmount: baseOrder,
    safetyOrderAmount: safetyOrder,
    maxSafetyOrders: 5,
    priceDropPercentage: 1.8,
    takeProfitPercentage: 2.5,
  };

  const botId = `bot-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO trading_bots (
      id, name, exchange_account_id, symbol, strategy_type, status,
      config_json, allocated_capital, realized_pnl, unrealized_pnl, total_trades, winning_trades
    ) VALUES (?, ?, ?, ?, 'dca', 'active', ?, ?, 0.0, 0.0, 0, 0)
  `).run(
    botId,
    `Coinbase ${symbol.split("/")[0]} DCA Bot`,
    accountId,
    symbol,
    JSON.stringify(botConfig),
    capital
  );

  console.log(`[✓] Initial DCA Bot deployed and activated:`);
  console.log(`    - Name: Coinbase ${symbol.split("/")[0]} DCA Bot`);
  console.log(`    - Symbol: ${symbol}`);
  console.log(`    - Capital: $${capital.toFixed(2)}`);
  console.log(`    - Take Profit: 2.5% (Fee Shield Active)`);
  console.log(`    - Price Drop Step: 1.8%`);
  console.log(`    - Base Order: $${baseOrder.toFixed(2)} (25%)`);
  console.log(`    - Safety Order: $${safetyOrder.toFixed(2)} (20%)`);
}

console.log("[✓] Database bootstrap complete!");

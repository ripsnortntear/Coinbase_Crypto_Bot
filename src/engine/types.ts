export type StrategyType = "grid" | "dca" | "momentum_rsi" | "bollinger" | "manual";
export type BotStatus = "active" | "paused" | "stopped";
export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market";
export type OrderStatus = "open" | "filled" | "canceled" | "rejected";

export interface ExchangeAccount {
  id: string;
  name: string;
  exchange_id: string;
  api_key_encrypted?: string;
  api_secret_encrypted?: string;
  passphrase_encrypted?: string;
  is_paper: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface GridConfig {
  upperPrice: number;
  lowerPrice: number;
  grids: number;
  gridType: "arithmetic" | "geometric";
  takeProfitRatio?: number;
  stopLossPrice?: number;
}

export interface DcaConfig {
  baseOrderAmount: number;
  safetyOrderAmount: number;
  maxSafetyOrders: number;
  priceDropPercentage: number;
  takeProfitPercentage: number;
  trailingTakeProfitPercentage?: number;
  stopLossPercentage?: number;
}

export interface MomentumRsiConfig {
  rsiPeriod: number;
  rsiOversold: number; // e.g. 30 -> buy signal
  rsiOverbought: number; // e.g. 70 -> sell signal
  timeframe: string; // "1m", "5m", "15m", "1h"
  orderAmount: number;
  takeProfitPercentage: number;
  stopLossPercentage: number;
}

export interface BollingerConfig {
  period: number; // 20
  stdDev: number; // 2
  timeframe: string; // "5m"
  orderAmount: number;
  takeProfitPercentage: number;
  stopLossPercentage: number;
}

export type BotConfig = GridConfig | DcaConfig | MomentumRsiConfig | BollingerConfig | Record<string, any>;

export interface TradingBot {
  id: string;
  name: string;
  exchange_account_id: string;
  symbol: string;
  strategy_type: StrategyType;
  status: BotStatus;
  config_json: string;
  allocated_capital: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_trades: number;
  winning_trades: number;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  bot_id: string | null;
  exchange_account_id: string;
  exchange_order_id: string | null;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  amount: number;
  filled_amount: number;
  cost: number;
  fee: number;
  status: OrderStatus;
  error_message?: string | null;
  is_paper: number;
  created_at: string;
  updated_at: string;
}

export interface Trade {
  id: string;
  bot_id: string | null;
  order_id: string | null;
  symbol: string;
  side: OrderSide;
  price: number;
  amount: number;
  cost: number;
  fee: number;
  realized_pnl: number;
  is_paper: number;
  timestamp: string;
}

export interface TickerData {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  high: number;
  low: number;
  volume: number;
  change: number;
  percentage: number;
  timestamp: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExchangeManager = void 0;
const ccxt_1 = __importDefault(require("ccxt"));
const database_1 = require("../db/database");
const encryption_1 = require("../security/encryption");
const paper_engine_1 = require("./paper-engine");
class ExchangeManager {
    instances = new Map();
    publicInstances = new Map();
    paperEngine;
    tickerCache = new Map();
    ohlcvCache = new Map();
    balanceCache = new Map();
    constructor() {
        this.paperEngine = new paper_engine_1.PaperEngine();
    }
    getPaperEngine() {
        return this.paperEngine;
    }
    getPublicExchange(exchangeId) {
        const id = exchangeId.toLowerCase();
        if (!this.publicInstances.has(id)) {
            if (!(id in ccxt_1.default)) {
                throw new Error(`Unsupported exchange: ${exchangeId}`);
            }
            // @ts-ignore
            const ex = new ccxt_1.default[id]({
                enableRateLimit: true,
                timeout: 10000,
            });
            this.publicInstances.set(id, ex);
        }
        return this.publicInstances.get(id);
    }
    getAuthenticatedExchange(account) {
        if (account.is_paper === 1) {
            return null; // Paper accounts don't need live exchange auth
        }
        if (this.instances.has(account.id)) {
            return this.instances.get(account.id);
        }
        const exId = account.exchange_id.toLowerCase();
        if (!(exId in ccxt_1.default)) {
            throw new Error(`Unsupported exchange: ${account.exchange_id}`);
        }
        const apiKey = account.api_key_encrypted ? (0, encryption_1.decrypt)(account.api_key_encrypted) : "";
        const apiSecret = account.api_secret_encrypted ? (0, encryption_1.decrypt)(account.api_secret_encrypted) : "";
        const password = account.passphrase_encrypted ? (0, encryption_1.decrypt)(account.passphrase_encrypted) : undefined;
        // @ts-ignore
        const ex = new ccxt_1.default[exId]({
            apiKey,
            secret: apiSecret,
            password,
            enableRateLimit: true,
            timeout: 15000,
        });
        this.instances.set(account.id, ex);
        return ex;
    }
    async fetchTicker(symbol, exchangeId) {
        const isUsdPair = symbol.endsWith("/USD");
        const preferredExchange = exchangeId || (isUsdPair ? "coinbase" : "kraken");
        const cacheKey = `${preferredExchange}:${symbol}`;
        const cached = this.tickerCache.get(cacheKey);
        const now = Date.now();
        // Cache tickers for 2000ms to stay within rate limits and ensure snappy response
        if (cached && now - cached.timestamp < 2000) {
            return cached.ticker;
        }
        const defaultOrder = isUsdPair
            ? ["coinbase", "kraken", "binanceus"]
            : ["kraken", "coinbase", "binanceus"];
        const exchangesToTry = [preferredExchange, ...defaultOrder].filter((v, i, a) => a.indexOf(v) === i);
        let lastError = null;
        for (const exName of exchangesToTry) {
            try {
                const ex = this.getPublicExchange(exName);
                const raw = await ex.fetchTicker(symbol);
                const ticker = {
                    symbol: raw.symbol || symbol,
                    bid: raw.bid || raw.last || 0,
                    ask: raw.ask || raw.last || 0,
                    last: raw.last || 0,
                    high: raw.high || raw.last || 0,
                    low: raw.low || raw.last || 0,
                    volume: raw.baseVolume || raw.quoteVolume || 0,
                    change: raw.change || 0,
                    percentage: raw.percentage || 0,
                    timestamp: raw.timestamp || now,
                };
                this.tickerCache.set(cacheKey, { ticker, timestamp: now });
                return ticker;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (cached)
            return cached.ticker;
        throw lastError || new Error(`Failed fetching ticker for ${symbol}`);
    }
    async fetchOHLCV(symbol, timeframe = "1m", limit = 100, exchangeId) {
        const isUsdPair = symbol.endsWith("/USD");
        const preferredExchange = exchangeId || (isUsdPair ? "coinbase" : "kraken");
        const cacheKey = `${preferredExchange}:${symbol}:${timeframe}:${limit}`;
        const cached = this.ohlcvCache.get(cacheKey);
        const now = Date.now();
        // Cache OHLCV candles for 15 seconds for snappy chart loading
        if (cached && now - cached.timestamp < 15000) {
            return cached.candles;
        }
        const defaultOrder = isUsdPair
            ? ["coinbase", "kraken", "binanceus"]
            : ["kraken", "coinbase", "binanceus"];
        const exchangesToTry = [preferredExchange, ...defaultOrder].filter((v, i, a) => a.indexOf(v) === i);
        let lastError = null;
        for (const exName of exchangesToTry) {
            try {
                const ex = this.getPublicExchange(exName);
                const ohlcv = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
                const candles = ohlcv.map((item) => ({
                    timestamp: item[0],
                    open: item[1],
                    high: item[2],
                    low: item[3],
                    close: item[4],
                    volume: item[5],
                }));
                this.ohlcvCache.set(cacheKey, { candles, timestamp: now });
                return candles;
            }
            catch (error) {
                lastError = error;
            }
        }
        if (cached)
            return cached.candles;
        throw lastError || new Error(`Failed fetching OHLCV for ${symbol}`);
    }
    async createOrder(account, orderParams) {
        if (account.is_paper === 1) {
            return this.paperEngine.placeOrder({
                ...orderParams,
                exchange_account_id: account.id,
            });
        }
        const ex = this.getAuthenticatedExchange(account);
        if (!ex)
            throw new Error("Could not instantiate authenticated exchange");
        let symbolToTrade = orderParams.symbol;
        if (account.exchange_id === "coinbase" && orderParams.side === "buy" && orderParams.symbol.endsWith("/USD")) {
            try {
                const balances = await this.fetchBalances(account);
                const usdFree = balances["USD"]?.free || 0;
                const usdcFree = balances["USDC"]?.free || 0;
                const estCost = orderParams.amount * orderParams.price;
                if (usdFree < estCost && usdcFree >= estCost) {
                    symbolToTrade = orderParams.symbol.replace(/\/USD$/, "/USDC");
                }
            }
            catch { }
        }
        let exOrder;
        try {
            exOrder = await ex.createOrder(symbolToTrade, orderParams.type, orderParams.side, orderParams.amount, orderParams.price);
        }
        catch (orderErr) {
            const errMsg = (orderErr.message || "").toLowerCase();
            const isBalanceErr = errMsg.includes("insufficient") || errMsg.includes("funds") || errMsg.includes("balance");
            if (account.exchange_id === "coinbase" && isBalanceErr) {
                if (orderParams.side === "buy" && symbolToTrade.endsWith("/USD")) {
                    const altSymbol = symbolToTrade.replace(/\/USD$/, "/USDC");
                    exOrder = await ex.createOrder(altSymbol, orderParams.type, orderParams.side, orderParams.amount, orderParams.price);
                }
                else if (orderParams.side === "sell") {
                    // Live fee deduction or rounding mismatch: force-fetch live balance and clamp
                    const baseAsset = orderParams.symbol.split("/")[0];
                    const balances = await this.fetchBalances(account, true);
                    const freeBase = Number(balances[baseAsset]?.free || 0);
                    // Floor down to 5 decimals with 0.5% margin for fee buffer
                    const clampedAmount = Math.floor(freeBase * 0.995 * 100000) / 100000;
                    if (clampedAmount > 0 && clampedAmount * orderParams.price >= 1.0) {
                        console.log(`[ExchangeManager] Auto-clamping sell order from ${orderParams.amount} to verified free ${clampedAmount} ${baseAsset}`);
                        exOrder = await ex.createOrder(symbolToTrade, orderParams.type, orderParams.side, clampedAmount, orderParams.price);
                    }
                    else {
                        throw orderErr;
                    }
                }
                else {
                    throw orderErr;
                }
            }
            else {
                throw orderErr;
            }
        }
        const db = (0, database_1.getDatabase)();
        const orderId = `live-ord-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const filled = exOrder.filled !== undefined ? exOrder.filled : (orderParams.type === "market" ? orderParams.amount : 0);
        const avgPrice = exOrder.average || exOrder.price || orderParams.price;
        const cost = exOrder.cost || (filled * avgPrice);
        // Coinbase Tier 1 taker fee is 0.90% (verified live from Coinbase API orders)
        const fee = (exOrder.fee && exOrder.fee.cost)
            ? Number(exOrder.fee.cost)
            : Number((cost * 0.009).toFixed(4));
        const status = exOrder.status || (orderParams.type === "market" ? "filled" : "open");
        const order = {
            id: orderId,
            bot_id: orderParams.bot_id,
            exchange_account_id: account.id,
            exchange_order_id: String(exOrder.id || `cb-${Date.now()}`),
            symbol: orderParams.symbol,
            side: orderParams.side,
            type: orderParams.type,
            price: avgPrice,
            amount: exOrder.amount || orderParams.amount,
            filled_amount: filled,
            cost,
            fee,
            status: status === "closed" ? "filled" : status,
            is_paper: 0,
            created_at: now,
            updated_at: now,
        };
        db.prepare(`
      INSERT INTO orders (
        id, bot_id, exchange_account_id, exchange_order_id, symbol, side, type,
        price, amount, filled_amount, cost, fee, status, is_paper, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(order.id, order.bot_id, order.exchange_account_id, order.exchange_order_id, order.symbol, order.side, order.type, order.price, order.amount, order.filled_amount, order.cost, order.fee, order.status, order.is_paper, order.created_at, order.updated_at);
        this.balanceCache.delete(account.id);
        // If order was filled (e.g. market order execution), record the trade
        if (order.status === "filled" && order.filled_amount > 0) {
            const tradeId = `live-trd-${crypto.randomUUID()}`;
            db.prepare(`
        INSERT INTO trades (
          id, bot_id, order_id, symbol, side, price, amount, cost, fee, realized_pnl, is_paper, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(tradeId, order.bot_id, order.id, order.symbol, order.side, order.price, order.filled_amount, order.cost, order.fee, 0, now);
        }
        return order;
    }
    async cancelOrder(order, account) {
        if (order.is_paper === 1) {
            const canceled = this.paperEngine.cancelOrder(order.id);
            return canceled !== null;
        }
        const ex = this.getAuthenticatedExchange(account);
        if (!ex || !order.exchange_order_id)
            return false;
        try {
            await ex.cancelOrder(order.exchange_order_id, order.symbol);
            const db = (0, database_1.getDatabase)();
            db.prepare("UPDATE orders SET status = 'canceled', updated_at = datetime('now') WHERE id = ?").run(order.id);
            return true;
        }
        catch (error) {
            console.error(`[ExchangeManager] Cancel order error for ${order.id}:`, error);
            return false;
        }
    }
    async fetchBalances(account, forceRefresh = false) {
        if (account.is_paper === 1) {
            return this.paperEngine.getBalances();
        }
        const cached = this.balanceCache.get(account.id);
        const now = Date.now();
        if (!forceRefresh && cached && now - cached.timestamp < 10000) {
            return cached.balances;
        }
        const ex = this.getAuthenticatedExchange(account);
        if (!ex)
            throw new Error("Authentication failed for live exchange");
        const rawBal = await ex.fetchBalance();
        const result = {};
        for (const [currency, data] of Object.entries(rawBal.total || {})) {
            const free = Number(rawBal.free?.[currency] || 0);
            const used = Number(rawBal.used?.[currency] || 0);
            const total = Number(data || 0);
            if (total > 0) {
                result[currency] = { free, used, total };
            }
        }
        this.balanceCache.set(account.id, { balances: result, timestamp: now });
        return result;
    }
    async calculateTotalPortfolioUsd(account) {
        const balances = await this.fetchBalances(account);
        let totalUsd = 0;
        const parts = [];
        const stableCoins = new Set(["USD", "USDC", "USDT", "USDS", "DAI", "BUSD"]);
        for (const [currency, b] of Object.entries(balances)) {
            if (b.total <= 0)
                continue;
            if (stableCoins.has(currency.toUpperCase())) {
                totalUsd += b.total;
                if (b.total >= 0.01) {
                    parts.push(`$${b.total.toFixed(2)} ${currency}`);
                }
            }
            else {
                try {
                    const ticker = await this.fetchTicker(`${currency}/USD`, "coinbase");
                    const val = b.total * ticker.last;
                    totalUsd += val;
                    if (val >= 0.01) {
                        parts.push(`${b.total.toFixed(4)} ${currency} (~$${val.toFixed(2)})`);
                    }
                }
                catch {
                    // If ticker lookup fails, try USDT
                    try {
                        const ticker = await this.fetchTicker(`${currency}/USDT`, "kraken");
                        const val = b.total * ticker.last;
                        totalUsd += val;
                        if (val >= 0.01) {
                            parts.push(`${b.total.toFixed(4)} ${currency} (~$${val.toFixed(2)})`);
                        }
                    }
                    catch {
                        // Cannot price asset
                    }
                }
            }
        }
        return {
            totalUsd,
            balances,
            breakdown: parts.join(" | ") || "USD Balance",
        };
    }
}
exports.ExchangeManager = ExchangeManager;

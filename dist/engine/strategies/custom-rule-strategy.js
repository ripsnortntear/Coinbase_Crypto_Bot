"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomRuleStrategy = void 0;
const technicalindicators_1 = require("technicalindicators");
const base_strategy_1 = require("./base-strategy");
const ml_predictor_1 = require("../ml-predictor");
class CustomRuleStrategy extends base_strategy_1.BaseStrategy {
    config;
    inPosition = false;
    entryPrice = 0;
    lastBuyErrorTime = 0;
    lastStopLossTime = 0;
    constructor(bot, account, exchangeManager) {
        super(bot, account, exchangeManager);
        const raw = JSON.parse(bot.config_json || "{}");
        this.config = {
            logic: raw.logic === "OR" ? "OR" : "AND",
            conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
            orderAmountUsd: Math.max(5.0, Number(raw.orderAmountUsd || 25)),
            takeProfitPercentage: Math.max(2.0, Number(raw.takeProfitPercentage || 2.5)),
            stopLossPercentage: raw.stopLossPercentage ? Number(raw.stopLossPercentage) : undefined,
        };
    }
    async initialize() {
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        this.log("info", `🎨 Visual Rule Strategy active for ${this.bot.symbol} (${this.config.conditions.length} ${this.config.logic} conditions, TP +${this.config.takeProfitPercentage}%)${this.inPosition ? ` | Hydrated open position @ $${this.entryPrice.toFixed(4)}` : ""}`);
    }
    evalOp(actual, op, target) {
        switch (op) {
            case "<": return actual < target;
            case ">": return actual > target;
            case "<=": return actual <= target;
            case ">=": return actual >= target;
            default: return false;
        }
    }
    async onTick(ticker) {
        const pos = this.hydratePositionFromDb();
        this.inPosition = pos.inPosition;
        this.entryPrice = pos.entryPrice;
        if (!this.inPosition || this.entryPrice <= 0)
            return;
        if (ticker.last >= this.entryPrice * (1 + this.config.takeProfitPercentage / 100)) {
            await this.closePosition(ticker.last, "Visual Rule Take-Profit");
        }
        else if (this.config.stopLossPercentage &&
            ticker.last <= this.entryPrice * (1 - this.config.stopLossPercentage / 100)) {
            this.lastStopLossTime = Date.now();
            await this.closePosition(ticker.last, "Visual Rule Stop-Loss");
        }
    }
    async onCandle(candles) {
        const nowTs = Date.now();
        if (this.inPosition ||
            candles.length < 25 ||
            this.config.conditions.length === 0 ||
            nowTs - this.lastBuyErrorTime <= 300000 ||
            nowTs - this.lastStopLossTime < 3600000) {
            return;
        }
        const closes = candles.map((c) => c.close);
        const lastPrice = closes[closes.length - 1];
        const rsiArr = technicalindicators_1.RSI.calculate({ values: closes, period: 14 });
        const bbArr = technicalindicators_1.BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        const mlPred = ml_predictor_1.MlPredictor.getInstance().predict(this.bot.symbol, candles);
        const curRsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
        const curBB = bbArr.length > 0 ? bbArr[bbArr.length - 1] : { lower: lastPrice, upper: lastPrice, middle: lastPrice };
        const results = this.config.conditions.map((cond) => {
            let metric = lastPrice;
            if (cond.indicator === "RSI")
                metric = curRsi;
            else if (cond.indicator === "BB_LOWER")
                metric = curBB.lower;
            else if (cond.indicator === "BB_UPPER")
                metric = curBB.upper;
            else if (cond.indicator === "ML_PROB")
                metric = mlPred.probUp * 100;
            return this.evalOp(metric, cond.op, cond.value);
        });
        const triggered = this.config.logic === "AND" ? results.every(Boolean) : results.some(Boolean);
        if (!triggered)
            return;
        const guard = this.canEnterBuy();
        if (!guard.allowed) {
            this.log("warn", `🛡️ Visual Rule BUY paused by Guard: ${guard.reason}`);
            return;
        }
        const expGuard = await this.checkExposureCap();
        if (!expGuard.allowed) {
            this.log("warn", `🛡️ Visual Rule BUY paused by Exposure Cap: ${expGuard.reason}`);
            return;
        }
        const amount = Number((this.config.orderAmountUsd / lastPrice).toFixed(5));
        if (amount > 0) {
            try {
                await this.placeOrder("buy", "market", lastPrice, amount, true);
                this.inPosition = true;
                this.entryPrice = lastPrice;
            }
            catch (err) {
                this.lastBuyErrorTime = Date.now();
                this.log("error", `Visual Rule BUY failed (cooling down 5m): ${err.message}`);
            }
        }
    }
    async closePosition(price, reason) {
        try {
            const baseAsset = this.bot.symbol.split("/")[0];
            const balances = await this.exchangeManager.fetchBalances(this.account, true);
            const freeBase = Number(balances[baseAsset]?.free || 0);
            const sellAmount = Math.floor(freeBase * 0.995 * 100000) / 100000;
            if (sellAmount * price >= 1.0) {
                await this.placeOrder("sell", "market", price, sellAmount, reason.includes("Take-Profit"));
                this.log("trade", `${reason} executed @ $${price.toFixed(2)}`);
            }
        }
        catch (err) {
            this.log("error", `Visual Rule exit failed: ${err.message}`);
        }
        finally {
            this.inPosition = false;
            this.entryPrice = 0;
        }
    }
}
exports.CustomRuleStrategy = CustomRuleStrategy;

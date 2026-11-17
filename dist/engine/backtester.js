"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Backtester = void 0;
const technicalindicators_1 = require("technicalindicators");
class Backtester {
    exchangeManager;
    constructor(exchangeManager) {
        this.exchangeManager = exchangeManager;
    }
    async run(req) {
        const limit = Math.min(720, Math.max(50, Number(req.candleLimit || 300)));
        const candles = req.preloadedCandles && req.preloadedCandles.length >= 30
            ? req.preloadedCandles
            : await this.exchangeManager.fetchOHLCV(req.symbol, req.timeframe || "1h", limit);
        if (!candles || candles.length < 30) {
            throw new Error(`Insufficient historical candles for ${req.symbol} (${req.timeframe})`);
        }
        const feeRate = req.executionMode === "maker" ? 0.004 : 0.009;
        let cash = Number(req.initialCapital || 1000);
        let assetAmount = 0;
        let totalBuyCost = 0;
        let totalFees = 0;
        let totalClosedTrades = 0;
        let winningTrades = 0;
        const trades = [];
        const equityCurve = [];
        let peakEquity = cash;
        let maxDrawdownPct = 0;
        const returns = [];
        let prevEquity = cash;
        // Strategy-specific state
        const cfg = req.config || {};
        const takeProfitPct = Math.max(2.0, Number(cfg.takeProfitPercentage ?? 2.5));
        const trailingPct = Number(cfg.trailingTakeProfitPercentage || 0);
        const stopLossPct = cfg.stopLossPercentage ? Number(cfg.stopLossPercentage) : 0;
        // DCA state
        let safetyOrdersPlaced = 0;
        let lastBuyPrice = 0;
        let trailingArmed = false;
        let trailingPeakPrice = 0;
        const maxSafetyOrders = Number(cfg.maxSafetyOrders ?? 5);
        const priceDropPct = Math.max(1.2, Number(cfg.priceDropPercentage ?? 1.8));
        const executeBuy = (price, usdAmount, ts, reason) => {
            const spend = Math.min(cash, usdAmount);
            if (spend < 1.0 || price <= 0)
                return;
            const fee = spend * feeRate;
            const netSpend = spend - fee;
            const qty = netSpend / price;
            cash -= spend;
            assetAmount += qty;
            totalBuyCost += spend;
            totalFees += fee;
            lastBuyPrice = price;
            trades.push({
                timestamp: ts,
                side: "buy",
                price,
                amount: Number(qty.toFixed(6)),
                cost: Number(spend.toFixed(2)),
                fee: Number(fee.toFixed(4)),
                realizedPnl: 0,
                reason,
            });
        };
        const executeSellAll = (price, ts, reason) => {
            if (assetAmount <= 0.00001 || price <= 0)
                return;
            const grossProceeds = assetAmount * price;
            const fee = grossProceeds * feeRate;
            const netProceeds = grossProceeds - fee;
            const realizedPnl = netProceeds - totalBuyCost;
            cash += netProceeds;
            totalFees += fee;
            totalClosedTrades++;
            if (realizedPnl > 0)
                winningTrades++;
            trades.push({
                timestamp: ts,
                side: "sell",
                price,
                amount: Number(assetAmount.toFixed(6)),
                cost: Number(grossProceeds.toFixed(2)),
                fee: Number(fee.toFixed(4)),
                realizedPnl: Number(realizedPnl.toFixed(4)),
                reason,
            });
            assetAmount = 0;
            totalBuyCost = 0;
            safetyOrdersPlaced = 0;
            lastBuyPrice = 0;
            trailingArmed = false;
            trailingPeakPrice = 0;
        };
        // Precompute close history slice-by-slice with zero look-ahead bias
        const closeHistory = [];
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            closeHistory.push(c.close);
            const price = c.close;
            if (req.strategyType === "dca") {
                if (assetAmount <= 0.00001) {
                    // Base order: 25% of current cash
                    executeBuy(price, cash * 0.25, c.timestamp, "DCA Base Order");
                }
                else {
                    const avgEntry = totalBuyCost / assetAmount;
                    const tpTarget = avgEntry * (1 + takeProfitPct / 100);
                    // Check Trailing TP / Flat TP using candle high/close
                    if (trailingPct > 0) {
                        if (!trailingArmed && c.high >= tpTarget) {
                            trailingArmed = true;
                            trailingPeakPrice = c.high;
                        }
                        if (trailingArmed) {
                            if (c.high > trailingPeakPrice)
                                trailingPeakPrice = c.high;
                            const trailStop = Math.max(tpTarget * 0.999, trailingPeakPrice * (1 - trailingPct / 100));
                            if (price <= trailStop) {
                                executeSellAll(price, c.timestamp, `Trailing TP (Peak $${trailingPeakPrice.toFixed(2)})`);
                            }
                        }
                    }
                    else if (c.high >= tpTarget) {
                        executeSellAll(tpTarget, c.timestamp, `Take Profit (+${takeProfitPct}%)`);
                    }
                    // Check Stop Loss if still in position
                    if (assetAmount > 0.00001 && stopLossPct > 0 && price <= avgEntry * (1 - stopLossPct / 100)) {
                        executeSellAll(price, c.timestamp, `Stop Loss (-${stopLossPct}%)`);
                    }
                    // Check Safety Order
                    if (assetAmount > 0.00001 &&
                        safetyOrdersPlaced < maxSafetyOrders &&
                        lastBuyPrice > 0 &&
                        price <= lastBuyPrice * (1 - priceDropPct / 100)) {
                        safetyOrdersPlaced++;
                        executeBuy(price, cash * 0.20, c.timestamp, `Safety Order #${safetyOrdersPlaced}`);
                    }
                }
            }
            else if (req.strategyType === "bollinger" && closeHistory.length >= 22) {
                const period = Number(cfg.period || 20);
                const stdDev = Number(cfg.stdDev || 2);
                const bb = technicalindicators_1.BollingerBands.calculate({ values: closeHistory, period, stdDev });
                const curBB = bb[bb.length - 1];
                if (curBB) {
                    if (assetAmount <= 0.00001 && price <= curBB.lower) {
                        executeBuy(price, cash * 0.30, c.timestamp, "Bollinger Lower Band");
                    }
                    else if (assetAmount > 0.00001) {
                        const avgEntry = totalBuyCost / assetAmount;
                        if (price >= curBB.middle && price >= avgEntry * (1 + takeProfitPct / 100)) {
                            executeSellAll(price, c.timestamp, "Bollinger Reversion TP");
                        }
                        else if (stopLossPct > 0 && price <= avgEntry * (1 - stopLossPct / 100)) {
                            executeSellAll(price, c.timestamp, "Bollinger Stop Loss");
                        }
                    }
                }
            }
            else if (req.strategyType === "momentum_rsi" && closeHistory.length >= 18) {
                const rsiPeriod = Number(cfg.rsiPeriod || 14);
                const oversold = Number(cfg.rsiOversold || 30);
                const overbought = Number(cfg.rsiOverbought || 70);
                const rsis = technicalindicators_1.RSI.calculate({ values: closeHistory, period: rsiPeriod });
                if (rsis.length >= 2) {
                    const curRsi = rsis[rsis.length - 1];
                    const prevRsi = rsis[rsis.length - 2];
                    if (assetAmount <= 0.00001 && prevRsi <= oversold && curRsi > prevRsi) {
                        executeBuy(price, cash * 0.30, c.timestamp, `RSI Rebound (${curRsi.toFixed(1)})`);
                    }
                    else if (assetAmount > 0.00001) {
                        const avgEntry = totalBuyCost / assetAmount;
                        if ((curRsi >= overbought && price >= avgEntry * (1 + takeProfitPct / 100)) || price >= avgEntry * (1 + takeProfitPct / 100)) {
                            executeSellAll(price, c.timestamp, `RSI Take Profit (${curRsi.toFixed(1)})`);
                        }
                        else if (stopLossPct > 0 && price <= avgEntry * (1 - stopLossPct / 100)) {
                            executeSellAll(price, c.timestamp, "RSI Stop Loss");
                        }
                    }
                }
            }
            else if (req.strategyType === "grid") {
                // Simple arithmetic grid simulation around initial window
                const gridStepPct = Math.max(2.0, Number(cfg.takeProfitPercentage || 2.2));
                if (assetAmount <= 0.00001) {
                    executeBuy(price, cash * 0.25, c.timestamp, "Grid Entry");
                }
                else {
                    const avgEntry = totalBuyCost / assetAmount;
                    if (price >= avgEntry * (1 + gridStepPct / 100)) {
                        executeSellAll(price, c.timestamp, `Grid Sell (+${gridStepPct}%)`);
                    }
                    else if (price <= lastBuyPrice * (1 - gridStepPct / 100) && cash >= 10) {
                        executeBuy(price, cash * 0.20, c.timestamp, "Grid Lower Fill");
                    }
                }
            }
            const equity = cash + assetAmount * price;
            if (equity > peakEquity)
                peakEquity = equity;
            const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
            if (dd > maxDrawdownPct)
                maxDrawdownPct = dd;
            if (prevEquity > 0) {
                returns.push((equity - prevEquity) / prevEquity);
            }
            prevEquity = equity;
            equityCurve.push({
                timestamp: c.timestamp,
                equity: Number(equity.toFixed(2)),
                price: Number(price.toFixed(4)),
            });
        }
        const finalEquity = cash + assetAmount * candles[candles.length - 1].close;
        const netPnl = finalEquity - req.initialCapital;
        const totalReturnPct = req.initialCapital > 0 ? (netPnl / req.initialCapital) * 100 : 0;
        // Annualized-like Sharpe proxy across candle returns
        let sharpeRatio = 0;
        if (returns.length > 2) {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            const std = Math.sqrt(variance);
            if (std > 0) {
                sharpeRatio = Number(((mean / std) * Math.sqrt(returns.length)).toFixed(2));
            }
        }
        // Downsample equityCurve if > 150 points
        const step = Math.max(1, Math.floor(equityCurve.length / 150));
        const sampledCurve = equityCurve.filter((_, idx) => idx % step === 0 || idx === equityCurve.length - 1);
        return {
            symbol: req.symbol,
            strategyType: req.strategyType,
            timeframe: req.timeframe || "1h",
            executionMode: req.executionMode,
            feeRatePct: Number((feeRate * 100).toFixed(2)),
            metrics: {
                initialCapital: Number(req.initialCapital.toFixed(2)),
                finalEquity: Number(finalEquity.toFixed(2)),
                netPnl: Number(netPnl.toFixed(2)),
                totalReturnPct: Number(totalReturnPct.toFixed(2)),
                totalTrades: totalClosedTrades,
                winningTrades,
                winRate: totalClosedTrades > 0 ? Math.round((winningTrades / totalClosedTrades) * 100) : 0,
                maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
                sharpeRatio,
                totalFees: Number(totalFees.toFixed(2)),
                candlesAnalyzed: candles.length,
                startDate: new Date(candles[0].timestamp).toISOString(),
                endDate: new Date(candles[candles.length - 1].timestamp).toISOString(),
            },
            equityCurve: sampledCurve,
            trades: trades.slice(-50).reverse(),
        };
    }
}
exports.Backtester = Backtester;

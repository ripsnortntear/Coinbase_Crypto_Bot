import { RSI, BollingerBands } from "technicalindicators";
import { Candle } from "./types";

export interface MlModelState {
  symbol: string;
  weights: number[];
  bias: number;
  accuracy: number;
  samplesTrained: number;
  lastTrainedAt: string;
  lastProbUp: number;
  lastSignal: "BULLISH" | "BEARISH" | "NEUTRAL";
}

function sigmoid(z: number): number {
  const clamped = Math.max(-20, Math.min(20, z));
  return 1 / (1 + Math.exp(-clamped));
}

export class MlPredictor {
  private static instance: MlPredictor | null = null;
  private models: Map<string, MlModelState> = new Map();

  private constructor() {}

  public static getInstance(): MlPredictor {
    if (!MlPredictor.instance) {
      MlPredictor.instance = new MlPredictor();
    }
    return MlPredictor.instance;
  }

  public getAllModels(): MlModelState[] {
    return Array.from(this.models.values());
  }

  public getModel(symbol: string): MlModelState | undefined {
    return this.models.get(symbol);
  }

  private extractFeatures(candles: Candle[]): { features: number[][]; indices: number[] } {
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume || 1);
    if (closes.length < 30) return { features: [], indices: [] };

    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    const bbArr = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });

    const features: number[][] = [];
    const indices: number[] = [];

    // Align from index 25 onward where all indicators are available
    for (let i = 25; i < candles.length; i++) {
      const rsiIdx = i - (closes.length - rsiArr.length);
      const bbIdx = i - (closes.length - bbArr.length);
      if (rsiIdx < 0 || bbIdx < 0 || rsiIdx >= rsiArr.length || bbIdx >= bbArr.length) continue;

      const c = candles[i];
      const prev1 = candles[i - 1];
      const prev4 = candles[i - 4];
      const bb = bbArr[bbIdx];

      const rsiNorm = (rsiArr[rsiIdx] - 50) / 50; // [-1, 1]
      const ret1 = prev1.close > 0 ? Math.max(-0.1, Math.min(0.1, (c.close - prev1.close) / prev1.close)) * 10 : 0;
      const ret4 = prev4.close > 0 ? Math.max(-0.2, Math.min(0.2, (c.close - prev4.close) / prev4.close)) * 5 : 0;
      const bbSpan = bb.upper - bb.lower;
      const bbPos = bbSpan > 0 ? Math.max(-1.5, Math.min(1.5, (c.close - bb.middle) / (bbSpan / 2))) : 0;

      let volSum = 0;
      for (let k = i - 20; k < i; k++) volSum += volumes[k];
      const avgVol = volSum / 20 || 1;
      const volRatio = Math.max(-1, Math.min(2, (volumes[i] / avgVol) - 1));

      features.push([rsiNorm, ret1, ret4, bbPos, volRatio]);
      indices.push(i);
    }

    return { features, indices };
  }

  public retrain(symbol: string, candles: Candle[]): MlModelState | null {
    const { features, indices } = this.extractFeatures(candles);
    const horizon = 3;
    const minGainPct = 0.004; // +0.4% forward 3-bar target

    const dataset: { x: number[]; y: number }[] = [];
    for (let j = 0; j < features.length; j++) {
      const idx = indices[j];
      if (idx + horizon >= candles.length) break;
      const futureReturn = (candles[idx + horizon].close - candles[idx].close) / candles[idx].close;
      dataset.push({ x: features[j], y: futureReturn >= minGainPct ? 1 : 0 });
    }

    if (dataset.length < 30) return null;

    const splitIdx = Math.floor(dataset.length * 0.8);
    const trainSet = dataset.slice(0, splitIdx);
    const valSet = dataset.slice(splitIdx);

    const weights = [0, 0, 0, 0, 0];
    let bias = 0;
    const lr = 0.08;
    const l2 = 0.001;
    const epochs = 120;

    for (let ep = 0; ep < epochs; ep++) {
      for (const sample of trainSet) {
        let z = bias;
        for (let k = 0; k < weights.length; k++) z += weights[k] * sample.x[k];
        const pred = sigmoid(z);
        const err = pred - sample.y;
        bias -= lr * err;
        for (let k = 0; k < weights.length; k++) {
          weights[k] -= lr * (err * sample.x[k] + l2 * weights[k]);
        }
      }
    }

    // Evaluate validation accuracy
    let correct = 0;
    for (const sample of valSet) {
      let z = bias;
      for (let k = 0; k < weights.length; k++) z += weights[k] * sample.x[k];
      const predLabel = sigmoid(z) >= 0.5 ? 1 : 0;
      if (predLabel === sample.y) correct++;
    }
    const accuracy = valSet.length > 0 ? Number(((correct / valSet.length) * 100).toFixed(1)) : 50;

    const latestX = features[features.length - 1];
    let latestZ = bias;
    for (let k = 0; k < weights.length; k++) latestZ += weights[k] * latestX[k];
    const lastProbUp = Number(sigmoid(latestZ).toFixed(3));
    const lastSignal: "BULLISH" | "BEARISH" | "NEUTRAL" =
      lastProbUp >= 0.58 ? "BULLISH" : lastProbUp <= 0.42 ? "BEARISH" : "NEUTRAL";

    const state: MlModelState = {
      symbol,
      weights: weights.map((w) => Number(w.toFixed(4))),
      bias: Number(bias.toFixed(4)),
      accuracy,
      samplesTrained: dataset.length,
      lastTrainedAt: new Date().toISOString(),
      lastProbUp,
      lastSignal,
    };

    this.models.set(symbol, state);
    return state;
  }

  public predict(symbol: string, candles?: Candle[]): { probUp: number; signal: "BULLISH" | "BEARISH" | "NEUTRAL"; accuracy: number } {
    let model = this.models.get(symbol);
    if (!model && candles && candles.length >= 40) {
      model = this.retrain(symbol, candles) || undefined;
    }
    if (!model) {
      return { probUp: 0.5, signal: "NEUTRAL", accuracy: 50 };
    }

    if (candles && candles.length >= 30) {
      const { features } = this.extractFeatures(candles);
      if (features.length > 0) {
        const x = features[features.length - 1];
        let z = model.bias;
        for (let k = 0; k < model.weights.length; k++) z += model.weights[k] * x[k];
        const probUp = Number(sigmoid(z).toFixed(3));
        const signal: "BULLISH" | "BEARISH" | "NEUTRAL" =
          probUp >= 0.58 ? "BULLISH" : probUp <= 0.42 ? "BEARISH" : "NEUTRAL";
        model.lastProbUp = probUp;
        model.lastSignal = signal;
      }
    }

    return { probUp: model.lastProbUp, signal: model.lastSignal, accuracy: model.accuracy };
  }
}

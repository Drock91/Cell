const { getLogger } = require("../core/logger");
const { calcIndicators, getVolatility } = require("./indicators");

class MeanReversionStrategy {
  constructor(config, exchange) {
    this.name = "meanReversion";
    this.config = config;
    this.exchange = exchange;
    this.mrConfig = config.strategies.meanReversion;
    this.lastSignalTime = new Map(); // pair -> timestamp
  }

  async analyze(pair, candles, ticker, context = {}) {
    const indicators = calcIndicators(candles, this.config);
    const price = ticker.last;
    const volatility = getVolatility(indicators);

    const lastTime = this.lastSignalTime.get(pair) || 0;
    if (Date.now() - lastTime < this.config.trading.cooldownMs) return null;

    const bb  = indicators.bb;
    const rsi = indicators.rsi;
    if (!bb || bb.length < 2 || !rsi || rsi.length < 2) return null;

    const lastBB  = bb[bb.length - 1];
    const lastRsi = rsi[rsi.length - 1];
    const prevRsi = rsi[rsi.length - 2];

    // StochRSI
    const stochRsi = indicators.stochRsi;
    let stochK = 50;
    if (stochRsi && stochRsi.length > 0) stochK = stochRsi[stochRsi.length - 1].k;

    // Volume
    const lastVol  = indicators.lastVolume;
    const volSma   = indicators.volumeSma;
    const avgVol   = volSma && volSma.length > 0 ? volSma[volSma.length - 1] : lastVol;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

    // OBV trend
    const obv = indicators.obv;
    let obvBullish = false, obvBearish = false;
    if (obv && obv.length >= 10) {
      obvBullish = obv[obv.length - 1] > obv[obv.length - 10];
      obvBearish = obv[obv.length - 1] < obv[obv.length - 10];
    }

    // MTF context
    const h1Trend    = context.h1Trend    || "neutral";
    const priceVsVwap = context.priceVsVwap || "neutral";
    const atrRegime  = context.atrRegime  || "normal";

    // In high-volatility regimes, signals are noisier — require stronger confirmation
    const regimeConfThreshold = atrRegime === "high" ? 0.64 : 0.58;

    // ATR-based stops: adapts to each pair's actual volatility instead of fixed %
    // This prevents noise-stopouts on volatile pairs (SUI, XLM) and over-wide stops on ETH
    const atrArr = indicators.atr;
    const atr = atrArr && atrArr.length > 0 ? atrArr[atrArr.length - 1] : price * this.config.trading.stopLossPct;
    const slAtr  = atr * 1.5;  // 1.5×ATR stop — tighter, recycles capital faster
    const minTp  = atr * 2.0;  // minimum TP distance (floor so R:R ≥ 1.33:1)

    // ── OVERSOLD BOUNCE ───────────────────────────────────────────────────
    // Core condition: price at/below lower BB + RSI oversold + RSI turning up
    // With MTF: penalise if 1h trend is strongly down (still fire but lower conf)
    if (
      price <= lastBB.lower * 1.003 &&
      lastRsi <= this.mrConfig.rsiOversold &&
      lastRsi > prevRsi
    ) {
      let confidence = this._calcConfidence("buy", price, lastBB, lastRsi, stochK, volRatio, obvBullish);

      // MTF adjustments
      if (h1Trend === "up")    confidence = Math.min(confidence + 0.08, 0.95);
      if (h1Trend === "down")  confidence = Math.max(confidence - 0.10, 0.40);
      if (priceVsVwap === "below") confidence = Math.min(confidence + 0.05, 0.95);

      // Regime: reduce in high ATR (choppy), boost in low ATR (clean ranges)
      if (atrRegime === "high") confidence -= 0.06;
      if (atrRegime === "low")  confidence += 0.04;

      if (confidence < regimeConfThreshold) return null;

      this.lastSignalTime.set(pair, Date.now());

      const sl = price - slAtr;
      const tp = Math.max(lastBB.middle, price + minTp); // BB middle is the natural MR target

      const tags = [];
      if (h1Trend !== "neutral") tags.push(`1h:${h1Trend}`);
      if (stochK < 25) tags.push(`StochK=${stochK.toFixed(0)}`);
      if (volRatio >= 1.4) tags.push(`vol ${volRatio.toFixed(1)}x`);
      if (priceVsVwap === "below") tags.push("<VWAP");
      if (obvBullish) tags.push("OBV+");

      return {
        pair, side: "buy", price,
        strategy: this.name, confidence, volatility,
        winRate: 0.62,
        stopLoss: sl, takeProfit: tp,
        reason: `Oversold: RSI=${lastRsi.toFixed(1)} BB-low${tags.length ? " [" + tags.join(" ") + "]" : ""}`,
      };
    }

    // ── OVERBOUGHT REVERSAL ───────────────────────────────────────────────
    const sellRsiThreshold = this.mrConfig.rsiOverboughtShort || this.mrConfig.rsiOverbought;

    // bearTrendShort mode: no price level required — short whenever RSI bounces
    // from oversold back into neutral zone (42+) and starts rolling over again.
    // This catches dead-cat-bounce rollovers without needing a full rally to BB upper.
    const sellConditionMet = this.mrConfig.bearTrendShort
      ? (lastRsi >= sellRsiThreshold && lastRsi < prevRsi && lastRsi < 65)
      : (price >= lastBB.upper * 0.997 && lastRsi >= sellRsiThreshold && lastRsi < prevRsi);

    if (sellConditionMet) {
      let confidence = this._calcConfidence("sell", price, lastBB, lastRsi, stochK, volRatio, obvBearish);

      if (h1Trend === "down")  confidence = Math.min(confidence + 0.08, 0.95);
      if (h1Trend === "up")    confidence = Math.max(confidence - 0.10, 0.40);
      if (priceVsVwap === "above") confidence = Math.min(confidence + 0.05, 0.95);
      if (atrRegime === "high") confidence -= 0.06;
      if (atrRegime === "low")  confidence += 0.04;

      if (confidence < regimeConfThreshold) return null;

      this.lastSignalTime.set(pair, Date.now());

      const sl = price + slAtr;
      // Bear-trend short: target BB lower; normal MR short: target BB middle
      const naturalTarget = this.mrConfig.bearTrendShort ? lastBB.lower : lastBB.middle;
      const tp = Math.min(naturalTarget, price - minTp);

      const tags = [];
      if (h1Trend !== "neutral") tags.push(`1h:${h1Trend}`);
      if (stochK > 75) tags.push(`StochK=${stochK.toFixed(0)}`);
      if (volRatio >= 1.4) tags.push(`vol ${volRatio.toFixed(1)}x`);
      if (priceVsVwap === "above") tags.push(">VWAP");
      if (obvBearish) tags.push("OBV-");

      return {
        pair, side: "sell", price,
        strategy: this.name, confidence, volatility,
        winRate: 0.58,
        stopLoss: sl, takeProfit: tp,
        reason: `Overbought: RSI=${lastRsi.toFixed(1)} BB-top${tags.length ? " [" + tags.join(" ") + "]" : ""}`,
      };
    }

    return null;
  }

  _calcConfidence(side, price, bb, rsi, stochK, volRatio, obvConfirms) {
    let confidence = 0.56;

    // BB overshoot
    const bandwidth = bb.upper - bb.lower;
    if (bandwidth > 0) {
      const overshoot = side === "buy"
        ? (bb.lower - price) / bandwidth
        : (price - bb.upper) / bandwidth;
      confidence += Math.min(overshoot * 3, 0.15);
    }

    // RSI extremity
    if (side === "buy") {
      if      (rsi < 20) confidence += 0.12;
      else if (rsi < 30) confidence += 0.08;
      else if (rsi < 38) confidence += 0.04;
    } else {
      if      (rsi > 80) confidence += 0.12;
      else if (rsi > 70) confidence += 0.08;
      else if (rsi > 62) confidence += 0.04;
    }

    // StochRSI
    if (side === "buy"  && stochK < 20) confidence += 0.08;
    if (side === "sell" && stochK > 80) confidence += 0.08;

    // Volume surge
    if      (volRatio >= 2.5) confidence += 0.10;
    else if (volRatio >= 1.8) confidence += 0.07;
    else if (volRatio >= 1.4) confidence += 0.04;

    // OBV
    if (obvConfirms) confidence += 0.05;

    return Math.min(confidence, 0.95);
  }
}

module.exports = { MeanReversionStrategy };

const { getLogger } = require("../core/logger");
const { calcIndicators, getVolatility } = require("./indicators");

class MomentumStrategy {
  constructor(config, exchange) {
    this.name = "momentum";
    this.config = config;
    this.exchange = exchange;
    this.momConfig = config.strategies.momentum;
    this.lastSignalTime = new Map();
    this.prevState = new Map(); // pair -> { trend, crossover }
  }

  async analyze(pair, candles, ticker, context = {}) {
    const indicators = calcIndicators(candles, this.config);
    const price = ticker.last;
    const volatility = getVolatility(indicators);

    // Check cooldown
    const lastTime = this.lastSignalTime.get(pair) || 0;
    if (Date.now() - lastTime < this.config.trading.cooldownMs) {
      return null;
    }

    const { emaFast, emaSlow, macd, volumeSma } = indicators;

    if (
      !emaFast || emaFast.length < 2 ||
      !emaSlow || emaSlow.length < 2 ||
      !macd || macd.length < 2
    ) {
      return null;
    }

    // Align arrays (they have different lengths due to different periods)
    const lastEmaFast = emaFast[emaFast.length - 1];
    const prevEmaFast = emaFast[emaFast.length - 2];
    const lastEmaSlow = emaSlow[emaSlow.length - 1];
    const prevEmaSlow = emaSlow[emaSlow.length - 2];

    const lastMacd = macd[macd.length - 1];
    const prevMacd = macd[macd.length - 2];

    // Volume confirmation
    const lastVol = indicators.lastVolume;
    const avgVol = volumeSma && volumeSma.length > 0
      ? volumeSma[volumeSma.length - 1]
      : lastVol;
    const volumeRatio = avgVol > 0 ? lastVol / avgVol : 1;
    const volumeConfirmed = volumeRatio >= (this.momConfig.volumeThreshold || 1.2);

    // EMA50 trend filter
    const ema50 = indicators.ema50;
    const lastEma50 = ema50 && ema50.length > 0 ? ema50[ema50.length - 1] : null;
    const inUptrend = !lastEma50 || price > lastEma50;
    const inDowntrend = !lastEma50 || price < lastEma50;

    // RSI gate — don't buy into overbought, don't short into oversold
    const rsi = indicators.rsi;
    const lastRsi = rsi && rsi.length > 0 ? rsi[rsi.length - 1] : 50;

    // Detect EMA crossover
    const bullishCross = prevEmaFast <= prevEmaSlow && lastEmaFast > lastEmaSlow;
    const bearishCross = prevEmaFast >= prevEmaSlow && lastEmaFast < lastEmaSlow;

    // MACD confirmation
    const macdBullish = lastMacd.MACD > lastMacd.signal && prevMacd.MACD <= prevMacd.signal;
    const macdBearish = lastMacd.MACD < lastMacd.signal && prevMacd.MACD >= prevMacd.signal;

    // MTF context
    const h1Trend   = context.h1Trend   || "neutral";
    const atrRegime = context.atrRegime || "normal";
    const priceVsVwap = context.priceVsVwap || "neutral";

    // In high-volatility regimes, false crossovers are more common — require volume confirmation to be stricter
    const volThreshold = atrRegime === "high"
      ? (this.momConfig.volumeThreshold || 1.2) * 1.4
      : (this.momConfig.volumeThreshold || 1.2);
    const volumeConfirmedStrict = volumeRatio >= volThreshold;

    // ATR-based stops: adapts to current volatility instead of fixed %
    const atr = indicators.atr && indicators.atr.length > 0
      ? indicators.atr[indicators.atr.length - 1]
      : price * this.config.trading.stopLossPct;
    const atrStop   = atr * 1.5;
    const atrTarget = atr * 3.5; // 2.33:1 R:R — realistic for 5m crypto trends

    // BULLISH: EMA crossover + MACD + volume + 1h uptrend + RSI not overbought
    if (bullishCross && (macdBullish || lastMacd.MACD > 0) && volumeConfirmedStrict && inUptrend && lastRsi < 70) {
      let confidence = this._calcConfidence("buy", lastEmaFast, lastEmaSlow, lastMacd, volumeRatio, lastRsi);

      // MTF boost: reward when 1h agrees
      if (h1Trend === "up")   confidence = Math.min(confidence + 0.10, 0.95);
      if (priceVsVwap === "above") confidence = Math.min(confidence + 0.05, 0.95);
      if (atrRegime === "high") confidence -= 0.05;

      this.lastSignalTime.set(pair, Date.now());

      return {
        pair, side: "buy", price,
        strategy: this.name, confidence, volatility,
        winRate: 0.55,
        stopLoss:   price - atrStop,
        takeProfit: price + atrTarget,
        reason: `Bullish cross EMA${this.momConfig.emaFast}/${this.momConfig.emaSlow} MACD+ vol${volumeRatio.toFixed(1)}x 1h:${h1Trend} RSI=${lastRsi.toFixed(0)}`,
      };
    }

    // BEARISH: EMA crossover + MACD + volume + 1h downtrend + RSI not oversold
    if (bearishCross && (macdBearish || lastMacd.MACD < 0) && volumeConfirmedStrict && inDowntrend && lastRsi > 30) {
      let confidence = this._calcConfidence("sell", lastEmaFast, lastEmaSlow, lastMacd, volumeRatio, lastRsi);

      if (h1Trend === "down") confidence = Math.min(confidence + 0.10, 0.95);
      if (priceVsVwap === "below") confidence = Math.min(confidence + 0.05, 0.95);
      if (atrRegime === "high") confidence -= 0.05;

      this.lastSignalTime.set(pair, Date.now());

      return {
        pair, side: "sell", price,
        strategy: this.name, confidence, volatility,
        winRate: 0.53,
        stopLoss:   price + atrStop,
        takeProfit: price - atrTarget,
        reason: `Bearish cross EMA${this.momConfig.emaFast}/${this.momConfig.emaSlow} MACD- vol${volumeRatio.toFixed(1)}x 1h:${h1Trend} RSI=${lastRsi.toFixed(0)}`,
      };
    }

    return null;
  }

  _calcConfidence(side, emaFast, emaSlow, macd, volumeRatio, rsi) {
    let confidence = 0.56;

    // EMA separation strength
    const emaDiff = Math.abs(emaFast - emaSlow) / emaSlow;
    confidence += Math.min(emaDiff * 15, 0.15);

    // MACD histogram — normalised by price level rather than raw value
    const histogram = macd.histogram || 0;
    const histNorm = Math.abs(histogram) / (emaSlow || 1);
    confidence += Math.min(histNorm * 50, 0.12);

    // Volume
    if (volumeRatio >= 2.0) confidence += 0.10;
    else if (volumeRatio >= 1.5) confidence += 0.06;

    // RSI proximity to extreme (stronger signal when further from 50)
    const rsiEdge = side === "buy" ? Math.max(0, 50 - rsi) : Math.max(0, rsi - 50);
    confidence += Math.min(rsiEdge * 0.003, 0.06);

    return Math.min(confidence, 0.95);
  }
}

module.exports = { MomentumStrategy };

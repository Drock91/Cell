const ti = require("technicalindicators");

/**
 * Calculate all technical indicators from OHLCV candles.
 * Each candle: [timestamp, open, high, low, close, volume]
 */
function calcIndicators(candles, config) {
  const closes = candles.map((c) => c[4]);
  const highs = candles.map((c) => c[2]);
  const lows = candles.map((c) => c[3]);
  const volumes = candles.map((c) => c[5]);

  const result = {};

  // RSI
  const rsiPeriod = config.strategies.meanReversion.rsiPeriod || 14;
  result.rsi = ti.RSI.calculate({ values: closes, period: rsiPeriod });

  // Bollinger Bands
  const bbPeriod = config.strategies.meanReversion.bbPeriod || 20;
  const bbStd = config.strategies.meanReversion.bbStd || 2;
  result.bb = ti.BollingerBands.calculate({
    values: closes,
    period: bbPeriod,
    stdDev: bbStd,
  });

  // EMA Fast & Slow
  const emaFast = config.strategies.momentum.emaFast || 9;
  const emaSlow = config.strategies.momentum.emaSlow || 21;
  result.emaFast = ti.EMA.calculate({ values: closes, period: emaFast });
  result.emaSlow = ti.EMA.calculate({ values: closes, period: emaSlow });

  // MACD
  result.macd = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: config.strategies.momentum.macdSignal || 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  // ATR (for volatility)
  result.atr = ti.ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });

  // Volume SMA
  result.volumeSma = ti.SMA.calculate({ values: volumes, period: 20 });

  // Stochastic RSI - much more sensitive than plain RSI for crypto entries
  result.stochRsi = ti.StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });

  // EMA 50 - trend filter (only long above, only short below)
  result.ema50 = ti.EMA.calculate({ values: closes, period: 50 });

  // OBV - volume trend confirmation (rising OBV = smart money buying)
  result.obv = ti.OBV.calculate({ close: closes, volume: volumes });

  // Raw data
  result.closes = closes;
  result.highs = highs;
  result.lows = lows;
  result.volumes = volumes;
  result.lastPrice = closes[closes.length - 1];
  result.lastVolume = volumes[volumes.length - 1];

  return result;
}

/**
 * Calculate volatility as ATR / price
 */
function getVolatility(indicators) {
  if (!indicators.atr || indicators.atr.length === 0) return 0.02;
  const lastAtr = indicators.atr[indicators.atr.length - 1];
  return lastAtr / indicators.lastPrice;
}

module.exports = { calcIndicators, getVolatility };

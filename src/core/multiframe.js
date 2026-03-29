const ti = require("technicalindicators");
const { getLogger } = require("./logger");

/**
 * MultiframeAnalyzer — computes trading context beyond the base 5m candles.
 *
 * Provides per-pair context used by all strategies:
 *   h1Trend    — 1h EMA20 direction: "up" | "down" | "neutral"
 *   h1Strength — 0-1 score of how strongly price is above/below EMA20 on 1h
 *   vwap       — intraday VWAP from today's 5m candles
 *   priceVsVwap — "above" | "below" | "at"
 *   atrRegime  — "low" | "normal" | "high" based on ATR vs its own 20-period avg
 *   atrRatio   — raw ratio (current ATR / 20-avg ATR)
 *
 * 1h candles are cached for 30 min to avoid hammering the exchange.
 */
class MultiframeAnalyzer {
  constructor(exchange) {
    this.exchange = exchange;
    this._cache = new Map(); // "pair:tf" -> { candles, ts }
    this._ttl   = 1800000;  // 30 min
  }

  /**
   * @param {string} pair
   * @param {Array}  candles5m  — already-fetched 5m candles (200 bars)
   * @param {Object} ind5m      — already-computed indicators for 5m candles
   * @returns {Object} context
   */
  async getContext(pair, candles5m, ind5m) {
    const ctx = {
      h1Trend:    "neutral",
      h1Strength: 0,
      vwap:       0,
      priceVsVwap: "neutral",
      atrRegime:  "normal",
      atrRatio:   1.0,
    };

    await Promise.all([
      this._fill1hTrend(pair, ctx),
      this._fillVwap(candles5m, ctx),
    ]);

    this._fillAtrRegime(ind5m, ctx);

    return ctx;
  }

  // ── 1h trend ─────────────────────────────────────────────────────────────

  async _fill1hTrend(pair, ctx) {
    const log = getLogger();
    try {
      const candles = await this._getCandles(pair, "1h", 30);
      if (!candles || candles.length < 22) return;

      const closes = candles.map(c => c[4]);
      const ema20  = ti.EMA.calculate({ values: closes, period: 20 });
      if (ema20.length < 2) return;

      const price   = closes[closes.length - 1];
      const lastEma = ema20[ema20.length - 1];
      const prevEma = ema20[ema20.length - 2];
      const emaSlope = lastEma - prevEma;          // positive = rising
      const priceDiff = (price - lastEma) / lastEma; // % above/below EMA

      if (price > lastEma && emaSlope > 0) {
        ctx.h1Trend    = "up";
        ctx.h1Strength = Math.min(Math.abs(priceDiff) * 20, 1); // 0-1
      } else if (price < lastEma && emaSlope < 0) {
        ctx.h1Trend    = "down";
        ctx.h1Strength = Math.min(Math.abs(priceDiff) * 20, 1);
      } else {
        ctx.h1Trend    = "neutral";
        ctx.h1Strength = 0;
      }
    } catch (e) {
      log.debug(`[MTF] 1h fetch failed ${pair}: ${e.message}`);
    }
  }

  // ── VWAP (intraday from today's 5m candles) ────────────────────────────

  _fillVwap(candles5m, ctx) {
    const nowMs      = Date.now();
    const dayStartMs = nowMs - (nowMs % 86400000); // midnight UTC

    let cumTPV = 0, cumVol = 0;
    for (const c of candles5m) {
      if (c[0] < dayStartMs) continue;
      const tp  = (c[2] + c[3] + c[4]) / 3; // typical price
      cumTPV += tp * c[5];
      cumVol += c[5];
    }

    if (cumVol === 0) return;

    const vwap = cumTPV / cumVol;
    const lastClose = candles5m[candles5m.length - 1][4];
    const diffPct   = (lastClose - vwap) / vwap;

    ctx.vwap = vwap;
    if (diffPct > 0.001)       ctx.priceVsVwap = "above";
    else if (diffPct < -0.001) ctx.priceVsVwap = "below";
    else                       ctx.priceVsVwap = "at";
  }

  // ── ATR regime ───────────────────────────────────────────────────────────

  _fillAtrRegime(ind5m, ctx) {
    if (!ind5m || !ind5m.atr || ind5m.atr.length < 20) return;

    const recent = ind5m.atr.slice(-20);
    const avg    = recent.reduce((s, v) => s + v, 0) / 20;
    const cur    = recent[recent.length - 1];

    ctx.atrRatio = avg > 0 ? cur / avg : 1.0;

    if      (ctx.atrRatio > 1.8) ctx.atrRegime = "high";
    else if (ctx.atrRatio < 0.6) ctx.atrRegime = "low";
    else                          ctx.atrRegime = "normal";
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  async _getCandles(pair, tf, limit) {
    const key    = `${pair}:${tf}`;
    const cached = this._cache.get(key);
    const now    = Date.now();

    if (cached && (now - cached.ts) < this._ttl) return cached.candles;

    const candles = await this.exchange.fetchOHLCV(pair, tf, limit);
    this._cache.set(key, { candles, ts: now });
    return candles;
  }
}

module.exports = { MultiframeAnalyzer };

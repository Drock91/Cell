const ti = require("technicalindicators");
const { calcIndicators } = require("../strategies/indicators");
const { getLogger } = require("./logger");

/**
 * StrategyOptimizer — live adaptive parameter tuner.
 *
 * After enough closed trades accumulate for a strategy+pair, this runs a
 * mini-backtest over recent candles, testing nearby parameter variations.
 * If a better configuration is found (must beat current by MIN_IMPROVEMENT),
 * it is applied in-place to the live config object — no restart needed.
 *
 * Supports: meanReversion (RSI thresholds + BB period)
 *           momentum (EMA fast/slow periods)
 */

const TRIGGER_EVERY  = 25;    // optimize after every N new closed trades
const MIN_TRADES     = 20;    // don't optimize until at least this many trades
const MIN_IMPROVEMENT = 0.04; // new params must score ≥ 4% better than current
const HOLD_PERIODS   = 8;     // candles forward to evaluate trade outcome
const MIN_SIGNALS    = 4;     // backtest needs at least this many signals to be meaningful

class StrategyOptimizer {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    // "strategy:pair" -> trade count at last optimization run
    this._lastOptimizedAt = new Map();
  }

  /**
   * Call once per cycle per pair (after strategies have run).
   * Internally decides whether enough trades have accumulated to re-optimize.
   */
  async maybeOptimize(strategyName, pair, candles) {
    if (strategyName !== "meanReversion" && strategyName !== "momentum") return;

    const stats = this.db.getStrategyStats(strategyName, pair, 200, MIN_TRADES);
    if (!stats) return;

    const key = `${strategyName}:${pair}`;
    const lastAt = this._lastOptimizedAt.get(key) || 0;
    if (stats.totalTrades - lastAt < TRIGGER_EVERY) return;

    this._lastOptimizedAt.set(key, stats.totalTrades);

    const log = getLogger();
    log.info(`[OPT] Tuning ${strategyName} on ${pair} (${stats.totalTrades} trades)...`);

    try {
      if (strategyName === "meanReversion") {
        this._runMeanReversionOpt(pair, candles);
      } else if (strategyName === "momentum") {
        this._runMomentumOpt(pair, candles);
      }
    } catch (e) {
      log.debug(`[OPT] Error optimizing ${strategyName}/${pair}: ${e.message}`);
    }
  }

  // ── Mean Reversion ─────────────────────────────────────────────────────────

  _runMeanReversionOpt(pair, candles) {
    const log = getLogger();
    const mr = this.config.strategies.meanReversion;
    const baseOversold   = mr.rsiOversold  || 30;
    const baseOverbought = mr.rsiOverbought || 70;
    const baseBbPeriod   = mr.bbPeriod     || 20;

    // Score current params first — new params must beat this
    const currentScore = this._backtestMR(candles, baseOversold, baseOverbought, baseBbPeriod);

    const oversoldRange   = this._range(baseOversold,   5, 15, 45);
    const overboughtRange = this._range(baseOverbought, 5, 55, 85);
    const bbRange         = this._range(baseBbPeriod,   3, 10, 50);

    const threshold = currentScore * (1 + MIN_IMPROVEMENT);
    let bestScore = threshold;
    let bestParams = null;

    for (const os of oversoldRange) {
      for (const ob of overboughtRange) {
        if (os >= ob) continue;
        for (const bb of bbRange) {
          if (os === baseOversold && ob === baseOverbought && bb === baseBbPeriod) continue;
          const score = this._backtestMR(candles, os, ob, bb);
          if (score > bestScore) {
            bestScore = score;
            bestParams = { rsiOversold: os, rsiOverbought: ob, bbPeriod: bb };
          }
        }
      }
    }

    if (!bestParams) {
      log.debug(`[OPT] MR ${pair}: current params still best (score ${currentScore.toFixed(3)})`);
      return;
    }

    const changes = [];
    if (bestParams.rsiOversold  !== baseOversold)   changes.push(`rsiOversold ${baseOversold}→${bestParams.rsiOversold}`);
    if (bestParams.rsiOverbought !== baseOverbought) changes.push(`rsiOverbought ${baseOverbought}→${bestParams.rsiOverbought}`);
    if (bestParams.bbPeriod     !== baseBbPeriod)   changes.push(`bbPeriod ${baseBbPeriod}→${bestParams.bbPeriod}`);

    mr.rsiOversold   = bestParams.rsiOversold;
    mr.rsiOverbought = bestParams.rsiOverbought;
    mr.bbPeriod      = bestParams.bbPeriod;

    log.info(`[OPT] MR ${pair} UPDATED: ${changes.join(", ")} | score ${currentScore.toFixed(3)} → ${bestScore.toFixed(3)}`);
  }

  _backtestMR(candles, rsiOversold, rsiOverbought, bbPeriod) {
    const testCfg = {
      ...this.config,
      strategies: {
        ...this.config.strategies,
        meanReversion: {
          ...this.config.strategies.meanReversion,
          rsiOversold,
          rsiOverbought,
          bbPeriod,
        },
      },
    };

    const ind = calcIndicators(candles, testCfg);
    const bb  = ind.bb;
    const rsi = ind.rsi;
    if (!bb || bb.length < 10 || !rsi || rsi.length < 10) return 0;

    const minLen = Math.min(bb.length, rsi.length);
    let wins = 0, losses = 0;

    for (let i = 1; i < minLen - HOLD_PERIODS; i++) {
      const candleIdx  = candles.length - minLen + i;
      const price      = candles[candleIdx][4];
      const lastBB     = bb[i];
      const lastRsi    = rsi[i];
      const prevRsi    = rsi[i - 1];
      const futurePrice = candles[candleIdx + HOLD_PERIODS][4];

      if (price <= lastBB.lower * 1.003 && lastRsi <= rsiOversold && lastRsi > prevRsi) {
        futurePrice > price ? wins++ : losses++;
      }
      if (price >= lastBB.upper * 0.997 && lastRsi >= rsiOverbought && lastRsi < prevRsi) {
        futurePrice < price ? wins++ : losses++;
      }
    }

    const total = wins + losses;
    if (total < MIN_SIGNALS) return 0;
    // Score = win rate dampened by sample size (avoids overfitting sparse data)
    return (wins / total) * Math.min(total / 15, 1);
  }

  // ── Momentum ──────────────────────────────────────────────────────────────

  _runMomentumOpt(pair, candles) {
    const log = getLogger();
    const mom = this.config.strategies.momentum;
    const baseFast = mom.emaFast || 8;
    const baseSlow = mom.emaSlow || 21;

    const currentScore = this._backtestMOM(candles, baseFast, baseSlow);

    const fastRange = this._range(baseFast, 2, 4,  baseSlow - 3);
    const slowRange = this._range(baseSlow, 3, baseFast + 3, 50);

    const threshold = currentScore * (1 + MIN_IMPROVEMENT);
    let bestScore = threshold;
    let bestParams = null;

    for (const fast of fastRange) {
      for (const slow of slowRange) {
        if (fast >= slow - 2) continue;
        if (fast === baseFast && slow === baseSlow) continue;
        const score = this._backtestMOM(candles, fast, slow);
        if (score > bestScore) {
          bestScore = score;
          bestParams = { emaFast: fast, emaSlow: slow };
        }
      }
    }

    if (!bestParams) {
      log.debug(`[OPT] MOM ${pair}: current params still best (score ${currentScore.toFixed(3)})`);
      return;
    }

    const changes = [];
    if (bestParams.emaFast !== baseFast) changes.push(`emaFast ${baseFast}→${bestParams.emaFast}`);
    if (bestParams.emaSlow !== baseSlow) changes.push(`emaSlow ${baseSlow}→${bestParams.emaSlow}`);

    mom.emaFast = bestParams.emaFast;
    mom.emaSlow = bestParams.emaSlow;

    log.info(`[OPT] MOM ${pair} UPDATED: ${changes.join(", ")} | score ${currentScore.toFixed(3)} → ${bestScore.toFixed(3)}`);
  }

  _backtestMOM(candles, emaFast, emaSlow) {
    const closes = candles.map(c => c[4]);
    if (closes.length < emaSlow + HOLD_PERIODS + 5) return 0;

    const fast = ti.EMA.calculate({ values: closes, period: emaFast });
    const slow = ti.EMA.calculate({ values: closes, period: emaSlow });
    const minLen = Math.min(fast.length, slow.length);
    let wins = 0, losses = 0;

    for (let i = 1; i < minLen - HOLD_PERIODS; i++) {
      const pf = fast[fast.length - minLen + i - 1];
      const cf = fast[fast.length - minLen + i];
      const ps = slow[slow.length - minLen + i - 1];
      const cs = slow[slow.length - minLen + i];

      const bullCross = pf <= ps && cf > cs;
      const bearCross = pf >= ps && cf < cs;

      if (!bullCross && !bearCross) continue;

      const priceIdx = candles.length - minLen + i;
      if (priceIdx + HOLD_PERIODS >= candles.length) continue;
      const entry  = candles[priceIdx][4];
      const future = candles[priceIdx + HOLD_PERIODS][4];

      if (bullCross) { future > entry ? wins++ : losses++; }
      else           { future < entry ? wins++ : losses++; }
    }

    const total = wins + losses;
    if (total < MIN_SIGNALS) return 0;
    return (wins / total) * Math.min(total / 12, 1);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Generate [base-step, base, base+step] clamped to [min, max] */
  _range(base, step, min, max) {
    return [base - step, base, base + step].filter(v => v >= min && v <= max);
  }
}

module.exports = { StrategyOptimizer };

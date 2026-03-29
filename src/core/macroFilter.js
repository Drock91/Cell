const ti = require("technicalindicators");
const { getLogger } = require("./logger");

/**
 * MacroFilter - BTC trend gate for the accumulator strategy.
 *
 * Fetches BTC/USD on a higher timeframe (default 4h) and computes EMA50.
 * If BTC price < EMA50 the macro trend is bearish:
 *   - Accumulator DCA buys are blocked
 *   - Scalp sells are still allowed (take profit on existing bags)
 *   - meanReversion and momentum are unaffected
 *
 * Result is cached for cacheTtlMs (default 30 min) to avoid hammering the API.
 */
class MacroFilter {
  constructor(exchange, config) {
    this.exchange = exchange;
    this.symbol   = (config.macroFilter && config.macroFilter.symbol)   || "BTC/USD";
    this.timeframe = (config.macroFilter && config.macroFilter.timeframe) || "4h";
    this.emaPeriod = (config.macroFilter && config.macroFilter.emaPeriod) || 50;
    this.cacheTtlMs = (config.macroFilter && config.macroFilter.cacheTtlMs) || 1800000; // 30 min

    this._bullish   = true;  // default: assume bullish until first real check
    this._lastCheck = 0;
    this._lastBtcPrice = null;
    this._lastEma      = null;
  }

  /**
   * Returns true if BTC macro trend is bullish (price > EMA50 on 4h).
   * Uses cached result within cacheTtlMs.
   */
  async isBullish() {
    const now = Date.now();
    if (now - this._lastCheck < this.cacheTtlMs) {
      return this._bullish;
    }
    await this._refresh();
    return this._bullish;
  }

  get state() {
    return {
      bullish:  this._bullish,
      btcPrice: this._lastBtcPrice,
      ema:      this._lastEma,
      symbol:   this.symbol,
      timeframe: this.timeframe,
      emaPeriod: this.emaPeriod,
      checkedAt: new Date(this._lastCheck).toISOString(),
    };
  }

  async _refresh() {
    const log = getLogger();
    const needed = this.emaPeriod + 10; // a few extra candles for EMA warmup

    try {
      const candles = await this.exchange.fetchOHLCV(this.symbol, this.timeframe, needed);
      if (!candles || candles.length < this.emaPeriod) {
        log.warn(`[MACRO] Not enough candles for ${this.symbol} ${this.timeframe} — keeping last state`);
        return;
      }

      const closes = candles.map(c => c[4]);
      const ema = ti.EMA.calculate({ values: closes, period: this.emaPeriod });

      const lastPrice = closes[closes.length - 1];
      const lastEma   = ema[ema.length - 1];
      const wasBullish = this._bullish;
      this._bullish     = lastPrice > lastEma;
      this._lastBtcPrice = lastPrice;
      this._lastEma      = lastEma;
      this._lastCheck    = Date.now();

      const pctAbove = ((lastPrice - lastEma) / lastEma * 100).toFixed(2);
      const trend = this._bullish ? "BULLISH" : "BEARISH";

      if (this._bullish !== wasBullish) {
        log.info(
          `[MACRO] Trend flipped to ${trend}: BTC ${lastPrice.toFixed(0)} ` +
          `${this._bullish ? ">" : "<"} EMA${this.emaPeriod}(${this.timeframe}) ${lastEma.toFixed(0)} ` +
          `(${pctAbove}%)`
        );
      } else {
        log.info(
          `[MACRO] BTC ${trend}: ${lastPrice.toFixed(0)} vs EMA${this.emaPeriod} ${lastEma.toFixed(0)} (${pctAbove}%)`
        );
      }
    } catch (e) {
      log.warn(`[MACRO] BTC fetch failed (${e.message}) — keeping last state (${this._bullish ? "bullish" : "bearish"})`);
      // Don't update _lastCheck so the next cycle retries sooner
    }
  }
}

module.exports = { MacroFilter };

const { getLogger } = require("../core/logger");
const { calcIndicators, getVolatility } = require("./indicators");

/**
 * Accumulator Strategy - Builds bags of target tokens over time.
 *
 * Core idea: Buy dips aggressively on priority tokens (XRP, XLM, AXL).
 * Use DCA as baseline, amplify buys when price drops.
 * Scalp small % at peaks to free up capital for next dip.
 */
class AccumulatorStrategy {
  constructor(config, exchange) {
    this.name = "accumulator";
    this.config = config;
    this.exchange = exchange;
    this.accConfig = config.strategies.accumulator;
    this.priorityTokens = (this.accConfig.priority || []).map((t) => t.toUpperCase());

    // Track per-pair state
    this.state = new Map(); // pair -> { recentHigh, avgEntry, totalAccumulated, lastDcaTime }

    // How many pairs have been initialized this session (used to stagger first buys)
    this._initCount = 0;
    // Warmup: no DCA fires in first 5 minutes after engine start
    this._startTime = Date.now();
    this._warmupMs = 60000;
  }

  async analyze(pair, candles, ticker, context = {}) {
    const log = getLogger();
    const indicators = calcIndicators(candles, this.config);
    const price = ticker.last;
    const volatility = getVolatility(indicators);
    const base = pair.split("/")[0]; // e.g., "XRP"
    const dcaInterval = this.accConfig.dcaIntervalMs || 3600000;

    // Get or init state for this pair
    let st = this.state.get(pair);
    if (!st) {
      // Stagger first DCA across pairs: pair 0 waits 1 full interval, pair 1 waits 1.5, etc.
      const stagger = this._initCount * Math.floor(dcaInterval * 0.5);
      st = {
        recentHigh: price,
        avgEntry: 0,
        totalAccumulated: 0,
        lastDcaTime: Date.now() + stagger, // future timestamp = must wait full interval + stagger
        totalSpent: 0,
      };
      this._initCount++;
      this.state.set(pair, st);
    }

    // After a restart the saved lastDcaTime may be stale (bot was offline for hours).
    // Clamp ONCE so it fires within one interval of restart rather than waiting a full
    // extra interval. The _restartClamped flag prevents re-clamping every cycle which
    // would freeze the timer permanently at (now - 95%) and prevent DCA from ever firing.
    if (!st._restartClamped) {
      const maxElapsed = dcaInterval * 0.95;
      const earliestAllowed = Date.now() - maxElapsed;
      if (st.lastDcaTime < earliestAllowed) {
        st.lastDcaTime = earliestAllowed;
      }
      st._restartClamped = true;
    }

    // Update recent high (rolling 200-candle high)
    const highs = candles.map((c) => c[2]);
    st.recentHigh = Math.max(...highs.slice(-100));

    const rsi = indicators.rsi;
    const lastRsi = rsi && rsi.length > 0 ? rsi[rsi.length - 1] : 50;
    const isPriority = this.priorityTokens.includes(base);

    // Calculate dip depth from recent high
    const dipPct = (st.recentHigh - price) / st.recentHigh;

    // --- DCA MODE: Time-based buys ---
    const now = Date.now();
    const timeSinceLastDca = now - st.lastDcaTime;

    // Warmup: don't DCA in the first 5 minutes after engine start
    if (now - this._startTime < this._warmupMs) {
      return null;
    }

    if (timeSinceLastDca >= dcaInterval) {
      // Per-pair override, otherwise fall back to global dcaBasePct
      const perPairCfg = (this.accConfig.perPair || {})[base] || {};
      let sizePct = perPairCfg.dcaBasePct || this.accConfig.dcaBasePct || 0.02;
      let confidence = 0.60;
      let reason = `DCA buy ${base}`;

      // Value gate: when 1h trend is strongly down and no dip detected yet,
      // wait for a small value confirmation before deploying.
      // This prevents mindlessly buying into a sustained flush.
      const h1Trend = context.h1Trend || "neutral";
      const atrRegime = context.atrRegime || "normal";
      if (h1Trend === "down" && dipPct < (this.accConfig.dipThresholdPct || 0.03)) {
        // In a downtrend without a meaningful dip, reduce size only — DCA must still fire
        // (reducing confidence below minConfidence would silently block the trade entirely)
        sizePct *= 0.50;
        reason += " (cautious: 1h down)";
      }

      // In high-volatility regime, dips are noisier — don't amplify as aggressively
      const dipMultiplierAdj = atrRegime === "high" ? 0.75 : 1.0;

      // Amplify on dips (adjusted down in high-volatility regimes)
      if (dipPct >= (this.accConfig.bigDipThresholdPct || 0.07)) {
        sizePct *= (this.accConfig.bigDipMultiplier || 4.0) * dipMultiplierAdj;
        confidence = 0.90;
        reason = `BIG DIP BUY ${base} (${(dipPct * 100).toFixed(1)}% off high)`;
        if (atrRegime === "high") reason += " [vol-adj]";
        log.info(`ACCUMULATOR: ${reason} - loading up!`);
      } else if (dipPct >= (this.accConfig.dipThresholdPct || 0.03)) {
        sizePct *= (this.accConfig.dipMultiplier || 2.5) * dipMultiplierAdj;
        confidence = 0.78;
        reason = `Dip buy ${base} (${(dipPct * 100).toFixed(1)}% off high)`;
        if (atrRegime === "high") reason += " [vol-adj]";
      }

      // Priority tokens get 50% bigger allocation
      if (isPriority) {
        sizePct *= 1.5;
        confidence += 0.05;
        reason += " [PRIORITY]";
      }

      // RSI-weighted: load up harder at real extremes
      if (lastRsi < 20) {
        sizePct *= 2.0;
        confidence += 0.12;
        reason += " RSI extreme";
      } else if (lastRsi < 30) {
        sizePct *= 1.5;
        confidence += 0.08;
        reason += " RSI oversold";
      } else if (lastRsi < 40) {
        sizePct *= 1.2;
        confidence += 0.04;
        reason += " RSI low";
      }

      st.lastDcaTime = now;

      return {
        pair,
        side: "buy",
        price,
        strategy: this.name,
        confidence: Math.min(confidence, 0.95),
        volatility,
        winRate: 0.62,
        sizePctOverride: sizePct,
        reason,
        accumulate: true,
      };
    }

    // --- SCALP MODE: Sell small % at peaks to recycle capital ---
    if (
      this.accConfig.scalpEnabled &&
      st.totalAccumulated > 0 &&
      st.avgEntry > 0
    ) {
      const gainPct = (price - st.avgEntry) / st.avgEntry;
      const peakThreshold = this.accConfig.scalpPeakThresholdPct || 0.05;

      // StochRSI overbought confirmation for scalp trigger
      const stochRsi = indicators.stochRsi;
      const stochK = stochRsi && stochRsi.length > 0
        ? stochRsi[stochRsi.length - 1].k
        : 50;
      const stochOverbought = stochK > 75;

      const shouldScalp = gainPct >= peakThreshold && (lastRsi > 52 || stochOverbought);
      if (shouldScalp) {
        const sellPct   = this.accConfig.scalpSellPct || 0.15;
        const available = this.exchange.getFree(base);
        const maxSell   = Math.min(st.totalAccumulated, available);
        const sellAmount = maxSell * sellPct;
        if (sellAmount * price < 1) return null;  // nothing worth selling

        return {
          pair,
          side: "sell",
          price,
          strategy: this.name,
          confidence: stochOverbought ? 0.78 : 0.70,
          volatility,
          winRate: 0.66,
          amount: sellAmount,
          reason: `Scalp sell ${(sellPct * 100).toFixed(0)}% of ${base} at ${(gainPct * 100).toFixed(1)}% gain${stochOverbought ? " StochRSI overbought" : ""}`,
        };
      }
    }

    return null;
  }

  // Called by engine after a successful accumulator buy
  recordAccumulation(pair, amount, price) {
    const st = this.state.get(pair);
    if (!st) return;

    const totalCost = st.avgEntry * st.totalAccumulated + price * amount;
    st.totalAccumulated += amount;
    st.avgEntry = st.totalAccumulated > 0 ? totalCost / st.totalAccumulated : price;
    st.totalSpent += price * amount;
  }

  // Called by engine after a scalp sell
  recordScalpSell(pair, amount) {
    const st = this.state.get(pair);
    if (!st) return;
    st.totalAccumulated = Math.max(0, st.totalAccumulated - amount);
  }

  getHoldings() {
    const holdings = {};
    for (const [pair, st] of this.state) {
      if (st.totalAccumulated > 0) {
        const base = pair.split("/")[0];
        holdings[base] = {
          pair,
          amount: st.totalAccumulated,
          avgEntry: st.avgEntry,
          totalSpent: st.totalSpent,
        };
      }
    }
    return holdings;
  }
}

module.exports = { AccumulatorStrategy };

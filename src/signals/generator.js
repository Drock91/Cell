const { getLogger } = require("../core/logger");

class SignalGenerator {
  constructor(config) {
    this.config = config;
    this.signals = [];
    this.subscribers = []; // callback functions
  }

  record(signal) {
    const enriched = {
      ...signal,
      timestamp: new Date().toISOString(),
      id: `${signal.strategy}-${signal.pair}-${Date.now()}`,
    };
    this.signals.push(enriched);

    // Keep last 1000 signals
    if (this.signals.length > 1000) {
      this.signals = this.signals.slice(-1000);
    }

    // Notify subscribers
    for (const cb of this.subscribers) {
      try {
        cb(enriched);
      } catch (e) {
        getLogger().error(`Signal subscriber error: ${e.message}`);
      }
    }

    return enriched;
  }

  subscribe(callback) {
    this.subscribers.push(callback);
  }

  getRecent(count = 20) {
    return this.signals.slice(-count);
  }

  getByPair(pair) {
    return this.signals.filter((s) => s.pair === pair);
  }

  getStats() {
    const total = this.signals.length;
    const byStrategy = {};
    const byPair = {};
    const bySide = { buy: 0, sell: 0 };

    for (const s of this.signals) {
      byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
      byPair[s.pair] = (byPair[s.pair] || 0) + 1;
      bySide[s.side] = (bySide[s.side] || 0) + 1;
    }

    const avgConfidence =
      total > 0
        ? this.signals.reduce((sum, s) => sum + s.confidence, 0) / total
        : 0;

    return { total, byStrategy, byPair, bySide, avgConfidence };
  }
}

module.exports = { SignalGenerator };

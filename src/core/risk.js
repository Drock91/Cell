const { getLogger } = require("./logger");

class RiskManager {
  constructor(config, portfolio) {
    this.config = config;
    this.portfolio = portfolio;
    this._halted = false;
    this._haltReason = "";
  }

  canTrade() {
    if (this._halted) return false;

    const log = getLogger();

    // Check daily loss limit against total portfolio (bags + staking + USDT all included)
    // Using total avoids false triggers from bag price swings or staking moves
    if (this.portfolio.dailyStartValue > 5) {
      const dailyLoss = (this.portfolio.dailyStartValue - this.portfolio.totalValue) / this.portfolio.dailyStartValue;
      if (dailyLoss >= this.config.risk.maxDailyLossPct) {
        this._halt(`Daily loss limit hit: ${(dailyLoss * 100).toFixed(1)}%`);
        return false;
      }
    }

    // Check max drawdown (trading capital only)
    if (this.portfolio.drawdown >= this.config.risk.maxDrawdownPct) {
      this._halt(
        `Max drawdown hit: ${(this.portfolio.drawdown * 100).toFixed(1)}%`
      );
      return false;
    }

    // Auto-resume if previously halted but conditions have recovered
    if (this._halted) {
      this.resume();
    }

    return true;
  }

  approveTrade(signal) {
    // Accumulator buys are allowed even during risk halts — DCA into dips is the point.
    // The engine already gates these on free cash, so no runaway risk.
    if (signal.accumulate && signal.side === "buy") {
      return true;
    }

    if (!this.canTrade()) return false;

    if (signal.accumulate) {
      // Accumulator scalp sells — only if we can trade
      return true;
    }

    const nonAccumPositions = this.portfolio.openPositions.filter(p => !p.accumulate);
    if (nonAccumPositions.length >= this.config.trading.maxOpenPositions) {
      return false;
    }

    const exists = nonAccumPositions.some(
      (p) => p.pair === signal.pair && p.side === signal.side
    );
    if (exists) return false;

    return true;
  }

  calculatePositionSize(signal) {
    const method = this.config.risk.positionSizing;
    const capital = this.portfolio.totalValue;
    const price = signal.price;

    let sizeUsd;

    switch (method) {
      case "kelly":
        sizeUsd = this._kellySize(signal, capital);
        break;
      case "volatility":
        sizeUsd = this._volatilitySize(signal, capital);
        break;
      default:
        sizeUsd = capital * this.config.trading.maxPositionPct;
    }

    // Confidence scaling: bet more when conviction is high, less when borderline
    // Maps: 0.55 → 0.84×, 0.70 → 0.96×, 0.80 → 1.04×, 0.95 → 1.16×
    if (signal.confidence) {
      sizeUsd *= 0.40 + signal.confidence * 0.80;
    }

    // Volatility regime adjustment: reduce size in high-ATR environments
    if (signal.atrRegime === "high") {
      sizeUsd *= 0.70;
    } else if (signal.atrRegime === "low") {
      sizeUsd *= 1.15;
    }

    // Correlation discount: crypto moves together. Each additional open
    // non-accumulate position reduces size by 8% to avoid over-concentration.
    const openNonAccum = this.portfolio.openPositions.filter(p => !p.accumulate).length;
    if (openNonAccum >= 2) {
      const discount = Math.pow(0.92, openNonAccum - 1);
      sizeUsd *= discount;
    }

    // Cap at max
    const maxUsd = capital * this.config.trading.maxPositionPct;
    sizeUsd = Math.min(sizeUsd, maxUsd);

    // Keep 5% buffer
    sizeUsd = Math.min(sizeUsd, capital * 0.95);

    if (sizeUsd <= 0) return 0;
    return sizeUsd / price;
  }

  _kellySize(signal, capital) {
    const winRate = signal.winRate || 0.5;

    // Use actual signal SL/TP distances when available (ATR-based stops)
    // Falls back to config percentages if signal doesn't specify levels
    let b;
    if (signal.stopLoss && signal.takeProfit && signal.price) {
      const slDist = Math.abs(signal.price - signal.stopLoss);
      const tpDist = Math.abs(signal.takeProfit - signal.price);
      b = slDist > 0 ? tpDist / slDist : 2.5;
    } else {
      b = this.config.trading.takeProfitPct / this.config.trading.stopLossPct;
    }

    const p = winRate;
    const q = 1 - p;
    const kelly = (b * p - q) / b;

    if (kelly <= 0) return 0;
    return capital * kelly * this.config.risk.kellyFraction;
  }

  _volatilitySize(signal, capital) {
    const volatility = signal.volatility || 0.02;
    const targetRisk = 0.01;

    if (volatility <= 0) return capital * 0.1;
    const positionPct = targetRisk / volatility;
    return capital * Math.min(positionPct, this.config.trading.maxPositionPct);
  }

  _halt(reason) {
    this._halted = true;
    this._haltReason = reason;
    getLogger().warn(`TRADING HALTED: ${reason}`);
  }

  resume() {
    this._halted = false;
    this._haltReason = "";
    getLogger().info("Trading resumed");
  }

  get isHalted() {
    return this._halted;
  }

  get haltReason() {
    return this._haltReason;
  }
}

module.exports = { RiskManager };

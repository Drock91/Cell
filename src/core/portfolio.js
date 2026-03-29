const { getLogger } = require("./logger");

class Portfolio {
  constructor(config) {
    this.config = config;
    this.openPositions = [];
    this.tradeHistory = [];
    this.totalValue = 0;
    this.peakValue = 0;
    this.dailyStartValue = 0;
    this.currentPrices = new Map();
    this._bagValue    = 0;   // mark-to-market value of accumulator bags
    this._stakedValue = 0;   // USDT currently in Kraken Earn (still ours, just staked)
    this._sessionStart = 0;  // totalValue at session start; basis for PnL
  }

  async initialize(exchange, quoteAsset) {
    this.quoteAssets = ["RLUSD", "USDT", "USD", "BUSD"];
    if (quoteAsset) {
      // Put preferred quote asset first
      this.quoteAssets = [quoteAsset, ...this.quoteAssets.filter((a) => a !== quoteAsset)];
    }

    await exchange.refreshBalance();
    const balance = this._getTotalQuoteBalance(exchange);
    this.totalValue = balance;
    this.peakValue = balance;
    this.dailyStartValue = balance;
    getLogger().info(`Portfolio initialized: $${balance.toFixed(2)} (${this.quoteAssets[0]})`);
  }

  _getTotalQuoteBalance(exchange) {
    let total = 0;
    for (const asset of this.quoteAssets) {
      total += exchange.getFree(asset);
    }
    return total;
  }

  async update(exchange) {
    await exchange.refreshBalance();
    let total = this._getTotalQuoteBalance(exchange);

    for (const pos of this.openPositions) {
      try {
        const ticker = await exchange.fetchTicker(pos.pair);
        const price = ticker.last || 0;
        this.currentPrices.set(pos.pair, price);
        if (pos.side === "buy") {
          total += pos.amount * price;
        }
      } catch (e) {
        // use last known price
      }
    }

    // Include accumulator bag value (set by engine each cycle from live prices)
    total += this._bagValue;

    // Include staked USDT — still ours, just earning yield in Kraken Earn
    total += this._stakedValue;

    this.totalValue = total;
    if (total > this.peakValue) {
      this.peakValue = total;
    }
  }

  /** Called by engine each cycle with current mark-to-market bag value. */
  setBagValue(val) { this._bagValue = val || 0; }

  /** Called by engine each cycle with current Kraken Earn staked amount. */
  setStakedValue(val) { this._stakedValue = val || 0; }

  /**
   * Recalibrate baseline after bags are synced on startup.
   * Resets peak and daily-start to real current value so drawdown/PnL
   * are measured from the actual portfolio state, not config.startingCapital.
   */
  recalibrate() {
    this.peakValue       = this.totalValue;
    this.dailyStartValue = this.totalValue;
    this._sessionStart   = this.totalValue;
  }

  get unrealizedPnl() {
    // Use session-start value as baseline; falls back to config if not yet set
    const base = this._sessionStart > 0 ? this._sessionStart : this.config.startingCapital;
    return this.totalValue - base;
  }

  get realizedPnl() {
    return this.tradeHistory.reduce((sum, t) => sum + t.pnl, 0);
  }

  /**
   * Trading capital only — excludes accumulator bags.
   * Used for risk checks so bag price swings don't trigger halts.
   */
  /**
   * Free-to-trade capital only: excludes bags and staked USDT.
   * Used for risk checks so bag swings and staking don't trigger halts.
   */
  get tradingValue() {
    return Math.max(0, this.totalValue - this._bagValue - this._stakedValue);
  }

  get drawdown() {
    if (this.peakValue <= 0) return 0;
    return Math.max(0, (this.peakValue - this.totalValue) / this.peakValue);
  }

  get dailyPnl() {
    return this.totalValue - this.dailyStartValue;
  }

  get winRate() {
    if (this.tradeHistory.length === 0) return 0;
    const wins = this.tradeHistory.filter((t) => t.pnl > 0).length;
    return wins / this.tradeHistory.length;
  }

  getCurrentPrice(pair) {
    return this.currentPrices.get(pair) || 0;
  }

  recordOrder(order, signal) {
    const pos = {
      pair: signal.pair,
      side: signal.side,
      entryPrice: signal.price,
      amount: order.amount || signal.amount || 0,
      strategy: signal.strategy,
      openedAt: new Date(),
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      orderId: order.id,
      accumulate: !!signal.accumulate,
      trailingHigh: signal.side === "buy" ? signal.price : null,
      trailingLow: signal.side === "sell" ? signal.price : null,
    };
    this.openPositions.push(pos);
    getLogger().info(
      `Position opened: ${pos.side} ${pos.amount} ${pos.pair} @ ${pos.entryPrice}`
    );
  }

  closePosition(position, exitPrice) {
    const pnl =
      position.side === "buy"
        ? (exitPrice - position.entryPrice) * position.amount
        : (position.entryPrice - exitPrice) * position.amount;

    const trade = {
      pair: position.pair,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      amount: position.amount,
      strategy: position.strategy,
      pnl,
      timestamp: new Date(),
    };

    this.tradeHistory.push(trade);
    this.openPositions = this.openPositions.filter((p) => p !== position);
    getLogger().info(
      `Position closed: ${position.pair} PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
    );
    return trade;
  }

  resetDaily() {
    this.dailyStartValue = this.totalValue;
  }

  summary() {
    return {
      totalValue: this.totalValue,
      startingCapital: this.config.startingCapital,
      unrealizedPnl: this.unrealizedPnl,
      realizedPnl: this.realizedPnl,
      drawdown: this.drawdown,
      openPositions: this.openPositions.length,
      totalTrades: this.tradeHistory.length,
      winRate: this.winRate,
    };
  }
}

module.exports = { Portfolio };

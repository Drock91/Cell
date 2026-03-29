const { getLogger } = require("../core/logger");
const { calcIndicators, getVolatility } = require("./indicators");

class GridStrategy {
  constructor(config, exchange) {
    this.name = "grid";
    this.config = config;
    this.exchange = exchange;
    this.gridConfig = config.strategies.grid;
    this.activeGrids = new Map(); // pair -> grid state
  }

  async analyze(pair, candles, ticker) {
    const log = getLogger();
    const indicators = calcIndicators(candles, this.config);
    const price = ticker.last;
    const volatility = getVolatility(indicators);

    // Get or create grid for this pair
    let grid = this.activeGrids.get(pair);
    if (!grid || this._shouldResetGrid(grid, price)) {
      grid = this._createGrid(price);
      this.activeGrids.set(pair, grid);
      log.info(`Grid created for ${pair}: ${grid.levels.length} levels around $${price.toFixed(2)}`);
    }

    // Find which grid level we're at
    const signal = this._findSignal(pair, price, grid, indicators, volatility);
    return signal;
  }

  _createGrid(centerPrice) {
    const levels = [];
    const spacing = this.gridConfig.spacingPct;
    const numLevels = this.gridConfig.levels;
    const halfLevels = Math.floor(numLevels / 2);

    for (let i = -halfLevels; i <= halfLevels; i++) {
      const levelPrice = centerPrice * (1 + i * spacing);
      levels.push({
        price: levelPrice,
        side: i < 0 ? "buy" : "sell",
        filled: false,
      });
    }

    return {
      centerPrice,
      levels,
      createdAt: Date.now(),
    };
  }

  _shouldResetGrid(grid, currentPrice) {
    // Reset if price moved more than 5% from grid center
    const drift = Math.abs(currentPrice - grid.centerPrice) / grid.centerPrice;
    return drift > 0.05;
  }

  _findSignal(pair, price, grid, indicators, volatility) {
    const rsi = indicators.rsi;
    const lastRsi = rsi && rsi.length > 0 ? rsi[rsi.length - 1] : 50;

    // Find the nearest unfilled grid level
    let bestLevel = null;
    let bestDistance = Infinity;

    for (const level of grid.levels) {
      if (level.filled) continue;
      const distance = Math.abs(price - level.price) / price;

      // Price must be within 0.15% of a grid level to trigger
      if (distance < 0.0015 && distance < bestDistance) {
        bestDistance = distance;
        bestLevel = level;
      }
    }

    if (!bestLevel) return null;

    // Use RSI to confirm direction
    let confidence = 0.6;
    if (bestLevel.side === "buy" && lastRsi < 40) confidence += 0.15;
    if (bestLevel.side === "sell" && lastRsi > 60) confidence += 0.15;

    // Mark level as filled
    bestLevel.filled = true;

    const stopLoss =
      bestLevel.side === "buy"
        ? price * (1 - this.config.trading.stopLossPct)
        : price * (1 + this.config.trading.stopLossPct);

    const takeProfit =
      bestLevel.side === "buy"
        ? price * (1 + this.config.trading.takeProfitPct)
        : price * (1 - this.config.trading.takeProfitPct);

    return {
      pair,
      side: bestLevel.side,
      price,
      strategy: this.name,
      confidence,
      volatility,
      winRate: 0.55,
      stopLoss,
      takeProfit,
      reason: `Grid level ${bestLevel.side} @ $${bestLevel.price.toFixed(2)}`,
    };
  }
}

module.exports = { GridStrategy };

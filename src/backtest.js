/**
 * Cell Backtester - Test strategies against historical data
 * Run: node src/backtest.js
 */
const ccxt = require("ccxt");
const { loadConfig } = require("./core/config");
const { initLogger, getLogger } = require("./core/logger");
const { calcIndicators, getVolatility } = require("./strategies/indicators");
const { GridStrategy } = require("./strategies/grid");
const { MeanReversionStrategy } = require("./strategies/meanReversion");
const { MomentumStrategy } = require("./strategies/momentum");
const { AccumulatorStrategy } = require("./strategies/accumulator");
const chalk = require("chalk");

class Backtester {
  constructor(config) {
    this.config = config;
    this.capital = config.startingCapital;
    this.startCapital = config.startingCapital;
    this.positions = [];
    this.trades = [];
    this.peakCapital = config.startingCapital;
    this.maxDrawdown = 0;
  }

  async run() {
    const log = getLogger();
    log.info("=== CELL BACKTESTER ===");

    // Use public exchange (no API key needed for historical data)
    // Try multiple exchanges in case one is geo-blocked
    const exchangeOptions = ["kraken", "coinbase", "binanceus", "bitfinex"];
    let exchange = null;

    for (const name of exchangeOptions) {
      try {
        const ExClass = ccxt[name];
        if (!ExClass) continue;
        const ex = new ExClass({ enableRateLimit: true });
        await ex.loadMarkets();
        exchange = ex;
        log.info(`Using ${name} for historical data`);
        break;
      } catch (e) {
        log.warn(`${name} unavailable: ${e.message.slice(0, 80)}`);
      }
    }

    if (!exchange) {
      log.error("No exchange available for backtesting");
      return;
    }

    // Build list of pairs, using fallbacks if needed
    const allPairs = [...this.config.trading.pairs];
    const fb1 = this.config.trading.fallbackPairs || [];
    const fb2 = this.config.trading.fallbackPairs2 || [];

    const tradePairs = [];
    for (let i = 0; i < allPairs.length; i++) {
      const candidates = [allPairs[i]];
      if (fb1[i]) candidates.push(fb1[i]);
      if (fb2[i]) candidates.push(fb2[i]);

      let found = false;
      for (const pair of candidates) {
        if (exchange.markets[pair]) {
          tradePairs.push(pair);
          if (pair !== allPairs[i]) log.info(`Using ${pair} instead of ${allPairs[i]}`);
          found = true;
          break;
        }
      }
      if (!found) {
        log.warn(`${allPairs[i].split("/")[0]} not available on ${exchange.id}, skipping`);
      }
    }

    for (const pair of tradePairs) {
      log.info(`\nBacktesting ${pair}...`);
      await this._backtestPair(exchange, pair);
    }

    await exchange.close();
    this._printResults();
  }

  async _backtestPair(exchange, pair) {
    const log = getLogger();
    const tf = this.config.trading.timeframe;

    // Fetch 1000 candles of historical data
    let candles;
    try {
      candles = await exchange.fetchOHLCV(pair, tf, undefined, 1000);
    } catch (e) {
      log.error(`Failed to fetch data for ${pair}: ${e.message}`);
      return;
    }

    log.info(`Got ${candles.length} candles for ${pair}`);

    // Initialize strategies with mock exchange
    const mockExchange = { fetchOHLCV: async () => [], fetchTicker: async () => ({}) };
    const strategies = [];

    if (this.config.strategies.grid.enabled) {
      strategies.push(new GridStrategy(this.config, mockExchange));
    }
    if (this.config.strategies.meanReversion.enabled) {
      strategies.push(new MeanReversionStrategy(this.config, mockExchange));
    }
    if (this.config.strategies.momentum.enabled) {
      strategies.push(new MomentumStrategy(this.config, mockExchange));
    }
    if (this.config.strategies.accumulator && this.config.strategies.accumulator.enabled) {
      strategies.push(new AccumulatorStrategy(this.config, mockExchange));
    }

    // Walk forward through candles
    const lookback = 200;
    for (let i = lookback; i < candles.length; i++) {
      const window = candles.slice(i - lookback, i);
      const current = candles[i];
      const ticker = { last: current[4], bid: current[4] * 0.999, ask: current[4] * 1.001 };

      // Check stops on existing positions
      this._checkPositionExits(current);

      // Run strategies
      for (const strategy of strategies) {
        const signal = await strategy.analyze(pair, window, ticker);

        if (signal && signal.confidence >= this.config.signals.minConfidence) {
          this._simulateTrade(signal);
        }
      }

      // Track drawdown
      const totalValue = this._calcTotalValue(current[4]);
      if (totalValue > this.peakCapital) this.peakCapital = totalValue;
      const dd = (this.peakCapital - totalValue) / this.peakCapital;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    }

    // Close remaining positions at last price
    const lastPrice = candles[candles.length - 1][4];
    for (const pos of [...this.positions]) {
      this._closePosition(pos, lastPrice, "end of backtest");
    }
  }

  _simulateTrade(signal) {
    // Check max positions (accumulator buys can stack)
    const isAccumBuy = signal.strategy === "accumulator" && signal.side === "buy";
    if (!isAccumBuy && this.positions.length >= this.config.trading.maxOpenPositions) return;

    // Check existing position (accumulator can add to position)
    if (!isAccumBuy && this.positions.some((p) => p.pair === signal.pair && p.side === signal.side)) return;

    // Calculate size - accumulator can override
    let sizeUsd;
    if (signal.sizePctOverride) {
      sizeUsd = Math.min(this.capital * signal.sizePctOverride, this.capital * 0.95);
    } else if (signal.amount) {
      sizeUsd = signal.amount * signal.price;
    } else {
      const maxPct = this.config.trading.maxPositionPct;
      sizeUsd = Math.min(this.capital * maxPct, this.capital * 0.95);
    }
    if (sizeUsd <= 1) return;

    const amount = sizeUsd / signal.price;
    const fee = sizeUsd * 0.001; // 0.1% trading fee

    this.capital -= sizeUsd + fee;
    this.positions.push({
      pair: signal.pair,
      side: signal.side,
      entryPrice: signal.price,
      amount,
      strategy: signal.strategy,
      stopLoss: signal.accumulate ? undefined : signal.stopLoss,
      takeProfit: signal.accumulate ? undefined : signal.takeProfit,
      fee,
      accumulate: signal.accumulate || false,
    });
  }

  _checkPositionExits(candle) {
    const high = candle[2];
    const low = candle[3];

    for (const pos of [...this.positions]) {
      if (pos.side === "buy") {
        if (pos.stopLoss && low <= pos.stopLoss) {
          this._closePosition(pos, pos.stopLoss, "stop loss");
        } else if (pos.takeProfit && high >= pos.takeProfit) {
          this._closePosition(pos, pos.takeProfit, "take profit");
        }
      } else {
        if (pos.stopLoss && high >= pos.stopLoss) {
          this._closePosition(pos, pos.stopLoss, "stop loss");
        } else if (pos.takeProfit && low <= pos.takeProfit) {
          this._closePosition(pos, pos.takeProfit, "take profit");
        }
      }
    }
  }

  _closePosition(pos, exitPrice, reason) {
    const pnl =
      pos.side === "buy"
        ? (exitPrice - pos.entryPrice) * pos.amount
        : (pos.entryPrice - exitPrice) * pos.amount;

    const exitFee = exitPrice * pos.amount * 0.001;
    const netPnl = pnl - exitFee;

    this.capital += exitPrice * pos.amount - exitFee;
    this.positions = this.positions.filter((p) => p !== pos);

    this.trades.push({
      pair: pos.pair,
      side: pos.side,
      entry: pos.entryPrice,
      exit: exitPrice,
      amount: pos.amount,
      strategy: pos.strategy,
      pnl: netPnl,
      reason,
    });
  }

  _calcTotalValue(currentPrice) {
    let total = this.capital;
    for (const pos of this.positions) {
      total += pos.amount * currentPrice;
    }
    return total;
  }

  _printResults() {
    const wins = this.trades.filter((t) => t.pnl > 0);
    const losses = this.trades.filter((t) => t.pnl <= 0);
    const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = this.trades.length > 0 ? wins.length / this.trades.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;
    const returnPct = (totalPnl / this.startCapital) * 100;

    console.log("\n" + chalk.bold.cyan("═══════════════════════════════════════"));
    console.log(chalk.bold.cyan("         CELL BACKTEST RESULTS          "));
    console.log(chalk.bold.cyan("═══════════════════════════════════════"));
    console.log(`Starting Capital:  $${this.startCapital.toFixed(2)}`);
    console.log(`Final Capital:     $${this.capital.toFixed(2)}`);
    const pnlStr = `$${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} (${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}%)`;
    console.log(`Total PnL:         ${totalPnl >= 0 ? chalk.green(pnlStr) : chalk.red(pnlStr)}`);
    console.log(`Max Drawdown:      ${chalk.yellow((this.maxDrawdown * 100).toFixed(1) + "%")}`);
    console.log(`Total Trades:      ${this.trades.length}`);
    console.log(`Win Rate:          ${(winRate * 100).toFixed(1)}%`);
    console.log(`Avg Win:           ${chalk.green("$" + avgWin.toFixed(2))}`);
    console.log(`Avg Loss:          ${chalk.red("$" + avgLoss.toFixed(2))}`);
    console.log(`Profit Factor:     ${profitFactor.toFixed(2)}`);
    console.log(chalk.bold.cyan("═══════════════════════════════════════"));

    // Strategy breakdown
    const byStrategy = {};
    for (const t of this.trades) {
      if (!byStrategy[t.strategy]) {
        byStrategy[t.strategy] = { trades: 0, pnl: 0, wins: 0 };
      }
      byStrategy[t.strategy].trades++;
      byStrategy[t.strategy].pnl += t.pnl;
      if (t.pnl > 0) byStrategy[t.strategy].wins++;
    }

    console.log(chalk.bold("\nStrategy Breakdown:"));
    for (const [name, stats] of Object.entries(byStrategy)) {
      const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(0) : 0;
      console.log(
        `  ${name.padEnd(15)} ${stats.trades} trades | ` +
        `PnL: $${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)} | ` +
        `Win Rate: ${wr}%`
      );
    }
  }
}

async function main() {
  const config = loadConfig();
  initLogger(config.logging.level, config.logging.file);

  const bt = new Backtester(config);
  await bt.run();
}

main().catch(console.error);

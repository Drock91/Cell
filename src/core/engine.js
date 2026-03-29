const { loadConfig } = require("./config");
const { initLogger, getLogger } = require("./logger");
const { ExchangeManager } = require("./exchange");
const { PaperExchange } = require("./paperExchange");
const { FuturesExchange } = require("./futuresExchange");
const { KrakenEarn } = require("./krakenEarn");
const { CapitalRouter } = require("./capitalRouter");
const { Safeguards } = require("./safeguards");
const { Portfolio } = require("./portfolio");
const { RiskManager } = require("./risk");
const { MacroFilter } = require("./macroFilter");
const { MultiframeAnalyzer } = require("./multiframe");
const { StrategyOptimizer } = require("./optimizer");
const { calcIndicators } = require("../strategies/indicators");
const { GridStrategy } = require("../strategies/grid");
const { MeanReversionStrategy } = require("../strategies/meanReversion");
const { MomentumStrategy } = require("../strategies/momentum");
const { AccumulatorStrategy } = require("../strategies/accumulator");
const { SignalGenerator } = require("../signals/generator");
const { TradeDB } = require("../utils/db");
const { writeSummary } = require("../utils/summary");

class CellEngine {
  constructor(configPath) {
    this.config = loadConfig(configPath);
    initLogger(this.config.logging.level, this.config.logging.file);

    const realExchange = new ExchangeManager(this.config);
    const isPaper = this.config.mode === "paper";
    this.exchange = isPaper
      ? new PaperExchange(realExchange, this.config.startingCapital * (1 - (this.config.futures?.capitalPct || 0)))
      : realExchange;
    this.isPaper = isPaper;
    this.exchange2 = null;
    this.portfolio = new Portfolio(this.config);
    this.risk = new RiskManager(this.config, this.portfolio);
    this.signalGen = new SignalGenerator(this.config);
    const dbFile = isPaper ? "data/paper.db" : "data/live.db";
    this.db = new TradeDB(dbFile);
    this.minOrderUsd = this.config.trading.minOrderUsd || 1.0;
    this.strategies = [];
    this.accumulator = null;

    // Map pair -> which exchange to use
    this.pairExchangeMap = new Map();
    this.allPairs = [];
    this.running = false;
    this._cycleCount = 0;
    this._consecutiveNetworkErrors = 0;

    // Macro filter (optional — only when config.macroFilter.enabled)
    const mfCfg = this.config.macroFilter;
    this.macroFilter = (mfCfg && mfCfg.enabled)
      ? new MacroFilter(realExchange, this.config)
      : null;

    // Multi-timeframe analyzer — always active (uses real exchange for 1h candles)
    this.mtf = new MultiframeAnalyzer(realExchange);

    // Adaptive parameter optimizer — tunes strategy params from real trade history
    this.optimizer = new StrategyOptimizer(this.config, this.db);

    // ── Kraken Earn staking (always on when configured, independent of futures) ──
    const stakingEnabled = !!(this.config.staking && this.config.staking.enabled);
    this.krakenEarn = stakingEnabled
      ? new KrakenEarn(isPaper ? null : realExchange.exchange, isPaper, isPaper ? this.exchange : null)
      : null;

    // ── Snowball: futures sub-account ──────────────────────────────────────
    const fc = this.config.futures;
    this.futuresEnabled = !!(fc && fc.enabled);

    if (this.futuresEnabled) {
      this.futuresExchange = new FuturesExchange(this.config, isPaper);
      // Paper mode: futures uses spot real exchange for market data
      if (isPaper) this.futuresExchange._spotRef = realExchange;

      // Futures gets its own earn instance if staking not already running
      if (!this.krakenEarn) {
        this.krakenEarn = new KrakenEarn(isPaper ? null : realExchange.exchange, isPaper, isPaper ? this.exchange : null);
      }

      this.safeguards  = new Safeguards(this.config);
      this.capitalRouter = new CapitalRouter({
        spotExchange:    this.exchange,
        futuresExchange: this.futuresExchange,
        krakenEarn:      this.krakenEarn,
        config:          this.config,
        isPaper,
      });

      // Futures strategies: MeanReversion + Momentum only (no accumulator)
      this._futuresStrategies = [];
      this._futuresPositions  = new Map();
      this._lastMacroBullish  = true; // track macro transitions for flip logic
    }
  }

  async start() {
    const log = getLogger();
    log.info("==================================================");
    log.info("  CELL TRADING ENGINE - POWERING UP");
    log.info("==================================================");
    log.info(`Mode: ${this.config.mode.toUpperCase()}`);

    // Connect primary (spot) exchange
    await this.exchange.connect();

    // Connect secondary exchange if configured
    const ex2Config = this.config.exchange2;
    if (ex2Config && ex2Config.enabled && ex2Config.name) {
      const ex2FullConfig = {
        ...this.config,
        exchange: {
          name: ex2Config.name,
          apiKey: ex2Config.apiKey,
          apiSecret: ex2Config.apiSecret,
          sandbox: ex2Config.sandbox || false,
        },
      };
      this.exchange2 = new ExchangeManager(ex2FullConfig);
      await this.exchange2.connect();
      log.info(`Secondary exchange: ${ex2Config.name}`);
    }

    // Connect futures exchange
    if (this.futuresEnabled) {
      const totalCapital = this.isPaper
        ? this.config.startingCapital
        : (await this._estimateLiveCapital());
      const futuresStart = totalCapital * (this.config.futures.capitalPct || 0.30);

      // Connect then restore persisted balance in paper mode (gains/losses carry forward)
      await this.futuresExchange.connect(futuresStart);
      const restoredBalance = this.isPaper ? this.db.restoreFuturesBalance() : null;
      if (restoredBalance !== null && this.isPaper) {
        this.futuresExchange.setPaperBalance(restoredBalance);
      }
      this._initFuturesStrategies();

      // Restore open futures positions
      const savedPositions = this.db.restoreFuturesPositions();
      for (const pos of savedPositions) {
        this._futuresPositions.set(pos.pair, pos);
      }
      if (savedPositions.length > 0) {
        log.info(`[FUTURES] Restored ${savedPositions.length} open position(s) from DB`);
      }

      // Restore peak balance so drawdown halt survives restarts
      const restoredPeak = this.db.restoreFuturesPeak();
      if (restoredPeak > 0) {
        this.safeguards._peakFuturesBalance = restoredPeak;
        log.info(`[FUTURES] Restored peak balance $${restoredPeak.toFixed(2)} — drawdown tracking continues`);
      }

      const bal = this.futuresExchange.getBalance();
      log.info(`[FUTURES] Sub-account balance: $${bal.toFixed(2)}${restoredBalance !== null ? " (restored)" : " (fresh start)"}`);
    }

    await this._resolvePairs();
    await this.portfolio.initialize(this.exchange);
    this._initStrategies();

    // Restore accumulator state from DB
    this.db.restoreAccumulatorState(this.accumulator);

    // Sync restored bags into paper exchange virtual balances + portfolio baseline
    if (this.accumulator) {
      let bagUsd = 0;
      for (const [pair, st] of this.accumulator.state) {
        if (st.totalAccumulated <= 0) continue;
        const base = pair.split("/")[0];
        // Paper mode: credit tokens and debit the cost so virtual balance is accurate
        if (this.isPaper) {
          this.exchange.creditRestoredBags(base, st.totalAccumulated, st.totalSpent);
        }
        // Use avg entry price as initial estimate (real price picked up first cycle)
        bagUsd += st.totalAccumulated * (st.avgEntry || 0);
      }
      if (bagUsd > 0) {
        this.portfolio.setBagValue(bagUsd);
        // Re-run portfolio update so totalValue reflects bags before logging
        await this.portfolio.update(this.exchange);
        this.portfolio.recalibrate();
      }
    }

    // Initial macro filter check
    if (this.macroFilter) {
      await this.macroFilter.isBullish();
      const ms = this.macroFilter.state;
      log.info(
        `[MACRO] Filter active: BTC ${ms.bullish ? "BULLISH" : "BEARISH"} — ` +
        `${ms.symbol} ${ms.timeframe} EMA${ms.emaPeriod}`
      );
    }

    this.running = true;
    log.info(`Starting capital: $${this.portfolio.totalValue.toFixed(2)}`);
    log.info(`Active strategies: ${this.strategies.map((s) => s.name).join(", ")}`);
    log.info(`Trading pairs: ${this.allPairs.join(", ")}`);
    if (this.futuresEnabled) {
      const fpairs = (this.config.futures.pairs || []).join(", ");
      log.info(`Futures pairs: ${fpairs} | balance: $${this.futuresExchange.getBalance().toFixed(2)}`);
      log.info(`Futures strategies: ${this._futuresStrategies.map(s => s.name).join(", ")}`);
    }
    log.info("Cell is LIVE. Accumulating and hunting for profit...");

    await this._runLoop();
  }

  async _resolvePairs() {
    const log = getLogger();
    log.info("Resolving trading pairs...");

    // Primary exchange pairs - already verified in config
    const primaryPairs = this.config.trading.pairs || [];
    for (const pair of primaryPairs) {
      this.pairExchangeMap.set(pair, this.exchange);
      this.allPairs.push(pair);
      log.info(`  ${pair} -> ${this.config.exchange.name}`);
    }

    // Secondary exchange pairs
    const ex2Pairs = this.config.trading.exchange2Pairs || [];
    if (this.exchange2 && ex2Pairs.length > 0) {
      for (const pair of ex2Pairs) {
        this.pairExchangeMap.set(pair, this.exchange2);
        this.allPairs.push(pair);
        log.info(`  ${pair} -> ${this.config.exchange2.name}`);
      }
    }

    if (this.allPairs.length === 0) {
      throw new Error("No tradeable pairs configured!");
    }
  }

  _initStrategies() {
    const sc = this.config.strategies;

    if (sc.grid && sc.grid.enabled) {
      this.strategies.push(new GridStrategy(this.config, this.exchange));
    }
    if (sc.meanReversion && sc.meanReversion.enabled) {
      this.strategies.push(new MeanReversionStrategy(this.config, this.exchange));
    }
    if (sc.momentum && sc.momentum.enabled) {
      this.strategies.push(new MomentumStrategy(this.config, this.exchange));
    }
    if (sc.accumulator && sc.accumulator.enabled) {
      this.accumulator = new AccumulatorStrategy(this.config, this.exchange);
      this.strategies.push(this.accumulator);
    }
  }

  async _runLoop() {
    const log = getLogger();
    const intervalMs = this._timeframeToMs(this.config.trading.timeframe);
    while (this.running) {
      try {
        this._cycleCount++;
        this._consecutiveNetworkErrors = 0;
        await this._tradingCycle();
        await this._checkStopLossAndTakeProfit();
        if (this.futuresEnabled) {
          await this._futuresCycle();
          await this._checkFuturesSLTP();
          await this.capitalRouter.tick();
        } else if (this.krakenEarn) {
          // Standalone staking — stake idle USDT, no futures routing
          await this._stakeIdleUsdt();
        }
        // If every pair failed with a network error, back off before retrying
        if (this._consecutiveNetworkErrors >= this.allPairs.length) {
          log.warn(`[NETWORK] All pairs failed — waiting 60s before retry...`);
          await this._sleep(60000);
        } else {
          await this._sleep(intervalMs);
        }
      } catch (e) {
        if (e.message === "SHUTDOWN") break;
        log.error(`Error in trading cycle: ${e.message}\n${e.stack}`);
        await this._sleep(30000);
      }
    }

    await this.shutdown();
  }

  async _tradingCycle() {
    const log = getLogger();
    await this.exchange.refreshBalance();

    // Update bag value from last known prices before portfolio.update()
    // so totalValue, drawdown, and position sizing all see the full account value
    if (this.accumulator) {
      let bagUsd = 0;
      for (const [pair, st] of this.accumulator.state) {
        if (st.totalAccumulated <= 0) continue;
        const lastPrice = this.portfolio.getCurrentPrice(pair);
        const price = lastPrice > 0 ? lastPrice : (st.avgEntry || 0);
        bagUsd += st.totalAccumulated * price;
      }
      this.portfolio.setBagValue(bagUsd);
    }

    // Keep staked value visible to portfolio so risk checks see the full picture
    if (this.krakenEarn) {
      this.portfolio.setStakedValue(this.krakenEarn.getStakedAmount());
    }

    await this.portfolio.update(this.exchange);

    // Check risk limits — accumulator continues even when halted (DCA into dips)
    const tradingAllowed = this.risk.canTrade();
    if (!tradingAllowed && this._cycleCount % 12 === 0) {
      log.warn(`Risk limits hit - regular trading paused (accumulator still active)`);
    }

    // Analyze each pair with each strategy
    for (const pair of this.allPairs) {
      const ex = this.pairExchangeMap.get(pair) || this.exchange;

      try {
        const candles = await ex.fetchOHLCV(pair, this.config.trading.timeframe);
        const ticker = await ex.fetchTicker(pair);

        // Compute indicators once per pair (shared by MTF + strategies)
        const ind5m = calcIndicators(candles, this.config);

        // Multi-timeframe context (1h trend, VWAP, ATR regime)
        const context = await this.mtf.getContext(pair, candles, ind5m);

        // Coast mode: when up >= coastModePct% today, only take high-conviction signals.
        // Preserves gains — no point risking a good day on marginal setups.
        const coastThreshold = this.config.risk?.coastModePct || 0.03;
        const dailyPnlPct = this.portfolio.dailyStartValue > 0
          ? (this.portfolio.totalValue - this.portfolio.dailyStartValue) / this.portfolio.dailyStartValue
          : 0;
        const inCoastMode = dailyPnlPct >= coastThreshold;
        if (inCoastMode && this._cycleCount % 12 === 0) {
          log.info(`[COAST] Up ${(dailyPnlPct*100).toFixed(1)}% today — only high-confidence signals (≥0.78)`);
        }

        for (const strategy of this.strategies) {
          const signal = await strategy.analyze(pair, candles, ticker, context);

          if (signal && signal.confidence >= this.config.signals.minConfidence) {
            // When risk is halted, only accumulator buys are allowed
            if (!tradingAllowed && (!signal.accumulate || signal.side !== "buy")) continue;
            // In coast mode, skip low-conviction non-accumulator signals
            if (inCoastMode && !signal.accumulate && signal.confidence < 0.78) continue;
            // Bear market: only the accumulator DCA buys spot — MR/momentum longs
            // in a downtrend consistently get stopped out regardless of confidence score
            const macroBearish = this.macroFilter && !this.macroFilter.state?.bullish;
            if (macroBearish && signal.side === "buy" && !signal.accumulate) continue;
            // Enrich signal with ATR regime + macro state for risk sizing and logging
            signal.atrRegime  = context.atrRegime;
            signal.macroState = this.macroFilter
              ? (this.macroFilter.state.bullish ? "bull" : "bear")
              : "unknown";

            // Replace hardcoded winRate with real historical performance when available
            const realStats = this.db.getStrategyStats(signal.strategy, signal.pair);
            if (realStats) {
              signal.winRate = realStats.winRate;
              // Penalise a strategy that's been consistently underperforming
              if (realStats.winRate < 0.40 && realStats.totalTrades >= 15) {
                signal.confidence = Math.max(signal.confidence - 0.08, 0.40);
              }
            }

            // Spot SELL signals: only allow if closing an existing long position.
            // Never initiate a fresh short on spot — that's futures' job.
            if (signal.side === "sell" && !signal.accumulate) {
              const hasLong = this.portfolio.openPositions.some(
                p => p.pair === signal.pair && p.side === "buy" && !p.accumulate
              );
              if (!hasLong) continue;
            }

            // Tag signal with which exchange to use
            signal._exchange = ex;
            this.signalGen.record(signal);

            if (this.risk.approveTrade(signal)) {
              await this._executeSignal(signal);
            }
          }

          // Adaptive optimizer: check if parameters need tuning (non-blocking)
          this.optimizer.maybeOptimize(strategy.name, pair, candles).catch(() => {});
        }
      } catch (e) {
        log.error(`Error analyzing ${pair}: ${e.message}`);
        const isNetwork = e.message.includes("fetch failed") || e.message.includes("ECONNRESET") || e.message.includes("timeout");
        if (isNetwork) this._consecutiveNetworkErrors++;
      }
    }

    // Periodic status log + summary file + daily snapshot
    if (this._cycleCount % 6 === 0) {
      try { this._logStatus(); } catch (e) { log.debug(`logStatus error: ${e.message}`); }
    }
    try { writeSummary(this); } catch (e) { log.debug(`writeSummary error: ${e.message}`); }
    try { this._maybeSaveDailySnapshot(); } catch (e) { log.debug(`snapshot error: ${e.message}`); }
  }

  async _checkStopLossAndTakeProfit() {
    const log = getLogger();
    const trailingPct = this.config.trading.trailingStopPct || 0;

    for (const pos of [...this.portfolio.openPositions]) {
      const currentPrice = this.portfolio.getCurrentPrice(pos.pair);
      if (!currentPrice) continue;

      // Ratchet trailing stop for non-accumulate positions
      if (trailingPct > 0 && !pos.accumulate && pos.stopLoss) {
        if (pos.side === "buy") {
          if (currentPrice > (pos.trailingHigh || pos.entryPrice)) {
            pos.trailingHigh = currentPrice;
            const newStop = pos.trailingHigh * (1 - trailingPct);
            if (newStop > pos.stopLoss) pos.stopLoss = newStop;
          }
        } else {
          if (currentPrice < (pos.trailingLow || pos.entryPrice)) {
            pos.trailingLow = currentPrice;
            const newStop = pos.trailingLow * (1 + trailingPct);
            if (newStop < pos.stopLoss) pos.stopLoss = newStop;
          }
        }
      }

      let shouldClose = false;
      let reason = "";

      if (pos.side === "buy") {
        if (pos.stopLoss && currentPrice <= pos.stopLoss) {
          shouldClose = true;
          reason = "stop loss";
        } else if (pos.takeProfit && currentPrice >= pos.takeProfit) {
          shouldClose = true;
          reason = "take profit";
        }
      } else {
        if (pos.stopLoss && currentPrice >= pos.stopLoss) {
          shouldClose = true;
          reason = "stop loss";
        } else if (pos.takeProfit && currentPrice <= pos.takeProfit) {
          shouldClose = true;
          reason = "take profit";
        }
      }

      // Time-stop: non-accumulator positions stale after 4 hours recycle capital
      if (!shouldClose && !pos.accumulate && pos.openedAt) {
        const ageMs = Date.now() - new Date(pos.openedAt).getTime();
        if (ageMs > 4 * 60 * 60 * 1000) {
          shouldClose = true;
          reason = "time stop (4h)";
        }
      }

      if (shouldClose) {
        const ex = this.pairExchangeMap.get(pos.pair) || this.exchange;
        try {
          if (pos.side === "buy") {
            await ex.createMarketSell(pos.pair, pos.amount);
          } else {
            await ex.createMarketBuy(pos.pair, pos.amount);
          }
          const trade = this.portfolio.closePosition(pos, currentPrice);
          this.db.recordTrade(trade);
          log.info(`Closed ${pos.pair} via ${reason}: PnL $${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`);
        } catch (e) {
          log.error(`Failed to close position ${pos.pair}: ${e.message}`);
        }
      }
    }
  }

  async _executeSignal(signal) {
    const log = getLogger();
    const ex = signal._exchange || this.pairExchangeMap.get(signal.pair) || this.exchange;

    // Macro filter: only block MR/momentum signals in a hard bear (BTC >10% below EMA50).
    // Accumulator DCA is never blocked — it already cuts size 50% when h1Trend is down.
    if (this.macroFilter && !signal.accumulate) {
      const bullish = await this.macroFilter.isBullish();
      if (!bullish) {
        const ms = this.macroFilter.state;
        const btcPct = ms.btcPrice && ms.ema ? (ms.ema - ms.btcPrice) / ms.ema : 0;
        // Only hard-block MR/momentum in a severe crash (>10% below EMA50)
        if (btcPct > 0.10 && signal.side === "buy" && signal.confidence < 0.80) {
          log.info(`[MACRO] Crash filter: BTC ${(btcPct*100).toFixed(1)}% below EMA50 — blocking ${signal.strategy} buy`);
          return;
        }
      }
    }

    // Accumulator can override position size
    let size;
    if (signal.sizePctOverride) {
      const capital = this.portfolio.totalValue;
      const sizeUsd = capital * signal.sizePctOverride;
      size = sizeUsd / signal.price;
    } else if (signal.amount) {
      size = signal.amount;
    } else {
      size = this.risk.calculatePositionSize(signal);
    }

    if (size <= 0) return;

    // For buys: cap to 60% of free cash to avoid "Insufficient" errors
    if (signal.side === "buy") {
      const quoteCurrency = signal.pair.split("/")[1] || "USD";
      const freeCash = ex.getFree(quoteCurrency);
      const maxFromCash = freeCash * 0.60;
      const cappedSizeUsd = Math.min(size * signal.price, maxFromCash);
      size = cappedSizeUsd / signal.price;
    }

    // Enforce minimum order size (avoid Kraken rejection)
    const orderValueUsd = size * signal.price;
    if (orderValueUsd < this.minOrderUsd) {
      getLogger().debug(`Skipping ${signal.pair} order - $${orderValueUsd.toFixed(3)} below min $${this.minOrderUsd}`);
      return;
    }

    try {
      let order;
      if (signal.side === "buy") {
        order = await ex.createLimitBuy(signal.pair, size, signal.price);
      } else {
        order = await ex.createLimitSell(signal.pair, size, signal.price);
      }

      // Accumulator buys don't get stop-loss/take-profit - we're HOLDING
      const enrichedSignal = { ...signal, amount: size };
      delete enrichedSignal._exchange;
      if (signal.accumulate) {
        delete enrichedSignal.stopLoss;
        delete enrichedSignal.takeProfit;
      }

      this.portfolio.recordOrder(order, enrichedSignal);
      this.db.recordSignal(enrichedSignal);

      // Track accumulation
      if (this.accumulator && signal.strategy === "accumulator") {
        if (signal.side === "buy") {
          this.accumulator.recordAccumulation(signal.pair, size, signal.price);
          this.db.saveAccumulatorState(signal.pair, this.accumulator.state.get(signal.pair));
        } else {
          this.accumulator.recordScalpSell(signal.pair, size);
          this.db.saveAccumulatorState(signal.pair, this.accumulator.state.get(signal.pair));
        }
      }

      log.info(
        `EXECUTED ${signal.side.toUpperCase()} ${size.toFixed(6)} ${signal.pair} ` +
        `@ $${signal.price.toFixed(2)} [${signal.strategy}] ` +
        `conf=${(signal.confidence * 100).toFixed(0)}% | ${signal.reason}`
      );
    } catch (e) {
      log.error(`Order failed for ${signal.pair}: ${e.message}`);
    }
  }

  // ── Standalone staking (no futures) ──────────────────────────────────────

  async _stakeIdleUsdt() {
    const reserve  = (this.config.capitalRouter || {}).minSpotReserve || 20;
    const freeUsdt = this.isPaper ? this.exchange.getFree("USD") : this.exchange.getFree("USDT");
    const idle     = freeUsdt - reserve;
    if (idle >= 5) await this.krakenEarn.allocate(idle);
  }

  // ── Futures sub-system ────────────────────────────────────────────────────

  _initFuturesStrategies() {
    const sc  = this.config.strategies;
    const fc  = this.config.futures;
    // Futures MR uses bear-optimised sell settings: fire shorts at BB middle with
    // RSI ≥ 42 instead of requiring a full rally to BB upper + RSI ≥ 58.
    // This catches relief-rally shorts in sustained downtrends.
    const fCfg = {
      ...this.config,
      trading: { ...this.config.trading, ...fc },
      strategies: {
        ...this.config.strategies,
        meanReversion: {
          ...this.config.strategies.meanReversion,
          bearTrendShort:     true,
          rsiOverboughtShort: 42,
        },
      },
    };

    if (sc.meanReversion && sc.meanReversion.enabled) {
      this._futuresStrategies.push(new MeanReversionStrategy(fCfg, this.futuresExchange));
    }
    if (sc.momentum && sc.momentum.enabled) {
      this._futuresStrategies.push(new MomentumStrategy(fCfg, this.futuresExchange));
    }
  }

  async _futuresCycle() {
    const log = getLogger();
    const fc  = this.config.futures;
    await this.futuresExchange.refreshBalance();

    const futBal = this.futuresExchange.getBalance();
    this.safeguards.updateFuturesBalance(futBal);

    if (this.safeguards.isFuturesHalted()) return;

    const maxPositions = fc.maxPositions || 2;
    if (this._futuresPositions.size >= maxPositions) return;

    const pairs     = fc.pairs || [];
    const leverage  = fc.leverage || 2;
    const timeframe = this.config.trading.timeframe;
    const macroBullishNow = this.macroFilter ? this.macroFilter.state.bullish : true;
    const macroFlippedBearish = this._lastMacroBullish && !macroBullishNow;
    this._lastMacroBullish = macroBullishNow;

    // Macro flip: only when BTC just crossed from bull→bear, close stranded longs
    if (macroFlippedBearish) {
      for (const [pair, pos] of [...this._futuresPositions]) {
        if (pos.side !== "buy") continue;
        try {
          const ticker = await this.futuresExchange.fetchTicker(pair);
          const price  = ticker.last || ticker.bid || pos.entryPrice;
          await this.futuresExchange.closePositionMarket(pair, pos.side, pos.amount);
          const pnl = (price - pos.entryPrice) * pos.amount;
          this.safeguards.recordTrade(pnl);
          this._futuresPositions.delete(pair);
          this.db.deleteFuturesPosition(pair);
          this.db.saveFuturesBalance(this.futuresExchange.getBalance());
          log.info(`[FUTURES] Macro flip BEARISH — closed long ${pair} | PnL $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
        } catch (e) {
          log.error(`[FUTURES] Macro flip close failed for ${pair}: ${e.message}`);
        }
      }
    }

    for (const pair of pairs) {
      // Skip if already in a position on this symbol
      if (this._futuresPositions.has(pair)) continue;

      try {
        // Use spot pair notation for OHLCV (futures _spotRef maps it)
        const spotPair = pair.replace(/:.*/, "");
        const candles  = await this.futuresExchange.fetchOHLCV(pair, timeframe);
        if (!candles || candles.length < 50) continue;

        const ticker   = await this.futuresExchange.fetchTicker(pair);
        const price    = ticker.last || ticker.bid || 0;
        if (!price) continue;

        const ind5m    = calcIndicators(candles, this.config);
        const context  = await this.mtf.getContext(spotPair, candles, ind5m);

        // Macro filter for futures: in bearish conditions, require high conviction for longs
        const futuresMacroBullish = this.macroFilter ? this.macroFilter.state.bullish : true;

        for (const strategy of this._futuresStrategies) {
          const signal = await strategy.analyze(pair, candles, ticker, context);
          const futuresMinConf = fc.minConfidence || (this.config.signals.minConfidence || 0.60);
          if (!signal || signal.confidence < futuresMinConf) continue;

          // Futures trade only in the macro direction — no counter-trend positions
          if (!futuresMacroBullish && signal.side === "buy") {
            log.debug(`[FUTURES] Macro bearish — skipping long ${pair}`);
            continue;
          }
          if (futuresMacroBullish && signal.side === "sell") {
            log.debug(`[FUTURES] Macro bullish — skipping short ${pair}`);
            continue;
          }
          // Boost confidence slightly when trading with the trend
          signal.confidence = Math.min(signal.confidence + 0.03, 0.95);

          // Enrich
          signal.atrRegime = context.atrRegime;

          // Safeguards: size check
          const tradeUsd   = futBal * (fc.maxPositionPct || 0.25);
          const check      = this.safeguards.checkTrade(futBal, tradeUsd);
          if (!check.ok) {
            log.debug(`[FUTURES] Trade blocked: ${check.reason}`);
            continue;
          }

          // Amount in base asset
          const amount = tradeUsd / price;
          if (amount * price < (fc.minOrderUsd || 5)) continue;

          try {
            await this.futuresExchange.openPosition(pair, signal.side, amount, price, leverage);

            // ATR-based stops — use 5× ATR for SL, 10× ATR for TP to survive noise
            // (5m ATR is small; multipliers compensate so we don't get whipsawed)
            const atrArr = ind5m.atr;
            const atr    = (Array.isArray(atrArr) ? atrArr[atrArr.length - 1] : atrArr) || price * 0.015;
            const slMult = this.config.futures.slAtrMult || 5;
            const tpMult = this.config.futures.tpAtrMult || 10;
            const sl     = signal.side === "buy" ? price - slMult * atr : price + slMult * atr;
            const tp     = signal.side === "buy" ? price + tpMult * atr : price - tpMult * atr;

            const futPos = {
              side:       signal.side,
              amount,
              entryPrice: price,
              stopLoss:   sl,
              takeProfit: tp,
              strategy:   signal.strategy,
              openTime:   Date.now(),
            };
            this._futuresPositions.set(pair, futPos);
            this.db.saveFuturesPosition(pair, futPos);
            this.db.saveFuturesBalance(this.futuresExchange.getBalance());

            log.info(
              `[FUTURES] OPENED ${signal.side.toUpperCase()} ${amount.toFixed(4)} ${pair} ` +
              `@ $${price.toFixed(4)} | SL $${sl.toFixed(4)} | TP $${tp.toFixed(4)} ` +
              `[${signal.strategy}] conf=${(signal.confidence * 100).toFixed(0)}%`
            );
          } catch (e) {
            log.error(`[FUTURES] openPosition failed: ${e.message}`);
          }
          break;  // one trade per pair per cycle
        }
      } catch (e) {
        log.error(`[FUTURES] Error analyzing ${pair}: ${e.message}`);
      }
    }

    // Always persist current balance + peak so restarts restore drawdown tracking
    if (this.isPaper) this.db.saveFuturesBalance(
      this.futuresExchange.getBalance(),
      this.safeguards._peakFuturesBalance
    );
  }

  async _checkFuturesSLTP() {
    const log = getLogger();

    for (const [pair, pos] of [...this._futuresPositions]) {
      try {
        const ticker = await this.futuresExchange.fetchTicker(pair);
        const price  = ticker.last || ticker.bid || pos.entryPrice;
        if (!price) continue;

        let hit    = false;
        let reason = "";

        if (pos.side === "buy") {
          if (price <= pos.stopLoss)   { hit = true; reason = "stop loss"; }
          if (price >= pos.takeProfit) { hit = true; reason = "take profit"; }
        } else {
          if (price >= pos.stopLoss)   { hit = true; reason = "stop loss"; }
          if (price <= pos.takeProfit) { hit = true; reason = "take profit"; }
        }

        if (hit) {
          await this.futuresExchange.closePositionMarket(pair, pos.side, pos.amount);
          const pnl = pos.side === "buy"
            ? (price - pos.entryPrice) * pos.amount
            : (pos.entryPrice - price) * pos.amount;
          this.safeguards.recordTrade(pnl);
          if (pnl > 0) this.safeguards.onYieldInjection(pnl);
          this._futuresPositions.delete(pair);
          this.db.deleteFuturesPosition(pair);
          this.db.saveFuturesBalance(this.futuresExchange.getBalance());
          this.db.recordTrade({
            pair, side: pos.side, entryPrice: pos.entryPrice, exitPrice: price,
            amount: pos.amount, strategy: pos.strategy || "futures", pnl,
          });
          log.info(`[FUTURES] CLOSED ${pair} via ${reason} | PnL $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
        }
      } catch (e) {
        log.error(`[FUTURES] SLTP check failed for ${pair}: ${e.message}`);
      }
    }
  }

  async _estimateLiveCapital() {
    // Called before portfolio.initialize — gets a rough balance for futures allocation
    try {
      await this.exchange.refreshBalance();
      return this.exchange.getFree("USDT") || this.config.startingCapital;
    } catch (_) {
      return this.config.startingCapital;
    }
  }

  _logStatus() {
    const log  = getLogger();
    const mode = this.isPaper ? "PAPER" : "LIVE";

    // ── Money breakdown ───────────────────────────────────────────────────
    const freeCash  = this.isPaper ? this.exchange.getFree("USD") : this.exchange.getFree("USDT");
    const bagValue  = this.portfolio._bagValue || 0;
    const staked    = this.krakenEarn ? this.krakenEarn.getStakedAmount() : 0;
    const tradeVal  = this.portfolio.openPositions
      .filter(p => !p.accumulate)
      .reduce((s, p) => {
        const px = this.portfolio.getCurrentPrice(p.pair) || p.entryPrice;
        return s + p.amount * px;
      }, 0);

    const spotTotal    = freeCash + staked + tradeVal + bagValue;
    const futuresBal   = this.futuresEnabled ? this.futuresExchange.getBalance() : 0;
    const grandTotal   = spotTotal + futuresBal;

    // Basis = full starting capital (spot + futures combined)
    const spotBasis    = this.portfolio._sessionStart > 0 ? this.portfolio._sessionStart : this.config.startingCapital;
    const futuresBasis = this.futuresEnabled ? (this.config.startingCapital * (this.config.futures.capitalPct || 0.30)) : 0;
    const basis        = spotBasis + futuresBasis;
    const pnl     = grandTotal - basis;
    const pnlPct  = basis > 0 ? (pnl / basis) * 100 : 0;

    // ── Bag detail ────────────────────────────────────────────────────────
    let bagDetail = "";
    if (this.accumulator) {
      const holdings = this.accumulator.getHoldings();
      bagDetail = Object.entries(holdings)
        .filter(([, h]) => h.amount > 0)
        .map(([token, h]) => {
          const px = this.portfolio.getCurrentPrice(`${token}/USD`) || h.avgEntry || 0;
          return `${token}: ${h.amount.toFixed(2)} (~$${(h.amount * px).toFixed(0)})`;
        })
        .join(", ");
    }

    // ── Earn / Futures detail ─────────────────────────────────────────────
    let earnDetail = staked > 0 ? `  Staked (Earn): $${staked.toFixed(2)}\n` : "";
    let futDetail  = "";
    if (this.futuresEnabled) {
      const sg  = this.safeguards.getStatus();
      const cr  = this.capitalRouter.getStats();
      const fps = this._futuresPositions.size;
      futDetail = `  Futures acct:  $${futuresBal.toFixed(2)} | ${fps} position(s) | yield→fut $${cr.totalToFutures.toFixed(2)}`;
      if (sg.halted) futDetail += ` ⚠ HALTED`;
      futDetail += "\n";
    }

    // ── Macro ─────────────────────────────────────────────────────────────
    let macroLine = "";
    if (this.macroFilter) {
      const ms = this.macroFilter.state;
      if (ms.btcPrice) {
        macroLine = `  Macro:         BTC ${ms.bullish ? "BULL 🟢" : "BEAR 🔴"} $${ms.btcPrice.toFixed(0)} vs EMA50(4h) $${ms.ema.toFixed(0)}\n`;
      }
    }

    const sep = "─".repeat(52);
    const lines = [
      `\n╔══ ${mode} — Cycle ${this._cycleCount} ══════════════════════════════╗`,
      `  Free cash:     $${freeCash.toFixed(2)}`,
      earnDetail.trimEnd(),
      `  Active trades: $${tradeVal.toFixed(2)} (${this.portfolio.openPositions.filter(p=>!p.accumulate).length} position${this.portfolio.openPositions.filter(p=>!p.accumulate).length !== 1 ? "s" : ""})`,
      `  Bags (MTM):    $${bagValue.toFixed(2)}${bagDetail ? "  →  " + bagDetail : ""}`,
      futDetail.trimEnd(),
      `  ${sep}`,
      `  SPOT TOTAL:    $${spotTotal.toFixed(2)}`,
      this.futuresEnabled ? `  FUTURES:       $${futuresBal.toFixed(2)}` : null,
      `  GRAND TOTAL:   $${grandTotal.toFixed(2)}   PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
      macroLine.trimEnd(),
      `  Trades: ${this.portfolio.tradeHistory.length} closed | Win rate: ${(this.portfolio.winRate * 100).toFixed(0)}%${this.risk.isHalted ? " | ⚠ RISK HALTED: " + this.risk.haltReason : ""}`,
      `╚${"═".repeat(53)}╝`,
    ].filter(l => l !== null && l !== "");

    log.info(lines.join("\n"));
  }

  async shutdown() {
    const log = getLogger();
    this.running = false;
    log.info("Cell shutting down...");

    try {
      const openOrders = await this.exchange.fetchOpenOrders();
      for (const order of openOrders) {
        await this.exchange.cancelOrder(order.id, order.symbol);
      }
      log.info(`Cancelled ${openOrders.length} open orders`);
    } catch (e) {
      log.error(`Error cancelling orders: ${e.message}`);
    }

    await this.exchange.close();
    if (this.exchange2) await this.exchange2.close();
    if (this.futuresEnabled) {
      if (this.isPaper) this.db.saveFuturesBalance(this.futuresExchange.getBalance());
      await this.futuresExchange.close();
    }
    this.db.close();
    log.info("Cell shutdown complete.");
  }

  _maybeSaveDailySnapshot() {
    const today = new Date().toISOString().split("T")[0];
    if (this._lastSnapshotDate === today) return;
    this._lastSnapshotDate = today;

    const freeCash   = this.isPaper ? this.exchange.getFree("USD") : this.exchange.getFree("USDT");
    const staked     = this.krakenEarn ? this.krakenEarn.getStakedAmount() : 0;
    const bagValue   = this.portfolio._bagValue || 0;
    const tradeValue = this.portfolio.openPositions
      .filter(p => !p.accumulate)
      .reduce((s, p) => s + p.amount * (this.portfolio.getCurrentPrice(p.pair) || p.entryPrice), 0);
    const spotTotal  = freeCash + staked + tradeValue + bagValue;
    const futuresBal = this.futuresEnabled ? this.futuresExchange.getBalance() : 0;
    const grandTotal = spotTotal + futuresBal;

    const bags = {};
    if (this.accumulator) {
      for (const [pair, st] of this.accumulator.state) {
        if (st.totalAccumulated > 0) {
          const base = pair.split("/")[0];
          const px = this.portfolio.getCurrentPrice(pair) || st.avgEntry || 0;
          bags[base] = { amount: st.totalAccumulated, avgEntry: st.avgEntry, value: st.totalAccumulated * px };
        }
      }
    }

    const macro = this.macroFilter ? this.macroFilter.state : null;

    this.db.saveDailySnapshot({
      totalValue:    grandTotal,
      spotTotal,
      futuresTotal:  futuresBal,
      realizedPnl:   this.portfolio.realizedPnl,
      unrealizedPnl: grandTotal - this.config.startingCapital - this.portfolio.realizedPnl,
      totalTrades:   this.portfolio.tradeHistory.length,
      winRate:       this.portfolio.winRate,
      bags,
      macroState:    macro ? (macro.bullish ? "bull" : "bear") : "unknown",
      futuresHalted: this.futuresEnabled ? this.safeguards.isFuturesHalted() : false,
    });
    getLogger().info(`[SNAPSHOT] Daily snapshot saved: $${grandTotal.toFixed(2)} total | realized PnL $${this.portfolio.realizedPnl.toFixed(2)}`);
  }

  _timeframeToMs(tf) {
    const unit = tf.slice(-1);
    const value = parseInt(tf.slice(0, -1));
    const multipliers = { m: 60000, h: 3600000, d: 86400000 };
    return value * (multipliers[unit] || 60000);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

module.exports = { CellEngine };

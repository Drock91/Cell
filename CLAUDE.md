# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                                  # Paper trade (uses config.paper.yaml)
npm run start:live                         # Live trade (uses config.live.yaml)
npm run backtest                           # Run backtester
npm run compare                            # Compare paper vs live results
node src/index.js --dashboard              # Paper trade with live terminal dashboard
node src/index.js --live --dashboard       # Live trade with dashboard
node src/index.js --config=config.yaml     # Use a specific config file
```

No test suite exists. Verify changes by running in paper mode.

## Architecture

Cell is a Node.js crypto trading engine. The main entry point is `src/index.js`, which parses CLI flags, instantiates `CellEngine`, optionally wires up a Telegram bot and dashboard, then calls `engine.start()`.

### Core layer (`src/core/`)

- **`engine.js` (`CellEngine`)** — orchestrator. Owns the trading loop (`_runLoop` → `_tradingCycle`). Each cycle: refreshes balances, checks risk limits, fetches OHLCV + ticker per pair, runs each strategy's `analyze()`, records signals above `minConfidence`, approves trades via `RiskManager`, then executes via `_executeSignal`.
- **`exchange.js` (`ExchangeManager`)** — thin wrapper around `ccxt`. Used for live trading.
- **`paperExchange.js` (`PaperExchange`)** — drop-in replacement for `ExchangeManager` in paper mode. Reads real market data but simulates fills against virtual balances (0.16% fee). Exposes the same interface so `CellEngine` is unaware of which it's using.
- **`portfolio.js` (`Portfolio`)** — tracks open positions, closed trade history, unrealized/realized PnL, drawdown, and daily start value.
- **`risk.js` (`RiskManager`)** — enforces daily loss cap and max drawdown (auto-halt). Sizes positions via Kelly, volatility-adjusted, or fixed-pct methods.
- **`config.js`** — loads and merges YAML config. Config files: `config.yaml` (default), `config.paper.yaml`, `config.live.yaml`.
- **`logger.js`** — singleton Winston logger; call `getLogger()` everywhere.

### Strategies (`src/strategies/`)

Each strategy exposes `async analyze(pair, candles, ticker)` returning a signal object or `null`. Signal shape:

```js
{
  pair, side, price, strategy, confidence, reason,
  stopLoss, takeProfit,
  winRate,       // for Kelly sizing
  volatility,    // for volatility sizing
  accumulate,    // true = skip stop-loss/take-profit tracking
  sizePctOverride, amount  // optional size overrides
}
```

- **`grid.js`** — places a grid of limit orders around current price.
- **`meanReversion.js`** — Bollinger Bands + RSI; buys oversold, sells overbought.
- **`momentum.js`** — EMA crossover + MACD + volume filter.
- **`accumulator.js`** — DCA into priority tokens on a timer plus dip-multiplied buys; optional scalp sells on pops. State is persisted to SQLite and restored on restart.
- **`indicators.js`** — shared indicator helpers used by the strategies.

### Signals (`src/signals/generator.js`)

`SignalGenerator` records every signal above `minConfidence`, keeps the last 1000 in memory, and notifies subscribers via callbacks. The Telegram bot subscribes here to broadcast signals.

### Persistence (`src/utils/db.js`)

`TradeDB` uses `better-sqlite3`. Two separate databases: `data/paper.db` and `data/live.db`. Tables: `trades`, `signals`, `accumulator_state`, `daily_snapshots`. Accumulator state is saved after each buy/sell and restored on engine startup.

### Config structure

Key `config.yaml` sections:

| Key | Purpose |
|-----|---------|
| `mode` | `paper` or `live` |
| `startingCapital` | Initial USD for paper mode |
| `exchange` / `exchange2` | Exchange name + API creds (read from env via dotenv) |
| `trading.pairs` / `exchange2Pairs` | Pairs routed to each exchange |
| `trading.timeframe` | Candle interval for the main loop |
| `strategies.*` | Per-strategy enabled flag + parameters |
| `risk.*` | `maxDailyLossPct`, `maxDrawdownPct`, `positionSizing`, `kellyFraction` |
| `signals.minConfidence` | Gate threshold before recording/trading a signal |
| `telegram` | Bot token, chat ID, enabled flag |

API keys are never in config files — they come from `.env` (`EXCHANGE_API_KEY`, `EXCHANGE_API_SECRET`).

### Snowball system (`config.futures.enabled: true`)

When futures are enabled, CellEngine runs a parallel futures sub-account:

- **`futuresExchange.js` (`FuturesExchange`)** — wraps `krakenfutures` ccxt (or simulates paper fills). Supports long/short via `openPosition(side)` / `closePositionMarket()`. Paper mode reads real prices via `_spotRef`.
- **`krakenEarn.js` (`KrakenEarn`)** — allocates idle spot USDT to Kraken Earn (~5% APY). Paper mode simulates accrual. Tracks pending yield.
- **`capitalRouter.js` (`CapitalRouter`)** — called every cycle. Stakes idle spot USDT above `minSpotReserve`. Routes 80% of yield → futures wallet (Kraken WalletTransfer API in live), re-stakes 20%.
- **`safeguards.js` (`Safeguards`)** — circuit breakers: 20% peak drawdown halts futures (lifted on next yield injection), 25% per-trade cap, 3-consecutive-loss throttle (50% size cut).

Capital split: `futures.capitalPct` (default 30%) seeded to futures on startup. Spot never bails out futures — only staking yield fuels it.

Futures strategies: MeanReversion + Momentum on `futures.pairs`. One open position per pair max. ATR-based stops (2× ATR SL, 4× ATR TP).

### Data flow summary

```
index.js
  └─ CellEngine
       ├─ PaperExchange | ExchangeManager  (spot: market data + orders)
       ├─ FuturesExchange                  (long/short perpetual positions)
       ├─ KrakenEarn                       (idle USDT staking + yield)
       ├─ CapitalRouter                    (yield → futures transfer loop)
       ├─ Safeguards                       (futures circuit breakers)
       ├─ Portfolio                         (spot position/PnL tracking)
       ├─ RiskManager                       (halt + size)
       ├─ Strategies[]                      (spot: accumulator + MR + momentum)
       ├─ _futuresStrategies[]              (futures: MR + momentum)
       ├─ SignalGenerator                   (record + notify)
       └─ TradeDB                           (SQLite persistence)
```

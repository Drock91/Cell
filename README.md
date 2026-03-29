# Cell — Crypto Trading Engine

Automated crypto trading bot running on Kraken. Node.js, paper + live modes. Built around a core accumulation strategy with a futures snowball layer on top.

---

## The Strategy

### Philosophy

Bear markets are for building bags. Bull markets are for selling them. Cell accumulates a fixed portfolio of high-conviction assets on every dip, lets mean-reversion and momentum trade around those bags, and runs a small leveraged futures account funded entirely by staking yield — so the spot bags are never at risk from futures losses.

---

## Layer 1 — Spot Accumulation (70% of capital)

The accumulator is the backbone. It DCA buys a fixed basket of tokens on a timer, then amplifies buys when price dips.

**Portfolio allocation:**
| Token | Allocation | Thesis |
|---|---|---|
| ETH | 30% | Core L1 hold |
| SOL | 20% | High-growth L1 |
| XRP | 15% | Priority accumulation — liquid, high volume |
| XLM | 15% | Priority accumulation — correlated with XRP |
| LINK | 10% | Oracle infrastructure |
| SUI | 10% | Speculative L1 |

**How it buys:**
- **Base DCA** — buys every 2 hours per pair regardless of conditions
- **Dip buy** — price drops 2%+ off recent high → 2.5× normal size
- **Big dip buy** — price drops 6%+ off recent high → 3.5× normal size
- **Priority multiplier** — XRP and XLM get 1.5× size on all dip buys
- **Scalp sell** — sells 15% of bag when price pops 2%+ from recent low, freeing capital for the next dip

The accumulator runs even when the main risk manager halts regular trading. It keeps buying dips in bear markets — that's the whole point.

---

## Layer 2 — Spot Trading Strategies (ride the bags up)

Two active strategies trade around the accumulated positions on 5-minute candles.

**Mean Reversion**
- Bollinger Bands (20-period, 1.3σ) + RSI (14-period)
- Buys when price touches lower band AND RSI < 45 (oversold)
- Sells when price touches upper band AND RSI > 58 (overbought)
- Only longs in bear macro — no counter-trend spot shorts

**Momentum**
- EMA crossover (8/21) + MACD confirmation + volume filter
- Buys EMA cross with MACD histogram confirming + volume 5%+ above average
- Trend-following layer — catches breakouts the accumulator misses

**Macro filter** — BTC 4h EMA50 determines market regime. In bear mode:
- Momentum and MR long signals are blocked on spot
- Only accumulator DCA buys continue
- Futures shift to shorts-only

---

## Layer 3 — Futures Snowball (30% of capital, self-funded)

The futures sub-account starts with 30% of capital ($300 on $1000). It is **not** topped up from spot — it runs on its own balance plus staking yield routed in from Layer 4.

**Rules:**
- Max 2 simultaneous positions
- Max 20% of futures balance per trade
- 3× leverage
- Only trades in macro direction (bear = shorts only, bull = longs only)
- Minimum 75% signal confidence to enter (higher bar than spot)
- ATR-based stops: 5× ATR stop loss, 10× ATR take profit (2:1 R:R)

**Circuit breakers (Safeguards):**
- 20% drawdown from peak → futures halted, 24h auto-resume
- 3 consecutive losses → position size halved
- 25% hard cap per single trade
- Drawdown peak persisted to DB — halt survives engine restarts

---

## Layer 4 — Staking Yield Router (KrakenEarn)

Idle spot USDT above $100 reserve is staked via Kraken Earn (~5% APY). Yield is split:
- 80% → futures wallet (funds the snowball)
- 20% → re-staked (compounds)

The idea: spot bags generate passive yield → yield funds futures trades → futures profits (if any) stay in futures. Spot is never drained to bail out futures.

---

## Risk Controls

| Control | Value |
|---|---|
| Max daily loss (spot) | 8% → trading halted for the day |
| Max drawdown (spot) | 30% → trading halted |
| Max drawdown (futures) | 20% → futures halted 24h |
| Position sizing | Kelly criterion (25% fraction) |
| Coast mode | Up 3%+ on the day → only ≥78% confidence signals |
| Bear macro | Spot longs blocked, futures shorts only |
| Min signal confidence | 55% spot, 75% futures |

---

## Commands

```bash
npm start                          # Paper trade
npm run start:live                 # Live trade
npm run backtest                   # Backtester
node src/index.js --dashboard      # Paper trade with terminal dashboard
node src/index.js --live --dashboard
```

## Config files

| File | Purpose |
|---|---|
| `config.paper.yaml` | Paper mode — $1000 simulated, real prices |
| `config.live.yaml` | Live mode — real orders on Kraken |

API keys go in `.env` only — never in config files.

```
EXCHANGE_API_KEY=...
EXCHANGE_API_SECRET=...
```

## Data

- `data/paper.db` — paper trade history, signals, accumulator state
- `data/live.db` — live trade history

Both SQLite. Accumulator state and futures positions persist across restarts.

# CELL - Launch Guide

## What is Cell?

An autonomous crypto trading engine with 3 strategies (grid, mean reversion, momentum) that hunts for profit 24/7. Built-in risk management, Telegram alerts, and a signals system you can monetize.

## Revenue Streams

1. **Direct Trading** - Cell trades your capital on crypto exchanges
2. **Signals Subscription** - Sell Cell's trading signals via Telegram ($10-50/mo per subscriber)

---

## Step 1: Get an Exchange Account

Pick one (Cell supports all of these):
- **Kraken** (recommended for US) - https://kraken.com
- **Coinbase Advanced** - https://coinbase.com
- **Bybit** - https://bybit.com

1. Sign up and verify identity
2. Deposit $100-200 USDT (or USD)
3. Go to API settings and create an API key
   - Enable: **Read**, **Trade**
   - Disable: Withdraw (for safety)
4. Copy the API key and secret

## Step 2: Configure Cell

```bash
# Copy the example env file
cp .env.example .env

# Edit .env with your API keys
# EXCHANGE_API_KEY=your_key
# EXCHANGE_API_SECRET=your_secret
```

Edit `config.yaml`:
- Set `exchange.name` to your exchange (kraken, coinbase, bybit)
- Set `startingCapital` to your deposit amount
- Leave `mode: paper` for initial testing

## Step 3: Paper Trade First (IMPORTANT)

```bash
# Run backtest against historical data
npm run backtest

# Start paper trading (no real money)
npm start
```

Watch the logs. Let it run for 24-48 hours in paper mode. Verify:
- Strategies are generating signals
- Risk management is working
- No errors in the logs

## Step 4: Go Live

Once paper trading looks good:

```bash
# Option A: Edit config.yaml
# Set mode: live
# Set exchange.sandbox: false

# Option B: Use CLI flag
node src/index.js --live
```

## Step 5: Set Up Telegram Monitoring (Optional but recommended)

1. Message @BotFather on Telegram
2. Create a new bot, get the token
3. Message your bot, then get your chat ID from: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Add to .env:
   ```
   TELEGRAM_BOT_TOKEN=your_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```
5. Set `telegram.enabled: true` in config.yaml

Commands: /status, /positions, /trades, /signals, /pnl, /pause, /resume

## Step 6: Monetize Signals

Cell generates trading signals that other people will pay for:

1. Create a public Telegram channel (e.g., "Cell Trading Signals")
2. Set up a subscription (use Telegram's built-in paid channels, or Whop/Gumroad)
3. Price: $10-50/month depending on performance
4. Cell auto-posts signals to your channel

Revenue math: 20 subscribers x $25/mo = $500/mo passive income

## Running 24/7

To keep Cell running on a server:

```bash
# Option 1: Use PM2 (recommended)
npm install -g pm2
pm2 start src/index.js --name cell
pm2 save
pm2 startup

# Option 2: Use screen/tmux on Linux
screen -S cell
node src/index.js --live
# Ctrl+A then D to detach
```

For cheapest hosting: a $5/mo VPS on Hetzner, DigitalOcean, or Vultr is enough.

---

## Safety Rules

- ALWAYS paper trade first before going live
- Start with small capital ($100-150)
- Cell has automatic stop losses and max drawdown protection
- Risk controls: max 5% daily loss, max 15% drawdown = auto-halt
- Never deposit money you can't afford to lose
- Monitor daily via Telegram or dashboard

## Commands Reference

```bash
npm start              # Start trading (paper mode)
npm run backtest       # Run backtester
node src/index.js --live        # Live trading
node src/index.js --dashboard   # Live dashboard view
npm run bot            # Run Telegram bot standalone
```

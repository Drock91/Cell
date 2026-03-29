const ccxt = require("ccxt");
const { getLogger } = require("./logger");

/**
 * FuturesExchange — wraps krakenfutures (or paper simulation).
 *
 * Unlike spot, futures supports true long AND short positions.
 * Positions are tracked internally and mapped to the portfolio.
 *
 * In paper mode: simulates fills, no real orders.
 * In live mode: uses krakenfutures ccxt with separate API keys.
 */
class FuturesExchange {
  constructor(config, isPaper = false) {
    this.config = config;
    this.isPaper = isPaper;
    this.exchange = null;
    this._balance = 0;
    this._nextOrderId = 1;
    this._fees = 0;

    // Paper mode virtual balance
    this._paperBalance = 0;
    this._paperPositions = new Map(); // symbol -> { side, amount, entryPrice, leverage }
  }

  async connect(initialBalance = 0) {
    const log = getLogger();
    const fc = this.config.futures;

    if (this.isPaper) {
      this._paperBalance = initialBalance;
      log.info(`[FUTURES-PAPER] Connected — $${initialBalance.toFixed(2)} virtual USDT`);
      return;
    }

    const ExchangeClass = ccxt["krakenfutures"];
    if (!ExchangeClass) throw new Error("krakenfutures not found in ccxt");

    this.exchange = new ExchangeClass({
      apiKey:          fc.apiKey,
      secret:          fc.apiSecret,
      enableRateLimit: true,
      timeout:         30000,
      options:         { defaultType: "swap" },
    });

    await this._refreshBalance();
    log.info(`[FUTURES] Connected — balance: $${this._balance.toFixed(2)} USDT`);
  }

  async close() {
    if (this.exchange) await this.exchange.close();
  }

  async refreshBalance() {
    if (this.isPaper) return;
    await this._refreshBalance();
  }

  async _refreshBalance() {
    try {
      const bal = await this.exchange.fetchBalance();
      this._balance = Number(bal.free?.USDT || bal.total?.USDT || 0);
    } catch (e) {
      getLogger().debug(`[FUTURES] Balance fetch error: ${e.message}`);
    }
  }

  getBalance() {
    return this.isPaper ? this._paperBalance : this._balance;
  }

  setPaperBalance(balance) {
    this._paperBalance = balance;
  }

  getFree(asset = "USDT") {
    if (asset !== "USDT") return 0;
    return this.getBalance();
  }

  async fetchOHLCV(symbol, timeframe = "5m", limit = 200) {
    if (this.isPaper) {
      // Paper futures use real market data from a spot exchange reference
      // This is set by the engine after construction
      if (this._spotRef) return this._spotRef.fetchOHLCV(symbol.replace(":USD", ""), timeframe, limit);
      return [];
    }
    return await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  }

  async fetchTicker(symbol) {
    if (this.isPaper) {
      if (this._spotRef) return this._spotRef.fetchTicker(symbol.replace(":USD", ""));
      return { last: 0, bid: 0, ask: 0 };
    }
    return await this.exchange.fetchTicker(symbol);
  }

  // ── Order placement ──────────────────────────────────────────────────────

  /**
   * Open a long or short position.
   * side: "buy" = long, "sell" = short
   */
  async openPosition(symbol, side, amount, price, leverage) {
    const lev = Math.min(leverage || 3, this.config.futures.maxLeverage || 3);
    const margin = (amount * price) / lev;
    const fee = amount * price * 0.0006; // ~0.06% futures taker fee

    if (this.isPaper) {
      const available = this._paperBalance;
      if (margin + fee > available) {
        throw new Error(`[FUTURES-PAPER] Insufficient margin: have $${available.toFixed(2)}, need $${(margin + fee).toFixed(2)}`);
      }
      this._paperBalance -= (margin + fee);
      this._fees += fee;

      const dir = side === "buy" ? "LONG" : "SHORT";
      getLogger().info(`[FUTURES-PAPER] OPEN ${dir} ${amount.toFixed(4)} ${symbol} @ $${price.toFixed(4)} | margin -$${margin.toFixed(2)}`);

      return this._paperOrder(symbol, side, amount, price, fee);
    }

    // Live: set leverage first
    try {
      await this.exchange.setLeverage(lev, symbol);
    } catch (e) {
      getLogger().debug(`[FUTURES] setLeverage warn: ${e.message}`);
    }

    const order = side === "buy"
      ? await this.exchange.createLimitBuyOrder(symbol, amount, price)
      : await this.exchange.createLimitSellOrder(symbol, amount, price);

    await this._refreshBalance();
    return order;
  }

  /**
   * Close an existing position (reverse side).
   * entryPrice + leverage required in paper mode to compute correct margin return.
   * Model: balance gets back (margin + PnL - fee). Full notional is NOT in the balance.
   */
  async closePosition(symbol, side, amount, price, entryPrice, leverage) {
    const closeSide = side === "buy" ? "sell" : "buy";
    const fee = amount * price * 0.0006;

    if (this.isPaper) {
      const lev = leverage || this.config.futures?.leverage || 3;
      const ep  = entryPrice || price; // fallback — no gain/loss if entry unknown
      const margin = (amount * ep) / lev;
      const pnl = side === "buy"
        ? (price - ep) * amount
        : (ep - price) * amount;
      const netReturn = margin + pnl - fee;

      this._paperBalance += Math.max(0, netReturn); // can't lose more than margin
      this._fees += fee;

      const dir    = side === "buy" ? "LONG" : "SHORT";
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      getLogger().info(`[FUTURES-PAPER] CLOSE ${dir} ${amount.toFixed(4)} ${symbol} @ $${price.toFixed(4)} | PnL ${pnlStr} | returned $${netReturn.toFixed(2)}`);

      return this._paperOrder(symbol, closeSide, amount, price, fee);
    }

    const order = closeSide === "sell"
      ? await this.exchange.createLimitSellOrder(symbol, amount, price, { reduceOnly: true })
      : await this.exchange.createLimitBuyOrder(symbol, amount, price, { reduceOnly: true });

    await this._refreshBalance();
    return order;
  }

  // Market close for stop-loss / take-profit
  async closePositionMarket(symbol, side, amount, entryPrice, leverage) {
    if (this.isPaper) {
      const ticker = await this.fetchTicker(symbol);
      const price = side === "buy" ? (ticker.bid || ticker.last) : (ticker.ask || ticker.last);
      return this.closePosition(symbol, side, amount, price, entryPrice, leverage);
    }

    const closeSide = side === "buy" ? "sell" : "buy";
    return closeSide === "sell"
      ? await this.exchange.createMarketSellOrder(symbol, amount, { reduceOnly: true })
      : await this.exchange.createMarketBuyOrder(symbol, amount, { reduceOnly: true });
  }

  async fetchOpenOrders() { return []; }

  _paperOrder(symbol, side, amount, price, fee) {
    return {
      id:        String(this._nextOrderId++),
      symbol,
      side,
      type:      "limit",
      amount,
      price,
      cost:      amount * price,
      fee:       { cost: fee, currency: "USDT" },
      status:    "closed",
      filled:    amount,
      timestamp: Date.now(),
    };
  }

  // ── Kraken internal wallet transfer ──────────────────────────────────────

  /**
   * Receive USDT transferred from spot wallet into futures wallet.
   * In live mode: Kraken handles this via WalletTransfer API (called from CapitalRouter).
   * In paper mode: we just add to virtual balance.
   */
  receiveTransfer(amountUsdt) {
    if (this.isPaper) {
      this._paperBalance += amountUsdt;
      getLogger().info(`[FUTURES-PAPER] Received $${amountUsdt.toFixed(2)} from spot yield`);
    }
    // Live: balance refreshed automatically after WalletTransfer API call
  }
}

module.exports = { FuturesExchange };

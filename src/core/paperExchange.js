const { getLogger } = require("./logger");

/**
 * PaperExchange - reads real live prices, simulates fills.
 * No real orders ever touch the exchange.
 */
class PaperExchange {
  constructor(realExchange, startingCapital) {
    this.real = realExchange;
    this.exchange = realExchange.exchange;
    this.config = realExchange.config;
    this._nextOrderId = 1;
    this._orders = [];
    this._fees = 0;

    // Only hold USD - the quote currency for both pairs
    this.virtualBalances = {
      free:  { USD: startingCapital },
      used:  {},
      total: { USD: startingCapital },
    };
  }

  async connect() {
    await this.real.connect();
    getLogger().info(`[PAPER] Connected - $${this.virtualBalances.free.USD.toFixed(2)} virtual USD`);
  }

  async close() {
    await this.real.close();
  }

  async refreshBalance() {
    return this.virtualBalances;
  }

  get balances() {
    return this.virtualBalances;
  }

  getFree(asset = "USD") {
    return Number(this.virtualBalances.free[asset] || 0);
  }

  // ── Market data - always real ──────────────────────────
  async fetchOHLCV(symbol, timeframe, since, limit) {
    return this.real.fetchOHLCV(symbol, timeframe, limit);
  }
  async fetchTicker(symbol)          { return this.real.fetchTicker(symbol); }
  async fetchOrderBook(symbol, lim)  { return this.real.fetchOrderBook(symbol, lim); }
  async fetchOpenOrders(symbol)      { return this._orders.filter(o => o.status === "open" && (!symbol || o.symbol === symbol)); }
  async fetchOrder(id)               { return this._orders.find(o => o.id === id) || null; }

  // ── Order placement - simulated ────────────────────────
  async createLimitBuy(symbol, amount, price) {
    return this._buy(symbol, amount, price);
  }
  async createLimitSell(symbol, amount, price) {
    return this._sell(symbol, amount, price);
  }
  async createMarketBuy(symbol, amount) {
    const t = await this.real.fetchTicker(symbol);
    return this._buy(symbol, amount, t.ask || t.last);
  }
  async createMarketSell(symbol, amount) {
    const t = await this.real.fetchTicker(symbol);
    return this._sell(symbol, amount, t.bid || t.last);
  }
  async cancelOrder(orderId) {
    const o = this._orders.find(o => o.id === String(orderId));
    if (o) o.status = "canceled";
    return o;
  }

  _buy(symbol, amount, price) {
    const [base] = symbol.split("/");
    const cost = amount * price;
    const fee  = cost * 0.0016;
    const total = cost + fee;

    const usd = this.getFree("USD");
    if (usd < total) {
      throw new Error(`[PAPER] Insufficient USD: have $${usd.toFixed(2)}, need $${total.toFixed(2)}`);
    }

    this._adj("USD",  -total);
    this._adj(base,   amount);
    this._fees += fee;

    getLogger().info(`[PAPER] BUY  ${amount.toFixed(4)} ${base} @ $${price.toFixed(4)} | -$${total.toFixed(3)} USD`);
    return this._order(symbol, "buy", amount, price, fee);
  }

  _sell(symbol, amount, price) {
    const [base] = symbol.split("/");
    const proceeds = amount * price;
    const fee = proceeds * 0.0016;
    const net = proceeds - fee;

    const held = this.getFree(base);
    if (held < amount) {
      throw new Error(`[PAPER] Insufficient ${base}: have ${held.toFixed(4)}, need ${amount.toFixed(4)}`);
    }

    this._adj(base,  -amount);
    this._adj("USD",  net);
    this._fees += fee;

    getLogger().info(`[PAPER] SELL ${amount.toFixed(4)} ${base} @ $${price.toFixed(4)} | +$${net.toFixed(3)} USD`);
    return this._order(symbol, "sell", amount, price, fee);
  }

  /**
   * Called on startup to sync accumulator bags restored from DB into virtual
   * balances. Credits the tokens and debits what was spent so the paper
   * balance reflects the real state of the simulated portfolio.
   */
  creditRestoredBags(base, amount, totalSpent) {
    this._adj(base,   amount);
    this._adj("USD", -totalSpent);
    getLogger().info(`[PAPER] Restored ${amount.toFixed(4)} ${base} (spent $${totalSpent.toFixed(2)})`);
  }

  _adj(asset, delta) {
    this.virtualBalances.free[asset]  = Math.max(0, (this.virtualBalances.free[asset]  || 0) + delta);
    this.virtualBalances.total[asset] = this.virtualBalances.free[asset];
  }

  _order(symbol, side, amount, price, fee) {
    const o = {
      id:        String(this._nextOrderId++),
      symbol,
      side,
      type:      "limit",
      amount,
      price,
      cost:      amount * price,
      fee:       { cost: fee, currency: "USD" },
      status:    "closed",
      filled:    amount,
      timestamp: Date.now(),
    };
    this._orders.push(o);
    return o;
  }
}

module.exports = { PaperExchange };

const ccxt = require("ccxt");
const { getLogger } = require("./logger");

class ExchangeManager {
  constructor(config) {
    this.config = config;
    this.exchange = null;
    this._balances = { total: {}, free: {}, used: {} };
  }

  async connect() {
    const name = this.config.exchange.name;
    const ExchangeClass = ccxt[name];

    if (!ExchangeClass) {
      throw new Error(`Exchange "${name}" not supported by ccxt`);
    }

    this.exchange = new ExchangeClass({
      apiKey: this.config.exchange.apiKey,
      secret: this.config.exchange.apiSecret,
      sandbox: this.config.exchange.sandbox,
      enableRateLimit: true,
      timeout: 30000,  // 30s — prevents hanging forever if Kraken stalls
      options: { defaultType: "spot" },
    });

    const log = getLogger();
    if (this.config.exchange.sandbox) {
      this.exchange.setSandboxMode(true);
      log.info(`Connected to ${name} SANDBOX (paper trading)`);
    } else {
      log.info(`Connected to ${name} LIVE`);
    }

    await this.refreshBalance();
  }

  async close() {
    if (this.exchange) {
      await this.exchange.close();
    }
  }

  async refreshBalance() {
    const bal = await this.exchange.fetchBalance();
    this._balances = {
      total: bal.total || {},
      free: bal.free || {},
      used: bal.used || {},
    };
    return this._balances;
  }

  get balances() {
    return this._balances;
  }

  getFree(asset = "USDT") {
    return Number(this._balances.free[asset] || 0);
  }

  async fetchOHLCV(symbol, timeframe = "5m", limit = 200) {
    return await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  }

  async fetchTicker(symbol) {
    return await this.exchange.fetchTicker(symbol);
  }

  async fetchOrderBook(symbol, limit = 20) {
    return await this.exchange.fetchOrderBook(symbol, limit);
  }

  async createLimitBuy(symbol, amount, price) {
    getLogger().info(`BUY ${amount.toFixed(6)} ${symbol} @ ${price.toFixed(2)}`);
    return await this.exchange.createLimitBuyOrder(symbol, amount, price);
  }

  async createLimitSell(symbol, amount, price) {
    getLogger().info(`SELL ${amount.toFixed(6)} ${symbol} @ ${price.toFixed(2)}`);
    return await this.exchange.createLimitSellOrder(symbol, amount, price);
  }

  async createMarketBuy(symbol, amount) {
    getLogger().info(`MARKET BUY ${amount.toFixed(6)} ${symbol}`);
    return await this.exchange.createMarketBuyOrder(symbol, amount);
  }

  async createMarketSell(symbol, amount) {
    getLogger().info(`MARKET SELL ${amount.toFixed(6)} ${symbol}`);
    return await this.exchange.createMarketSellOrder(symbol, amount);
  }

  async cancelOrder(orderId, symbol) {
    getLogger().info(`CANCEL order ${orderId} on ${symbol}`);
    return await this.exchange.cancelOrder(orderId, symbol);
  }

  async fetchOpenOrders(symbol) {
    return await this.exchange.fetchOpenOrders(symbol);
  }

  async fetchOrder(orderId, symbol) {
    return await this.exchange.fetchOrder(orderId, symbol);
  }
}

module.exports = { ExchangeManager };

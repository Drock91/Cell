const { getLogger } = require("./logger");

/**
 * CapitalRouter — the snowball's heartbeat.
 *
 * Responsibilities (runs every cycle):
 *  1. Stake idle spot USDT into Kraken Earn (keeps spot fully productive).
 *  2. Poll accumulated staking yield.
 *  3. When yield ≥ threshold: send 80% to futures wallet, keep 20% to compound staking.
 *  4. Enforce minimum spot USDT reserve before any transfer.
 *  5. Never pull principal from spot to bail out futures — yield only.
 *
 * In live mode: uses Kraken WalletTransfer API (spot ↔ futures, instant, free).
 * In paper mode: directly adjusts virtual balances on both exchange objects.
 */

const YIELD_SPLIT_FUTURES = 0.80;   // 80% of yield → futures
const YIELD_SPLIT_SPOT    = 0.20;   // 20% stays to compound staking base
const MIN_TRANSFER_USD    = 0.50;   // don't transfer tiny amounts
const IDLE_THRESHOLD_USD  = 5.00;   // stake if free spot USDT > this
const MIN_SPOT_RESERVE    = 20.00;  // never drop spot free USDT below this

class CapitalRouter {
  constructor({ spotExchange, futuresExchange, krakenEarn, config, isPaper }) {
    this.spot    = spotExchange;
    this.futures = futuresExchange;
    this.earn    = krakenEarn;
    this.config  = config;
    this.isPaper = isPaper;

    // Stats
    this.totalYieldCollected  = 0;
    this.totalSentToFutures   = 0;
    this.totalReStaked        = 0;
  }

  /**
   * Main entry — call once per engine cycle.
   * Safe to call frequently; each sub-step is internally rate-limited.
   */
  async tick() {
    await this._stakeIdleUsdt();
    await this._routeYield();
  }

  // ── Step 1: Stake idle USDT ───────────────────────────────────────────────

  async _stakeIdleUsdt() {
    const freeUsdt = this.isPaper
      ? this.spot.getFree("USD")
      : this.spot.getFree("USDT");

    const reserve  = this.config.capitalRouter?.minSpotReserve || MIN_SPOT_RESERVE;
    const idle     = freeUsdt - reserve;

    if (idle < IDLE_THRESHOLD_USD) return;  // not enough to bother

    await this.earn.allocate(idle);

    if (!this.isPaper) {
      // Live: balance will reflect after next refreshBalance() call
    }
  }

  // ── Step 2: Collect yield and route it ───────────────────────────────────

  async _routeYield() {
    const pending = await this.earn.getPendingYield();
    const threshold = this.config.capitalRouter?.yieldTransferThreshold || MIN_TRANSFER_USD;

    if (pending < threshold) return;

    const collected = await this.earn.collectYield();
    if (collected < 0.01) return;

    this.totalYieldCollected += collected;

    const toFutures = collected * YIELD_SPLIT_FUTURES;
    const toStaking = collected * YIELD_SPLIT_SPOT;

    const log = getLogger();

    // Re-stake the 20% compounding portion
    if (toStaking >= 0.50) {
      await this.earn.allocate(toStaking);
      this.totalReStaked += toStaking;
    }

    // Send 80% to futures
    if (toFutures < 0.10) return;

    await this._transferToFutures(toFutures);
    this.totalSentToFutures += toFutures;

    log.info(
      `[ROUTER] Yield routed: $${collected.toFixed(2)} collected | ` +
      `→ futures $${toFutures.toFixed(2)} | → re-staked $${toStaking.toFixed(2)} | ` +
      `total sent to futures: $${this.totalSentToFutures.toFixed(2)}`
    );
  }

  // ── Transfer mechanics ────────────────────────────────────────────────────

  async _transferToFutures(amount) {
    if (this.isPaper) {
      // Paper: just credit the virtual futures balance directly
      this.futures.receiveTransfer(amount);
      return;
    }

    // Live: Kraken WalletTransfer (spot → futures, instant and free)
    try {
      await this.spot.exchange.privatePostWalletTransfer({
        asset:  "USDT",
        from:   "Spot Wallet",
        to:     "Futures Wallet",
        amount: String(amount),
      });
      // futures balance will be updated on next _refreshBalance() call
      this.futures.receiveTransfer(amount);  // update live internal counter
      getLogger().info(`[ROUTER] WalletTransfer $${amount.toFixed(2)} USDT → Futures`);
    } catch (e) {
      getLogger().warn(`[ROUTER] WalletTransfer failed: ${e.message}`);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStats() {
    return {
      staked:           this.earn.getStakedAmount(),
      totalYield:       this.totalYieldCollected,
      totalToFutures:   this.totalSentToFutures,
      totalReStaked:    this.totalReStaked,
    };
  }
}

module.exports = { CapitalRouter };

const { getLogger } = require("./logger");

/**
 * KrakenEarn — allocates idle USDT to Kraken Earn and tracks yield.
 *
 * In paper mode: simulates 5% APY accrual on tracked balance.
 * In live mode: uses Kraken REST API (private endpoint) to allocate/deallocate
 *   and poll earned rewards.
 *
 * Kraken Earn API endpoints used:
 *   POST /0/private/Earn/Allocate   — allocate amount to a strategy
 *   POST /0/private/Earn/Deallocate — pull back amount
 *   GET  /0/private/Earn/Allocations — current positions + pending rewards
 *
 * USDT strategy ID on Kraken: "USDT.M" (flexible, instant withdrawal, ~5% APY)
 */

const USDT_STRATEGY_ID = "USDT.M";   // Kraken Earn flexible USDT strategy
const APY_PAPER        = 0.25;        // 25% APY for paper simulation (models active yield portfolio)
const POLL_MS          = 3_600_000;   // check yield every 1h

class KrakenEarn {
  constructor(exchange, isPaper = false, paperSpotExchange = null) {
    this.ex        = exchange;  // raw ccxt instance (live only)
    this.isPaper   = isPaper;
    this._paperEx  = paperSpotExchange;  // PaperExchange ref — to deduct virtual USD on stake

    // Paper simulation state
    this._paperStaked  = 0;    // USDT currently simulated-staked
    this._paperYield   = 0;    // accumulated unredeemed yield
    this._lastAccrual  = Date.now();

    // Live state (populated from API)
    this._stakedLive   = 0;
    this._pendingYield = 0;

    this._lastPoll     = 0;
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  /**
   * Stake `amount` USDT into Kraken Earn.
   * Call this after the spot bot has confirmed idle USDT to allocate.
   */
  async allocate(amount) {
    if (amount < 1) return;
    const log = getLogger();

    if (this.isPaper) {
      this._accrueYield();
      // Deduct from virtual spot balance so it doesn't get re-staked next cycle
      if (this._paperEx) {
        const actualFree = this._paperEx.getFree("USD");
        const toStake = Math.min(amount, actualFree);
        if (toStake < 1) return;
        this._paperEx._adj("USD", -toStake);
        this._paperStaked += toStake;
        log.info(`[EARN-PAPER] Allocated $${toStake.toFixed(2)} USDT — staked total: $${this._paperStaked.toFixed(2)}`);
      } else {
        this._paperStaked += amount;
        log.info(`[EARN-PAPER] Allocated $${amount.toFixed(2)} USDT — staked total: $${this._paperStaked.toFixed(2)}`);
      }
      return;
    }

    try {
      await this.ex.privatePostEarnAllocate({
        strategy_id: USDT_STRATEGY_ID,
        amount:      String(amount),
      });
      this._stakedLive += amount;
      log.info(`[EARN] Allocated $${amount.toFixed(2)} USDT to Kraken Earn`);
    } catch (e) {
      log.warn(`[EARN] Allocate failed: ${e.message}`);
    }
  }

  /**
   * Withdraw `amount` USDT from Earn back to spot wallet.
   * Used when capitalRouter needs to fund a transfer to futures.
   */
  async deallocate(amount) {
    if (amount < 1) return;
    const log = getLogger();

    if (this.isPaper) {
      this._accrueYield();
      const withdrawn = Math.min(amount, this._paperStaked);
      this._paperStaked = Math.max(0, this._paperStaked - withdrawn);
      // Return funds to virtual spot balance
      if (this._paperEx && withdrawn > 0) this._paperEx._adj("USD", withdrawn);
      log.info(`[EARN-PAPER] Deallocated $${withdrawn.toFixed(2)} USDT — staked total: $${this._paperStaked.toFixed(2)}`);
      return;
    }

    try {
      await this.ex.privatePostEarnDeallocate({
        strategy_id: USDT_STRATEGY_ID,
        amount:      String(amount),
      });
      this._stakedLive = Math.max(0, this._stakedLive - amount);
      log.info(`[EARN] Deallocated $${amount.toFixed(2)} USDT from Kraken Earn`);
    } catch (e) {
      log.warn(`[EARN] Deallocate failed: ${e.message}`);
    }
  }

  // ── Yield tracking ────────────────────────────────────────────────────────

  /**
   * Returns the currently pending (uncollected) yield in USDT.
   * In live mode, polls the API at most once per hour.
   */
  async getPendingYield() {
    if (this.isPaper) {
      this._accrueYield();
      return this._paperYield;
    }

    const now = Date.now();
    if (now - this._lastPoll < POLL_MS) return this._pendingYield;

    try {
      const res = await this.ex.privateGetEarnAllocations();
      this._lastPoll = now;

      const items = res?.result?.items || [];
      const usdt  = items.find(i => i.strategy_id === USDT_STRATEGY_ID);

      if (usdt) {
        this._stakedLive   = Number(usdt.amount_allocated?.bonded || 0);
        this._pendingYield = Number(usdt.total_rewarded           || 0);
      }
    } catch (e) {
      getLogger().debug(`[EARN] Allocation poll error: ${e.message}`);
    }

    return this._pendingYield;
  }

  /**
   * "Collect" yield: zeroes pending yield and returns the amount collected.
   * In live mode yield is credited automatically by Kraken — this just resets
   * our internal counter so capitalRouter can track what it has sent to futures.
   */
  async collectYield() {
    if (this.isPaper) {
      this._accrueYield();
      const y = this._paperYield;
      this._paperYield = 0;
      return y;
    }

    // Live: pending yield is already in the spot wallet once Kraken credits it.
    // We just snapshot and reset our counter.
    const y = this._pendingYield;
    this._pendingYield = 0;
    return y;
  }

  getStakedAmount() {
    return this.isPaper ? this._paperStaked : this._stakedLive;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _accrueYield() {
    if (this._paperStaked <= 0) return;
    const now     = Date.now();
    const elapsed = (now - this._lastAccrual) / 1000;           // seconds
    const perSec  = APY_PAPER / 365 / 24 / 3600;
    this._paperYield  += this._paperStaked * perSec * elapsed;
    this._lastAccrual  = now;
  }
}

module.exports = { KrakenEarn };

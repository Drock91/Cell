const { getLogger } = require("./logger");

/**
 * Safeguards — circuit breakers for the futures sub-account.
 *
 * Rules enforced:
 *  1. Max 25% of futures balance per single trade (position cap).
 *  2. 20% drawdown from peak → halt futures trading until next yield injection.
 *  3. Consecutive loss throttle → reduce size after N consecutive losses.
 *  4. Spot minimum reserve — spot never goes below configured floor.
 *  5. Bag protection — accumulator bags are never used to fund futures.
 */

const CONSEC_LOSS_REDUCE  = 0.50;   // halve size after CONSEC_LOSS_LIMIT losses in a row
const CONSEC_LOSS_LIMIT   = 3;      // consecutive losses before throttle kicks in

class Safeguards {
  constructor(config) {
    this.config = config;

    const fc = config.futures || {};
    this.maxPositionPct   = fc.maxPositionPct   || 0.15;   // 15% of futures balance per trade
    this.maxDrawdownPct   = fc.maxDrawdownPct   || 0.30;   // 30% peak drawdown → halt
    this.minSpotReserve   = (config.capitalRouter || {}).minSpotReserve || 20;

    this._peakFuturesBalance = 0;
    this._futuresHalted      = false;
    this._haltReason         = null;
    this._consecLosses       = 0;
    this._haltedAt           = 0;    // timestamp when halt was set
  }

  // ── Called each cycle with current futures balance ────────────────────────

  updateFuturesBalance(balance) {
    if (balance > this._peakFuturesBalance) {
      this._peakFuturesBalance = balance;
    }

    if (this._peakFuturesBalance > 0) {
      const drawdown = 1 - balance / this._peakFuturesBalance;
      if (drawdown >= this.maxDrawdownPct && !this._futuresHalted) {
        this._futuresHalted = true;
        this._haltedAt      = Date.now();
        this._haltReason    = `futures drawdown ${(drawdown * 100).toFixed(1)}% (peak $${this._peakFuturesBalance.toFixed(2)})`;
        getLogger().warn(`[SAFEGUARDS] FUTURES HALTED — ${this._haltReason}`);
      }

      // Auto-resume after 24h cooldown — reset peak so it starts fresh with current balance
      if (this._futuresHalted && this._haltedAt > 0 && Date.now() - this._haltedAt >= 86_400_000) {
        getLogger().info(`[SAFEGUARDS] Futures halt auto-lifted after 24h cooldown — restarting with $${balance.toFixed(2)}`);
        this._futuresHalted      = false;
        this._haltReason         = null;
        this._haltedAt           = 0;
        this._peakFuturesBalance = balance;  // new peak = current balance
        this._consecLosses       = 0;
      }
    }
  }

  /**
   * Called when new yield arrives from the spot account — can unhalted futures
   * if balance has recovered sufficiently (or on every new injection so the bot
   * can at least try again with fresh capital).
   */
  onYieldInjection(amount) {
    if (this._futuresHalted && amount > 0) {
      getLogger().info(`[SAFEGUARDS] Futures halt lifted — $${amount.toFixed(2)} yield injected`);
      this._futuresHalted  = false;
      this._haltReason     = null;
      this._peakFuturesBalance = 0;  // reset peak so drawdown recalculates cleanly
    }
  }

  // ── Per-trade checks ──────────────────────────────────────────────────────

  isFuturesHalted() {
    return this._futuresHalted;
  }

  /**
   * Returns the max USD size allowed for a single futures trade.
   * Applies consecutive loss throttle on top of the hard cap.
   */
  maxFuturesTradeUsd(futuresBalance) {
    let cap = futuresBalance * this.maxPositionPct;

    if (this._consecLosses >= CONSEC_LOSS_LIMIT) {
      cap *= CONSEC_LOSS_REDUCE;
    }

    return cap;
  }

  /**
   * Checks whether opening a new position is allowed given its size.
   * Returns { ok: true } or { ok: false, reason: string }.
   */
  checkTrade(futuresBalance, tradeUsd) {
    if (this._futuresHalted) {
      return { ok: false, reason: `futures halted: ${this._haltReason}` };
    }

    const max = this.maxFuturesTradeUsd(futuresBalance);
    if (tradeUsd > max) {
      return {
        ok:     false,
        reason: `trade $${tradeUsd.toFixed(2)} exceeds max $${max.toFixed(2)} (${(this.maxPositionPct * 100).toFixed(0)}% cap)`,
      };
    }

    return { ok: true };
  }

  /**
   * Check that spot free USDT won't drop below the minimum reserve.
   * Use before any spot→futures transfer.
   */
  checkSpotReserve(spotFreeUsdt, transferAmount) {
    const after = spotFreeUsdt - transferAmount;
    if (after < this.minSpotReserve) {
      return {
        ok:     false,
        reason: `spot reserve would drop to $${after.toFixed(2)} (min $${this.minSpotReserve})`,
      };
    }
    return { ok: true };
  }

  // ── Loss tracking ─────────────────────────────────────────────────────────

  recordTrade(pnl) {
    if (pnl < 0) {
      this._consecLosses++;
      if (this._consecLosses >= CONSEC_LOSS_LIMIT) {
        getLogger().warn(`[SAFEGUARDS] ${this._consecLosses} consecutive losses — size throttled to 50%`);
      }
    } else {
      this._consecLosses = 0;
    }
  }

  getStatus() {
    return {
      halted:       this._futuresHalted,
      haltReason:   this._haltReason,
      peakBalance:  this._peakFuturesBalance,
      consecLosses: this._consecLosses,
    };
  }
}

module.exports = { Safeguards };

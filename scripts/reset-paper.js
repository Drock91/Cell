/**
 * reset-paper.js — wipes the paper DB and seeds a fresh $1000 portfolio.
 *
 * Distribution ($1000 total):
 *   $300  futures sub-account (30%) — cash, trades long/short
 *   $175  ETH bag  (15% — core hold)
 *   $140  SOL bag  (14% — momentum L1)
 *   $90   LINK bag (9%  — oracle infra)
 *   $60   SUI bag  (6%  — speculative L1)
 *   $235  free USDT — ~$215 auto-staked to Earn, $20 reserve for MR/momentum
 *
 * Usage:
 *   node scripts/reset-paper.js
 */

require("dotenv").config();
const Database = require("better-sqlite3");
const ccxt     = require("ccxt");
const path     = require("path");
const fs       = require("fs");

const DB_PATH = path.resolve(__dirname, "../data/paper.db");

// ── Capital allocation ──────────────────────────────────────────────────────
const TOTAL           = 1000;
const FUTURES_PCT     = 0.30;    // 30% → futures

// Bag seeds (% of total) — XRP/XLM excluded, let accumulator DCA into them naturally
const BAG_ALLOCATIONS = [
  { pair: "ETH/USD",  pct: 0.175 },  // $175 — 15% core hold
  { pair: "SOL/USD",  pct: 0.140 },  // $140 — 14% momentum L1
  { pair: "LINK/USD", pct: 0.090 },  // $90  — 9%  oracle infra
  { pair: "SUI/USD",  pct: 0.060 },  // $60  — 6%  speculative L1
];
// Remainder stays as free USDT for MR/momentum trades + staking

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  CELL PAPER RESET — $1,000 CLEAN START");
  console.log("═══════════════════════════════════════════════\n");

  // ── Fetch current prices ──────────────────────────────────────────────────
  console.log("Fetching current prices from Kraken...");
  const exchange = new ccxt.kraken({
    enableRateLimit: true,
    timeout:         15000,
  });

  const prices = {};
  for (const { pair } of BAG_ALLOCATIONS) {
    try {
      const ticker = await exchange.fetchTicker(pair);
      prices[pair] = ticker.last || ticker.bid;
      console.log(`  ${pair.padEnd(10)} $${prices[pair].toFixed(4)}`);
    } catch (e) {
      console.log(`  ${pair.padEnd(10)} FAILED (${e.message}) — using fallback`);
      prices[pair] = 0;
    }
  }

  // ── Wipe existing DB ──────────────────────────────────────────────────────
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log("\nWiped old paper.db");
  }

  // ── Create fresh DB ───────────────────────────────────────────────────────
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL, side TEXT NOT NULL,
      entry_price REAL NOT NULL, exit_price REAL,
      amount REAL NOT NULL, strategy TEXT NOT NULL,
      pnl REAL DEFAULT 0, status TEXT DEFAULT 'open',
      opened_at TEXT DEFAULT (datetime('now')), closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL, side TEXT NOT NULL,
      price REAL NOT NULL, strategy TEXT NOT NULL,
      confidence REAL NOT NULL, reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS accumulator_state (
      pair TEXT PRIMARY KEY,
      recent_high REAL DEFAULT 0,
      avg_entry REAL DEFAULT 0,
      total_accumulated REAL DEFAULT 0,
      total_spent REAL DEFAULT 0,
      last_dca_time INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_value REAL NOT NULL,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      bags TEXT
    );
  `);

  // ── Seed accumulator bags ─────────────────────────────────────────────────
  const insert = db.prepare(`
    INSERT OR REPLACE INTO accumulator_state
    (pair, recent_high, avg_entry, total_accumulated, total_spent, last_dca_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const futuresUsd = TOTAL * FUTURES_PCT;
  const spotUsd    = TOTAL - futuresUsd;

  let totalBagSpend = 0;
  const seeded = [];

  console.log("\n── Portfolio Seed ──────────────────────────────");
  console.log(`  Futures sub-account : $${futuresUsd.toFixed(2)}  (${(FUTURES_PCT*100).toFixed(0)}%)`);

  for (const { pair, pct } of BAG_ALLOCATIONS) {
    const usd    = TOTAL * pct;
    const price  = prices[pair];
    if (!price) continue;

    const amount = usd / price;
    totalBagSpend += usd;

    insert.run(
      pair,
      price * 1.02,  // recentHigh slightly above entry
      price,
      amount,
      usd,
      Date.now() - 3_600_000  // set lastDcaTime to 1h ago so first DCA can fire
    );

    seeded.push({ pair, usd, amount, price });
    const base = pair.split("/")[0];
    console.log(`  ${base.padEnd(5)} bag           : $${usd.toFixed(2)}  → ${amount.toFixed(4)} ${base} @ $${price.toFixed(4)}`);
  }

  const freeUsd = spotUsd - totalBagSpend;
  console.log(`  Free USDT (spot)    : $${freeUsd.toFixed(2)}  (staking + MR/momentum float)`);
  console.log("─".repeat(50));
  console.log(`  SPOT TOTAL          : $${spotUsd.toFixed(2)}`);
  console.log(`  FUTURES             : $${futuresUsd.toFixed(2)}`);
  console.log(`  GRAND TOTAL         : $${TOTAL.toFixed(2)}`);

  db.close();
  console.log("\n✓ paper.db seeded. Run: npm start\n");
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});

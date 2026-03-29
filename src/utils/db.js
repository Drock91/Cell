const Database = require("better-sqlite3");
const path = require("path");
const { getLogger } = require("../core/logger");

class TradeDB {
  constructor(dbPath) {
    const root = path.resolve(__dirname, "..", "..");
    this.db = new Database(dbPath || path.join(root, "data", "cell.db"));
    this._init();
  }

  _init() {
    this.db.exec(`
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
        recent_high REAL DEFAULT 0, avg_entry REAL DEFAULT 0,
        total_accumulated REAL DEFAULT 0, total_spent REAL DEFAULT 0,
        last_dca_time INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        total_value REAL NOT NULL,
        realized_pnl REAL DEFAULT 0, unrealized_pnl REAL DEFAULT 0,
        total_trades INTEGER DEFAULT 0, win_rate REAL DEFAULT 0,
        bags TEXT
      );
      CREATE TABLE IF NOT EXISTS futures_positions (
        pair TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        amount REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL,
        take_profit REAL,
        strategy TEXT,
        open_time INTEGER,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS futures_balance (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance REAL NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Migrations: add new columns to existing tables if they don't exist yet
    const migrations = [
      { table: "signals",         col: "atr_regime",     def: "TEXT DEFAULT 'normal'" },
      { table: "signals",         col: "macro_state",    def: "TEXT DEFAULT 'unknown'" },
      { table: "daily_snapshots", col: "spot_total",     def: "REAL DEFAULT 0" },
      { table: "daily_snapshots", col: "futures_total",  def: "REAL DEFAULT 0" },
      { table: "daily_snapshots", col: "macro_state",    def: "TEXT DEFAULT 'unknown'" },
      { table: "daily_snapshots", col: "futures_halted", def: "INTEGER DEFAULT 0" },
      { table: "futures_positions", col: "open_time",    def: "INTEGER" },
      { table: "futures_balance",   col: "peak_balance", def: "REAL DEFAULT 0" },
    ];

    const existingCols = {};
    for (const { table, col, def } of migrations) {
      if (!existingCols[table]) {
        existingCols[table] = this.db.pragma(`table_info(${table})`).map(r => r.name);
      }
      if (!existingCols[table].includes(col)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
  }

  recordTrade(trade) {
    try {
      this.db.prepare(`
        INSERT INTO trades (pair, side, entry_price, exit_price, amount, strategy, pnl, status, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', datetime('now'))
      `).run(
        trade.pair, trade.side, trade.entryPrice, trade.exitPrice,
        trade.amount, trade.strategy, trade.pnl
      );
    } catch (e) {
      getLogger().error(`DB recordTrade error: ${e.message}`);
    }
  }

  recordSignal(signal) {
    try {
      this.db.prepare(`
        INSERT INTO signals (pair, side, price, strategy, confidence, reason, atr_regime, macro_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.pair, signal.side, signal.price,
        signal.strategy, signal.confidence, signal.reason || "",
        signal.atrRegime || "normal", signal.macroState || "unknown"
      );
    } catch (e) {
      getLogger().error(`DB recordSignal error: ${e.message}`);
    }
  }

  saveAccumulatorState(pair, state) {
    if (!state) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO accumulator_state
        (pair, recent_high, avg_entry, total_accumulated, total_spent, last_dca_time, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        pair, state.recentHigh, state.avgEntry,
        state.totalAccumulated, state.totalSpent, state.lastDcaTime
      );
    } catch (e) {
      getLogger().error(`DB saveAccumulatorState error: ${e.message}`);
    }
  }

  restoreAccumulatorState(accumulator) {
    if (!accumulator) return;
    try {
      const rows = this.db.prepare("SELECT * FROM accumulator_state").all();
      for (const row of rows) {
        accumulator.state.set(row.pair, {
          recentHigh: row.recent_high,
          avgEntry: row.avg_entry,
          totalAccumulated: row.total_accumulated,
          totalSpent: row.total_spent,
          lastDcaTime: row.last_dca_time,
        });
        if (row.total_accumulated > 0) {
          getLogger().info(
            `Restored ${row.pair}: ${row.total_accumulated.toFixed(4)} @ avg $${row.avg_entry.toFixed(4)}`
          );
        }
      }
    } catch (e) {
      getLogger().error(`DB restoreAccumulatorState error: ${e.message}`);
    }
  }

  saveDailySnapshot(snapshot) {
    try {
      const date = new Date().toISOString().split("T")[0];
      this.db.prepare(`
        INSERT OR REPLACE INTO daily_snapshots
        (date, total_value, spot_total, futures_total, realized_pnl, unrealized_pnl,
         total_trades, win_rate, bags, macro_state, futures_halted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        date, snapshot.totalValue, snapshot.spotTotal || 0, snapshot.futuresTotal || 0,
        snapshot.realizedPnl, snapshot.unrealizedPnl, snapshot.totalTrades,
        snapshot.winRate, JSON.stringify(snapshot.bags || {}),
        snapshot.macroState || "unknown", snapshot.futuresHalted ? 1 : 0
      );
    } catch (e) {
      getLogger().error(`DB saveDailySnapshot error: ${e.message}`);
    }
  }

  getTradeHistory(limit = 50) {
    return this.db.prepare(
      "SELECT * FROM trades ORDER BY id DESC LIMIT ?"
    ).all(limit);
  }

  getSignalHistory(limit = 50) {
    return this.db.prepare(
      "SELECT * FROM signals ORDER BY id DESC LIMIT ?"
    ).all(limit);
  }

  getDailySnapshots(limit = 30) {
    return this.db.prepare(
      "SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT ?"
    ).all(limit);
  }

  getStats() {
    const trades = this.db.prepare("SELECT COUNT(*) as total, SUM(pnl) as totalPnl FROM trades WHERE status = 'closed'").get();
    const wins = this.db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'closed' AND pnl > 0").get();
    return {
      totalTrades: trades.total,
      totalPnl: trades.totalPnl || 0,
      winRate: trades.total > 0 ? wins.count / trades.total : 0,
    };
  }

  /**
   * Per-strategy, per-pair stats from the last N closed trades.
   * Used to feed real win rates into Kelly sizing instead of hardcoded guesses.
   * Returns null if fewer than minTrades trades recorded.
   */
  getStrategyStats(strategy, pair, limit = 30, minTrades = 10) {
    try {
      const rows = this.db.prepare(`
        SELECT pnl FROM trades
        WHERE strategy = ? AND pair = ? AND status = 'closed'
        ORDER BY id DESC LIMIT ?
      `).all(strategy, pair, limit);

      if (rows.length < minTrades) return null;

      const wins     = rows.filter(r => r.pnl > 0);
      const losses   = rows.filter(r => r.pnl <= 0);
      const winRate  = wins.length / rows.length;
      const avgWin   = wins.length   > 0 ? wins.reduce((s, r)   => s + r.pnl, 0) / wins.length   : 0;
      const avgLoss  = losses.length > 0 ? losses.reduce((s, r) => s + Math.abs(r.pnl), 0) / losses.length : 1;
      const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 1;

      return { totalTrades: rows.length, winRate, avgWin, avgLoss, profitFactor };
    } catch (e) {
      return null;
    }
  }

  saveFuturesBalance(balance, peakBalance) {
    try {
      if (peakBalance !== undefined) {
        this.db.prepare(`
          INSERT OR REPLACE INTO futures_balance (id, balance, peak_balance, updated_at)
          VALUES (1, ?, ?, datetime('now'))
        `).run(balance, peakBalance);
      } else {
        this.db.prepare(`
          INSERT OR REPLACE INTO futures_balance (id, balance, updated_at)
          VALUES (1, ?, datetime('now'))
        `).run(balance);
      }
    } catch (e) {
      getLogger().error(`DB saveFuturesBalance error: ${e.message}`);
    }
  }

  restoreFuturesPeak() {
    try {
      const row = this.db.prepare("SELECT peak_balance FROM futures_balance WHERE id = 1").get();
      return row ? (row.peak_balance || 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  restoreFuturesBalance() {
    try {
      const row = this.db.prepare("SELECT balance FROM futures_balance WHERE id = 1").get();
      return row ? row.balance : null;
    } catch (e) {
      return null;
    }
  }

  saveFuturesPosition(pair, pos) {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO futures_positions
        (pair, side, amount, entry_price, stop_loss, take_profit, strategy, open_time, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(pair, pos.side, pos.amount, pos.entryPrice, pos.stopLoss, pos.takeProfit, pos.strategy, pos.openTime);
    } catch (e) {
      getLogger().error(`DB saveFuturesPosition error: ${e.message}`);
    }
  }

  deleteFuturesPosition(pair) {
    try {
      this.db.prepare("DELETE FROM futures_positions WHERE pair = ?").run(pair);
    } catch (e) {
      getLogger().error(`DB deleteFuturesPosition error: ${e.message}`);
    }
  }

  restoreFuturesPositions() {
    try {
      return this.db.prepare("SELECT * FROM futures_positions").all().map(row => ({
        pair:       row.pair,
        side:       row.side,
        amount:     row.amount,
        entryPrice: row.entry_price,
        stopLoss:   row.stop_loss,
        takeProfit: row.take_profit,
        strategy:   row.strategy,
        openTime:   row.open_time,
      }));
    } catch (e) {
      return [];
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { TradeDB };

/**
 * Cell Comparison Report - Paper vs Live side by side
 * Run: node src/compare.js
 */
const Database = require("better-sqlite3");
const path = require("path");
const chalk = require("chalk");
const Table = require("cli-table3");

function loadDB(file) {
  const full = path.resolve(__dirname, "..", file);
  try {
    return new Database(full, { readonly: true });
  } catch (e) {
    return null;
  }
}

function getStats(db) {
  if (!db) return null;
  try {
    const trades = db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY id DESC").all();
    const signals = db.prepare("SELECT COUNT(*) as c FROM signals").get();
    const accum = db.prepare("SELECT * FROM accumulator_state").all();

    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = trades.length > 0 ? wins / trades.length : 0;
    const avgWin = wins > 0
      ? trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins
      : 0;
    const losses = trades.filter(t => t.pnl <= 0);
    const avgLoss = losses.length > 0
      ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length
      : 0;

    return { trades, totalPnl, winRate, avgWin, avgLoss, signals: signals.c, accum };
  } catch (e) {
    return null;
  }
}

function main() {
  console.clear();
  console.log(chalk.bold.cyan("\n  CELL - PAPER vs LIVE COMPARISON\n"));

  const paperDB = loadDB("data/paper.db");
  const liveDB  = loadDB("data/live.db");

  if (!paperDB && !liveDB) {
    console.log(chalk.yellow("  No data yet. Start both instances first:\n"));
    console.log("    npm run start:paper");
    console.log("    npm run start:live\n");
    return;
  }

  const paper = getStats(paperDB);
  const live  = getStats(liveDB);

  // Header table
  const head = new Table({
    head: ["Metric", chalk.cyan("PAPER ($10)"), chalk.green("LIVE ($10)")],
    style: { head: [], border: ["grey"] },
    colWidths: [24, 22, 22],
  });

  function fmt(val, isUsd = false, isPct = false) {
    if (val === null || val === undefined) return chalk.dim("no data");
    if (isUsd) {
      const s = `$${val >= 0 ? "+" : ""}${val.toFixed(3)}`;
      return val >= 0 ? chalk.green(s) : chalk.red(s);
    }
    if (isPct) {
      const s = `${(val * 100).toFixed(1)}%`;
      return chalk.white(s);
    }
    return String(val);
  }

  const p = paper;
  const l = live;

  head.push(
    ["Total Trades",    fmt(p?.trades.length), fmt(l?.trades.length)],
    ["Total PnL",       fmt(p?.totalPnl, true), fmt(l?.totalPnl, true)],
    ["Win Rate",        fmt(p?.winRate, false, true), fmt(l?.winRate, false, true)],
    ["Avg Win",         fmt(p?.avgWin, true), fmt(l?.avgWin, true)],
    ["Avg Loss",        fmt(p?.avgLoss, true), fmt(l?.avgLoss, true)],
    ["Signals fired",  fmt(p?.signals), fmt(l?.signals)],
  );

  console.log(head.toString());

  // Verdict
  if (p && l && p.trades.length > 0 && l.trades.length > 0) {
    console.log(chalk.bold("\n  Verdict:"));
    if (p.totalPnl > l.totalPnl) {
      console.log(chalk.cyan("  Paper is outperforming live. Market conditions may have shifted since backtest."));
    } else if (l.totalPnl > p.totalPnl) {
      console.log(chalk.green("  Live is outperforming paper. Real fills executing well."));
    } else {
      console.log(chalk.white("  Neck and neck - strategies behaving consistently."));
    }
  }

  // Accumulated bags
  if (p?.accum?.length > 0 || l?.accum?.length > 0) {
    console.log(chalk.bold("\n  Accumulated Bags:\n"));
    const bagTable = new Table({
      head: ["Token", chalk.cyan("PAPER amt"), chalk.cyan("PAPER avg"), chalk.green("LIVE amt"), chalk.green("LIVE avg")],
      style: { head: [], border: ["grey"] },
    });

    const allPairs = new Set([
      ...(p?.accum || []).map(r => r.pair),
      ...(l?.accum || []).map(r => r.pair),
    ]);

    for (const pair of allPairs) {
      const pRow = p?.accum?.find(r => r.pair === pair);
      const lRow = l?.accum?.find(r => r.pair === pair);
      bagTable.push([
        pair,
        pRow ? pRow.total_accumulated.toFixed(4) : "-",
        pRow ? "$" + pRow.avg_entry.toFixed(4) : "-",
        lRow ? lRow.total_accumulated.toFixed(4) : "-",
        lRow ? "$" + lRow.avg_entry.toFixed(4) : "-",
      ]);
    }
    console.log(bagTable.toString());
  }

  // Recent trades
  const allTrades = [
    ...(p?.trades.slice(0, 5).map(t => ({ ...t, instance: "PAPER" })) || []),
    ...(l?.trades.slice(0, 5).map(t => ({ ...t, instance: "LIVE"  })) || []),
  ].sort((a, b) => b.id - a.id).slice(0, 10);

  if (allTrades.length > 0) {
    console.log(chalk.bold("\n  Recent Trades:\n"));
    const tradeTable = new Table({
      head: ["Instance", "Pair", "Side", "PnL", "Strategy"].map(h => chalk.white(h)),
      style: { head: [], border: ["grey"] },
    });
    for (const t of allTrades) {
      const pnlStr = t.pnl >= 0 ? chalk.green(`+$${t.pnl.toFixed(3)}`) : chalk.red(`$${t.pnl.toFixed(3)}`);
      const inst = t.instance === "PAPER" ? chalk.cyan("PAPER") : chalk.green("LIVE");
      tradeTable.push([inst, t.pair, t.side.toUpperCase(), pnlStr, t.strategy]);
    }
    console.log(tradeTable.toString());
  }

  console.log(chalk.dim("\n  Run again to refresh: node src/compare.js\n"));

  if (paperDB) paperDB.close();
  if (liveDB)  liveDB.close();
}

main();

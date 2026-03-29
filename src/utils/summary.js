const fs = require("fs");
const path = require("path");

function writeSummary(engine) {
  const config = engine.config;
  const portfolio = engine.portfolio;
  const label = config.instanceName || config.mode.toUpperCase();
  const s = portfolio.summary();
  const now = new Date().toLocaleString();

  // Full grand total: spot + futures
  const freeCash    = engine.isPaper ? engine.exchange.getFree("USD") : engine.exchange.getFree("USDT");
  const staked      = engine.krakenEarn ? engine.krakenEarn.getStakedAmount() : 0;
  const bagValue    = portfolio._bagValue || 0;
  const tradeValue  = portfolio.openPositions
    .filter(p => !p.accumulate)
    .reduce((sum, p) => {
      const px = portfolio.getCurrentPrice(p.pair) || p.entryPrice;
      return sum + p.amount * px;
    }, 0);
  const spotTotal   = freeCash + staked + tradeValue + bagValue;
  const futuresBal  = engine.futuresEnabled ? engine.futuresExchange.getBalance() : 0;
  const grandTotal  = spotTotal + futuresBal;

  const basis       = config.startingCapital;
  const returnPct   = basis > 0 ? ((grandTotal - basis) / basis * 100) : 0;

  let lines = [];
  lines.push(`CELL - ${label} STATUS`);
  lines.push(`Updated: ${now}`);
  lines.push(`${"─".repeat(40)}`);
  lines.push(`Starting Capital : $${basis.toFixed(2)}`);
  lines.push(`Spot Total       : $${spotTotal.toFixed(2)}`);
  if (engine.futuresEnabled) {
    lines.push(`Futures Account  : $${futuresBal.toFixed(2)}${engine.safeguards?.isFuturesHalted() ? " ⚠ HALTED" : ""}`);
  }
  lines.push(`GRAND TOTAL      : $${grandTotal.toFixed(2)}`);
  lines.push(`Return           : ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`);
  lines.push(`Drawdown         : ${(s.drawdown * 100).toFixed(2)}%`);
  lines.push(`Open Positions   : ${s.openPositions}`);
  lines.push(`Total Trades     : ${s.totalTrades}`);
  lines.push(`Win Rate         : ${(s.winRate * 100).toFixed(0)}%`);
  lines.push(`${"─".repeat(40)}`);

  // Bags
  if (engine.accumulator) {
    const holdings = engine.accumulator.getHoldings();
    const pairs = Object.keys(holdings);
    if (pairs.length > 0) {
      lines.push("ACCUMULATED BAGS:");
      for (const [token, h] of Object.entries(holdings)) {
        const currentPrice = portfolio.getCurrentPrice(h.pair);
        const currentValue = currentPrice ? h.amount * currentPrice : 0;
        const pnl = currentValue - h.totalSpent;
        lines.push(`  ${token.padEnd(5)} ${h.amount.toFixed(4).padStart(12)} tokens`);
        lines.push(`         avg entry  $${h.avgEntry.toFixed(4)}`);
        if (currentPrice) {
          lines.push(`         current    $${currentPrice.toFixed(4)}`);
          lines.push(`         value      $${currentValue.toFixed(3)}`);
          lines.push(`         unrealized ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)}`);
        }
      }
      lines.push(`${"─".repeat(40)}`);
    }
  }

  // Recent trades
  const recent = portfolio.tradeHistory.slice(-10).reverse();
  if (recent.length > 0) {
    lines.push("RECENT TRADES:");
    for (const t of recent) {
      const pnlStr = `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(3)}`;
      lines.push(`  ${t.side.toUpperCase().padEnd(5)} ${t.pair.padEnd(10)} ${pnlStr.padStart(10)}  [${t.strategy}]`);
    }
    lines.push(`${"─".repeat(40)}`);
  }

  // Signals
  const sigStats = engine.signalGen.getStats();
  lines.push(`SIGNALS: ${sigStats.total} total | avg confidence ${(sigStats.avgConfidence * 100).toFixed(0)}%`);
  if (sigStats.total > 0) {
    for (const [strat, count] of Object.entries(sigStats.byStrategy)) {
      lines.push(`  ${strat}: ${count}`);
    }
  }

  const content = lines.join("\n") + "\n";
  const file = path.resolve(__dirname, "..", "..", `status.${label.toLowerCase()}.txt`);
  fs.writeFileSync(file, content);
}

module.exports = { writeSummary };

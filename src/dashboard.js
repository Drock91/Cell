const chalk = require("chalk");
const Table = require("cli-table3");

function renderDashboard(engine) {
  const config    = engine.config;
  const portfolio = engine.portfolio;
  const mode      = engine.isPaper ? "PAPER" : "LIVE";
  const now       = new Date().toLocaleTimeString();

  console.clear();

  // ── Header ──────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan("  ██████╗███████╗██╗     ██╗"));
  console.log(chalk.bold.cyan(" ██╔════╝██╔════╝██║     ██║"));
  console.log(chalk.bold.cyan(" ██║     █████╗  ██║     ██║"));
  console.log(chalk.bold.cyan(" ██║     ██╔══╝  ██║     ██║"));
  console.log(chalk.bold.cyan(" ╚██████╗███████╗███████╗███████╗"));
  console.log(chalk.bold.cyan("  ╚═════╝╚══════╝╚══════╝╚══════╝"));
  const modeColor = engine.isPaper ? chalk.yellow : chalk.green;
  console.log(`\n  ${modeColor.bold(mode)} | Cycle ${engine._cycleCount} | ${now}\n`);

  // ── Money breakdown ──────────────────────────────────────────────────────
  const freeCash   = engine.isPaper ? engine.exchange.getFree("USD") : engine.exchange.getFree("USDT");
  const staked     = engine.krakenEarn ? engine.krakenEarn.getStakedAmount() : 0;
  const bagValue   = portfolio._bagValue || 0;
  const tradeValue = portfolio.openPositions
    .filter(p => !p.accumulate)
    .reduce((s, p) => {
      const px = portfolio.getCurrentPrice(p.pair) || p.entryPrice;
      return s + p.amount * px;
    }, 0);
  const spotTotal   = freeCash + staked + tradeValue + bagValue;
  const futuresBal  = engine.futuresEnabled ? engine.futuresExchange.getBalance() : 0;
  const grandTotal  = spotTotal + futuresBal;
  const spotBasis    = portfolio._sessionStart > 0 ? portfolio._sessionStart : config.startingCapital;
  const futuresBasis = engine.futuresEnabled ? (config.startingCapital * (config.futures?.capitalPct || 0.30)) : 0;
  const basis        = spotBasis + futuresBasis;
  const pnl         = grandTotal - basis;
  const pnlPct      = basis > 0 ? (pnl / basis * 100) : 0;
  const pnlStr      = pnl >= 0
    ? chalk.green(`+$${pnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)`)
    : chalk.red(`-$${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(1)}%)`);

  const moneyTable = new Table({ style: { head: [], border: ["grey"] } });
  moneyTable.push(
    [chalk.dim("Free cash"),    chalk.white(`$${freeCash.toFixed(2)}`)],
    [chalk.dim("Staked (Earn)"),staked > 0 ? chalk.cyan(`$${staked.toFixed(2)}`) : chalk.dim("$0.00")],
    [chalk.dim("Active trades"),tradeValue > 0 ? chalk.white(`$${tradeValue.toFixed(2)} (${portfolio.openPositions.filter(p=>!p.accumulate).length} pos)`) : chalk.dim("none")],
    [chalk.dim("Bags (MTM)"),   bagValue > 0 ? chalk.white(`$${bagValue.toFixed(2)}`) : chalk.dim("$0.00")],
  );
  if (engine.futuresEnabled) {
    const sg = engine.safeguards.getStatus();
    const futLabel = sg.halted ? chalk.red(`$${futuresBal.toFixed(2)} ⚠ HALTED`) : chalk.white(`$${futuresBal.toFixed(2)} (${engine._futuresPositions.size} pos)`);
    moneyTable.push([chalk.dim("Futures acct"), futLabel]);
  }
  moneyTable.push(
    [chalk.bold("TOTAL"), chalk.bold.white(`$${grandTotal.toFixed(2)}`)],
    [chalk.bold("Session PnL"), pnlStr],
  );
  console.log(moneyTable.toString());

  // ── Macro / Risk status ───────────────────────────────────────────────────
  const statusParts = [];
  if (engine.macroFilter) {
    const ms = engine.macroFilter.state;
    if (ms.btcPrice) {
      statusParts.push(ms.bullish
        ? chalk.green(`BTC BULL $${ms.btcPrice.toFixed(0)}`)
        : chalk.red(`BTC BEAR $${ms.btcPrice.toFixed(0)}`));
    }
  }
  if (engine.risk.isHalted) {
    statusParts.push(chalk.red.bold(`⚠ HALTED: ${engine.risk.haltReason}`));
  } else {
    statusParts.push(chalk.green("✓ trading"));
  }
  if (engine.krakenEarn && staked > 0) {
    const cr = engine.capitalRouter ? engine.capitalRouter.getStats() : null;
    const yieldToFut = cr ? cr.totalToFutures : 0;
    statusParts.push(chalk.cyan(`earn: $${staked.toFixed(0)} staked | $${yieldToFut.toFixed(2)} → futures`));
  }
  console.log("  " + statusParts.join(chalk.dim("  │  ")) + "\n");

  // ── Open positions ────────────────────────────────────────────────────────
  const allPositions = [
    ...portfolio.openPositions.map(p => ({ ...p, account: "SPOT" })),
    ...(engine.futuresEnabled
      ? [...(engine._futuresPositions || new Map()).entries()].map(([pair, p]) => ({
          pair, side: p.side, entryPrice: p.entryPrice, amount: p.amount,
          strategy: p.strategy, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
          accumulate: false, account: "FUT",
        }))
      : []),
  ];

  if (allPositions.length > 0) {
    console.log(chalk.bold("  Open Positions"));
    const posTable = new Table({
      head: ["Acct", "Pair", "Side", "Entry", "Current", "PnL", "SL", "Strategy"].map(h => chalk.dim(h)),
      style: { head: [], border: ["grey"] },
      colWidths: [6, 10, 5, 9, 9, 10, 9, 12],
    });
    for (const p of allPositions) {
      const current = portfolio.getCurrentPrice(p.pair) || p.entryPrice;
      const pnl = p.side === "buy"
        ? (current - p.entryPrice) * p.amount
        : (p.entryPrice - current) * p.amount;
      const pnlStr = pnl >= 0 ? chalk.green(`+$${pnl.toFixed(2)}`) : chalk.red(`$${pnl.toFixed(2)}`);
      const slStr  = p.stopLoss ? `$${p.stopLoss.toFixed(2)}` : chalk.dim("—");
      const accStr = p.account === "FUT" ? chalk.magenta("FUT") : chalk.blue("SPOT");
      posTable.push([
        accStr,
        p.pair.replace("/USD", ""),
        p.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
        `$${p.entryPrice.toFixed(2)}`,
        `$${current.toFixed(2)}`,
        pnlStr,
        slStr,
        chalk.dim(p.strategy || ""),
      ]);
    }
    console.log(posTable.toString());
  }

  // ── Bags ────────────────────────────────────────────────────────────────
  if (engine.accumulator) {
    const holdings = engine.accumulator.getHoldings();
    const bagRows = Object.entries(holdings).filter(([, h]) => h.amount > 0);
    if (bagRows.length > 0) {
      console.log(chalk.bold("  Accumulated Bags"));
      const bagTable = new Table({
        head: ["Token", "Amount", "Avg Entry", "Current", "Value", "PnL%"].map(h => chalk.dim(h)),
        style: { head: [], border: ["grey"] },
      });
      for (const [token, h] of bagRows) {
        const px     = portfolio.getCurrentPrice(`${token}/USD`) || h.avgEntry || 0;
        const value  = h.amount * px;
        const pnlPct = h.avgEntry > 0 ? ((px - h.avgEntry) / h.avgEntry * 100) : 0;
        const pnlStr = pnlPct >= 0 ? chalk.green(`+${pnlPct.toFixed(1)}%`) : chalk.red(`${pnlPct.toFixed(1)}%`);
        bagTable.push([
          chalk.bold(token),
          h.amount.toFixed(2),
          `$${(h.avgEntry||0).toFixed(4)}`,
          `$${px.toFixed(4)}`,
          `$${value.toFixed(2)}`,
          pnlStr,
        ]);
      }
      console.log(bagTable.toString());
    }
  }

  // ── Recent trades ────────────────────────────────────────────────────────
  const recent = portfolio.tradeHistory.slice(-4);
  if (recent.length > 0) {
    console.log(chalk.bold("  Recent Closed Trades"));
    const tradeTable = new Table({
      head: ["Pair", "Side", "Entry", "Exit", "PnL", "Strategy"].map(h => chalk.dim(h)),
      style: { head: [], border: ["grey"] },
    });
    for (const t of [...recent].reverse()) {
      const pnlStr = t.pnl >= 0 ? chalk.green(`+$${t.pnl.toFixed(2)}`) : chalk.red(`$${t.pnl.toFixed(2)}`);
      tradeTable.push([
        t.pair.replace("/USD", ""),
        t.side === "buy" ? chalk.green("BUY") : chalk.red("SELL"),
        `$${t.entryPrice.toFixed(2)}`,
        `$${t.exitPrice.toFixed(2)}`,
        pnlStr,
        chalk.dim(t.strategy),
      ]);
    }
    console.log(tradeTable.toString());
  }

  console.log(chalk.dim(`  Win rate: ${(portfolio.winRate * 100).toFixed(0)}%  |  ${portfolio.tradeHistory.length} closed trades  |  updates every 5s  |  Ctrl+C to stop\n`));
}

module.exports = { renderDashboard };

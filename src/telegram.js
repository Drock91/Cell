/**
 * Cell Telegram Bot - Signals delivery + trade monitoring
 * Run: node src/telegram.js
 */
const { Telegraf } = require("telegraf");
const { loadConfig } = require("./core/config");
const { initLogger, getLogger } = require("./core/logger");

function createBot(config, engine) {
  const log = getLogger();

  if (!config.telegram.token) {
    log.warn("Telegram bot token not configured - bot disabled");
    return null;
  }

  const bot = new Telegraf(config.telegram.token);
  const chatId = config.telegram.chatId;

  // /start command
  bot.start((ctx) => {
    ctx.reply(
      "Cell Trading Bot Online.\n\n" +
      "Commands:\n" +
      "/status - Current portfolio status\n" +
      "/positions - Open positions\n" +
      "/trades - Recent trades\n" +
      "/signals - Recent signals\n" +
      "/pnl - P&L summary\n" +
      "/pause - Pause trading\n" +
      "/resume - Resume trading"
    );
  });

  // /status
  bot.command("status", async (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    const s = engine.portfolio.summary();
    const msg =
      `Portfolio Status\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `Value:     $${s.totalValue.toFixed(2)}\n` +
      `PnL:       $${s.unrealizedPnl >= 0 ? "+" : ""}${s.unrealizedPnl.toFixed(2)}\n` +
      `Drawdown:  ${(s.drawdown * 100).toFixed(1)}%\n` +
      `Positions: ${s.openPositions}\n` +
      `Trades:    ${s.totalTrades}\n` +
      `Win Rate:  ${(s.winRate * 100).toFixed(0)}%`;
    ctx.reply(msg);
  });

  // /positions
  bot.command("positions", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    const positions = engine.portfolio.openPositions;
    if (positions.length === 0) return ctx.reply("No open positions");

    let msg = "Open Positions\n━━━━━━━━━━━━━━━━\n";
    for (const p of positions) {
      const current = engine.portfolio.getCurrentPrice(p.pair);
      const pnl = p.side === "buy"
        ? (current - p.entryPrice) * p.amount
        : (p.entryPrice - current) * p.amount;
      msg += `${p.side.toUpperCase()} ${p.pair}\n`;
      msg += `  Entry: $${p.entryPrice.toFixed(2)} | Now: $${current.toFixed(2)}\n`;
      msg += `  PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} [${p.strategy}]\n\n`;
    }
    ctx.reply(msg);
  });

  // /trades
  bot.command("trades", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    const trades = engine.portfolio.tradeHistory.slice(-10);
    if (trades.length === 0) return ctx.reply("No trades yet");

    let msg = "Recent Trades\n━━━━━━━━━━━━━━━━\n";
    for (const t of trades.reverse()) {
      msg += `${t.side.toUpperCase()} ${t.pair} | $${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} [${t.strategy}]\n`;
    }
    ctx.reply(msg);
  });

  // /signals
  bot.command("signals", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    const signals = engine.signalGen.getRecent(10);
    if (signals.length === 0) return ctx.reply("No signals yet");

    let msg = "Recent Signals\n━━━━━━━━━━━━━━━━\n";
    for (const s of signals.reverse()) {
      msg += `${s.side.toUpperCase()} ${s.pair} @ $${s.price.toFixed(2)}\n`;
      msg += `  ${s.strategy} | conf: ${(s.confidence * 100).toFixed(0)}%\n`;
      msg += `  ${s.reason}\n\n`;
    }
    ctx.reply(msg);
  });

  // /pnl
  bot.command("pnl", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    const s = engine.portfolio.summary();
    const returnPct = s.startingCapital > 0
      ? ((s.totalValue - s.startingCapital) / s.startingCapital * 100)
      : 0;

    const msg =
      `P&L Summary\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `Starting:   $${s.startingCapital.toFixed(2)}\n` +
      `Current:    $${s.totalValue.toFixed(2)}\n` +
      `Return:     ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(1)}%\n` +
      `Realized:   $${s.realizedPnl >= 0 ? "+" : ""}${s.realizedPnl.toFixed(2)}\n` +
      `Unrealized: $${s.unrealizedPnl >= 0 ? "+" : ""}${s.unrealizedPnl.toFixed(2)}\n` +
      `Drawdown:   ${(s.drawdown * 100).toFixed(1)}%`;
    ctx.reply(msg);
  });

  // /pause
  bot.command("pause", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    engine.running = false;
    ctx.reply("Trading PAUSED");
  });

  // /resume
  bot.command("resume", (ctx) => {
    if (!engine) return ctx.reply("Engine not connected");
    engine.risk.resume();
    engine.running = true;
    ctx.reply("Trading RESUMED");
  });

  return bot;
}

async function sendAlert(bot, chatId, message) {
  if (!bot || !chatId) return;
  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (e) {
    getLogger().error(`Telegram send failed: ${e.message}`);
  }
}

module.exports = { createBot, sendAlert };

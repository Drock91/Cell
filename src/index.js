/**
 * CELL - Autonomous Wealth Generation Engine
 *
 * Usage:
 *   npm run start:paper    Paper trade with $10 (simulated)
 *   npm run start:live     Live trade with $10 (real orders)
 *   npm run compare        Compare paper vs live results
 *   npm run backtest       Run backtester
 */
const path = require("path");
const { CellEngine } = require("./core/engine");
const { initLogger, getLogger, silenceConsole } = require("./core/logger");
const { createBot, sendAlert } = require("./telegram");
const { renderDashboard } = require("./dashboard");

async function main() {
  const args = process.argv.slice(2);

  // Determine which config to load
  let configPath = null;
  const configFlag = args.find(a => a.startsWith("--config="));
  if (configFlag) {
    configPath = path.resolve(configFlag.split("=")[1]);
  } else if (args.includes("--live")) {
    configPath = path.resolve(__dirname, "..", "config.live.yaml");
  } else if (args.includes("--paper")) {
    configPath = path.resolve(__dirname, "..", "config.paper.yaml");
  }

  if (args.includes("--backtest")) {
    require("./backtest");
    return;
  }

  if (args.includes("--compare")) {
    require("./compare");
    return;
  }

  const engine = new CellEngine(configPath);
  const config = engine.config;
  const log = getLogger();

  const label = config.instanceName || config.mode.toUpperCase();
  log.info(`Starting Cell instance: ${label}`);

  // Telegram
  let bot = null;
  if (config.telegram.enabled && config.telegram.token) {
    bot = createBot(config, engine);
    if (bot) {
      bot.launch().catch((e) => log.error(`Telegram bot error: ${e.message}`));
      log.info("Telegram bot started");
      engine.signalGen.subscribe((signal) => {
        const msg =
          `[${label}] SIGNAL: ${signal.side.toUpperCase()} ${signal.pair}\n` +
          `Price: $${signal.price.toFixed(4)}\n` +
          `Strategy: ${signal.strategy} | conf: ${(signal.confidence * 100).toFixed(0)}%\n` +
          `${signal.reason}`;
        sendAlert(bot, config.telegram.chatId, msg);
      });
    }
  }

  // Dashboard — silence logger console output so it doesn't fight the render
  if (args.includes("--dashboard")) {
    silenceConsole();
    renderDashboard(engine);  // immediate first render
    const dashInterval = setInterval(() => renderDashboard(engine), 5000);
    process.on("SIGINT", () => clearInterval(dashInterval));
  }

  // Graceful shutdown
  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    await engine.shutdown();
    if (bot) bot.stop("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await engine.shutdown();
    if (bot) bot.stop("SIGTERM");
    process.exit(0);
  });

  // Catch unhandled errors — log and exit cleanly so a restart recovers
  process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled rejection: ${reason?.message || reason}`);
    engine.shutdown().finally(() => process.exit(1));
  });
  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}\n${err.stack}`);
    engine.shutdown().finally(() => process.exit(1));
  });

  try {
    await engine.start();
  } catch (e) {
    log.error(`Fatal error: ${e.message}`);
    process.exit(1);
  }
}

main();

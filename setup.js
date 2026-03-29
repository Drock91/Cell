#!/usr/bin/env node
/**
 * Cell Setup Script - Get everything ready in one command
 * Run: node setup.js
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  console.log(`
   ██████╗███████╗██╗     ██╗
  ██╔════╝██╔════╝██║     ██║
  ██║     █████╗  ██║     ██║
  ██║     ██╔══╝  ██║     ██║
  ╚██████╗███████╗███████╗███████╗
   ╚═════╝╚══════╝╚══════╝╚══════╝

  SETUP WIZARD
  `);

  // 1. Check node_modules
  if (!fs.existsSync("node_modules")) {
    console.log("[1/5] Installing dependencies...");
    execSync("npm install", { stdio: "inherit" });
  } else {
    console.log("[1/5] Dependencies already installed.");
  }

  // 2. Create data directory
  console.log("[2/5] Creating data directory...");
  fs.mkdirSync("data", { recursive: true });

  // 3. Create .env if missing
  if (!fs.existsSync(".env")) {
    console.log("[3/5] Setting up API keys...\n");

    const krakenKey = await ask("  Kraken API Key (or press Enter to skip): ");
    const krakenSecret = krakenKey ? await ask("  Kraken API Secret: ") : "";
    const cbKey = await ask("  Coinbase API Key (for AXL - Enter to skip): ");
    const cbSecret = cbKey ? await ask("  Coinbase API Secret: ") : "";
    const tgToken = await ask("  Telegram Bot Token (Enter to skip): ");
    const tgChat = tgToken ? await ask("  Telegram Chat ID: ") : "";

    const env = [
      `EXCHANGE_API_KEY=${krakenKey}`,
      `EXCHANGE_API_SECRET=${krakenSecret}`,
      `EXCHANGE2_API_KEY=${cbKey}`,
      `EXCHANGE2_API_SECRET=${cbSecret}`,
      `TELEGRAM_BOT_TOKEN=${tgToken}`,
      `TELEGRAM_CHAT_ID=${tgChat}`,
    ].join("\n");

    fs.writeFileSync(".env", env);
    console.log("  .env created!\n");
  } else {
    console.log("[3/5] .env already exists.");
  }

  // 4. Validate config
  console.log("[4/5] Validating configuration...");
  try {
    const { loadConfig } = require("./src/core/config");
    const config = loadConfig();
    console.log(`  Exchange: ${config.exchange.name}`);
    console.log(`  Mode: ${config.mode}`);
    console.log(`  Pairs: ${config.trading.pairs.join(", ")}`);
    if (config.trading.exchange2Pairs) {
      console.log(`  Exchange2 Pairs: ${config.trading.exchange2Pairs.join(", ")}`);
    }
    console.log(`  Strategies: ${Object.entries(config.strategies).filter(([, v]) => v.enabled).map(([k]) => k).join(", ")}`);
    console.log("  Config OK!\n");
  } catch (e) {
    console.error(`  Config error: ${e.message}`);
  }

  // 5. Test exchange connectivity
  console.log("[5/5] Testing exchange connectivity...");
  try {
    const ccxt = require("ccxt");
    const kraken = new ccxt.kraken({ enableRateLimit: true });
    const ticker = await kraken.fetchTicker("XRP/RLUSD");
    console.log(`  Kraken connected! XRP/RLUSD = $${ticker.last}`);
    await kraken.close();

    const coinbase = new ccxt.coinbase({ enableRateLimit: true });
    const axlTicker = await coinbase.fetchTicker("AXL/USD");
    console.log(`  Coinbase connected! AXL/USD = $${axlTicker.last}`);
    await coinbase.close();
  } catch (e) {
    console.log(`  Public data test: ${e.message.slice(0, 80)}`);
  }

  console.log(`
  ══════════════════════════════════════
  Setup complete! Next steps:

  1. Run backtest:     npm run backtest
  2. Paper trade:      npm start
  3. Go live:          node src/index.js --live
  4. Dashboard:        node src/index.js --dashboard
  ══════════════════════════════════════
  `);

  rl.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
});

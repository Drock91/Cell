/**
 * liquidate.js — one-shot script that market-sells all non-USD spot holdings.
 *
 * Usage:
 *   node scripts/liquidate.js            # dry run (shows what would be sold)
 *   node scripts/liquidate.js --confirm  # executes real market sells
 *
 * Connects to live Kraken using .env credentials.
 * Skips USD, USDT, and any asset worth less than $1.
 */

require("dotenv").config();
const ccxt = require("ccxt");

const DRY_RUN = !process.argv.includes("--confirm");

const SKIP_ASSETS = new Set(["USD", "USDT", "ZUSD"]);
const MIN_VALUE_USD = 1.00;  // ignore dust

async function main() {
  console.log("=================================================");
  console.log("  CELL LIQUIDATION SCRIPT");
  console.log(DRY_RUN ? "  MODE: DRY RUN (add --confirm to execute)" : "  MODE: LIVE — REAL ORDERS WILL BE PLACED");
  console.log("=================================================\n");

  const exchange = new ccxt.kraken({
    apiKey:          process.env.EXCHANGE_API_KEY,
    secret:          process.env.EXCHANGE_API_SECRET,
    enableRateLimit: true,
    timeout:         30000,
    options:         { defaultType: "spot" },
  });

  console.log("Fetching balances...");
  const bal = await exchange.fetchBalance();

  // Find all non-USD assets with meaningful balance
  const toSell = [];
  for (const [asset, free] of Object.entries(bal.free || {})) {
    const cleaned = asset.replace(/^X/, "").replace(/^Z/, "");  // Kraken prefixes X/Z
    if (SKIP_ASSETS.has(cleaned) || SKIP_ASSETS.has(asset)) continue;
    if (!free || free <= 0) continue;

    // Try to get a price estimate
    const symbol = `${cleaned}/USD`;
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const valueUsd = free * (ticker.last || 0);
      if (valueUsd < MIN_VALUE_USD) {
        console.log(`  SKIP ${asset}: $${valueUsd.toFixed(2)} (dust)`);
        continue;
      }
      toSell.push({ asset, cleaned, symbol, amount: free, valueUsd, price: ticker.last });
    } catch (_) {
      console.log(`  SKIP ${asset}: no USD market found`);
    }
  }

  if (toSell.length === 0) {
    console.log("\nNothing to sell — account is already in cash.");
    return;
  }

  const totalUsd = toSell.reduce((s, t) => s + t.valueUsd, 0);
  console.log(`\nAssets to liquidate (total ~$${totalUsd.toFixed(2)}):\n`);
  for (const t of toSell) {
    console.log(`  SELL ${t.amount.toFixed(6)} ${t.cleaned} @ ~$${t.price.toFixed(4)} = ~$${t.valueUsd.toFixed(2)}`);
  }

  if (DRY_RUN) {
    console.log("\nDry run complete. Run with --confirm to execute.");
    return;
  }

  console.log("\nExecuting market sells...\n");
  let totalReceived = 0;

  for (const t of toSell) {
    try {
      console.log(`  Selling ${t.amount.toFixed(6)} ${t.cleaned}...`);
      const order = await exchange.createMarketSellOrder(t.symbol, t.amount);
      const received = order.cost || (t.amount * (order.average || t.price));
      totalReceived += received;
      console.log(`  ✓ Sold ${t.cleaned} — received ~$${received.toFixed(2)} USD`);
    } catch (e) {
      console.log(`  ✗ Failed to sell ${t.cleaned}: ${e.message}`);
    }

    // Brief pause between orders to respect rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nLiquidation complete. Total received: ~$${totalReceived.toFixed(2)} USD`);
  console.log("You can now run: npm run start:live\n");
}

main().catch(e => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
require("dotenv").config();

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      typeof override[key] === "object" &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function loadConfig(configPath) {
  const root = path.resolve(__dirname, "..", "..");

  const basePath = configPath || path.join(root, "config.yaml");
  const raw = fs.readFileSync(basePath, "utf-8");
  let config = YAML.parse(raw);

  // Merge local overrides
  const localPath = path.join(root, "config.local.yaml");
  if (fs.existsSync(localPath)) {
    const localRaw = fs.readFileSync(localPath, "utf-8");
    const local = YAML.parse(localRaw) || {};
    config = deepMerge(config, local);
  }

  // Inject env vars - primary exchange
  config.exchange = config.exchange || {};
  config.exchange.apiKey = process.env.EXCHANGE_API_KEY || "";
  config.exchange.apiSecret = process.env.EXCHANGE_API_SECRET || "";

  // Secondary exchange (for AXL etc)
  config.exchange2 = config.exchange2 || {};
  config.exchange2.apiKey = process.env.EXCHANGE2_API_KEY || "";
  config.exchange2.apiSecret = process.env.EXCHANGE2_API_SECRET || "";

  // Futures exchange (krakenfutures — separate credentials from spot)
  config.futures = config.futures || {};
  config.futures.apiKey    = process.env.FUTURES_API_KEY    || "";
  config.futures.apiSecret = process.env.FUTURES_API_SECRET || "";

  config.telegram = config.telegram || {};
  config.telegram.token = process.env.TELEGRAM_BOT_TOKEN || "";
  config.telegram.chatId = process.env.TELEGRAM_CHAT_ID || "";

  return config;
}

module.exports = { loadConfig };

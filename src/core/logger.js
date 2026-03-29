const winston = require("winston");
const path = require("path");

let logger;

function initLogger(level = "info", file = "cell.log") {
  const root = path.resolve(__dirname, "..", "..");

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: "HH:mm:ss" }),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level} ${message}`;
          })
        ),
      }),
      new winston.transports.File({
        filename: path.join(root, file),
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  });

  return logger;
}

function getLogger() {
  if (!logger) return initLogger();
  return logger;
}

module.exports = { initLogger, getLogger };

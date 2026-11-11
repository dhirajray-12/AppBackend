// backend/utils/logger.js - Structured logging with levels
const winston = require("winston");
const path = require("path");

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "white",
};

winston.addColors(colors);

// Format for console output (pretty)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`,
  ),
);

// Format for file output (JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  levels,
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transport for errors
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: "logs/combined.log",
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Create stream for Morgan HTTP logging
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

module.exports = logger;

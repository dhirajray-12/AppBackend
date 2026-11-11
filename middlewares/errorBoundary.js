// backend/middlewares/errorBoundary.js
const logger = require("../utils/logger");

// Wrapper for async routes to prevent unhandled rejections
const asyncWrapper = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      // Log the error before passing to error handler
      logger.error(`Async wrapper caught error in ${req.method} ${req.url}:`, {
        error: error.message,
        stack: error.stack,
        userId: req.user?._id,
      });
      next(error);
    });
  };
};

// Wrapper for WebSocket handlers
const wsWrapper = (fn) => {
  return (socket, ...args) => {
    try {
      return fn(socket, ...args);
    } catch (error) {
      logger.error(`WebSocket error:`, {
        error: error.message,
        stack: error.stack,
        socketId: socket.id,
      });
      socket.emit("error", { message: "Internal server error" });
    }
  };
};

// Global unhandledRejection/uncaughtException listeners live in
// middlewares/errorHandler.js — kept in one place to avoid triple-logging.

module.exports = {
  asyncWrapper,
  wsWrapper,
};

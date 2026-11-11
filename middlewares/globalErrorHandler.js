// backend/middlewares/globalErrorHandler.js - route-not-found handling
//
// The process-level uncaughtException/unhandledRejection listeners and the
// error-response middleware used to live here too, duplicating
// middlewares/errorHandler.js. That file is now the single source of truth
// for both; this file only keeps notFoundHandler.

const { AppError } = require("./errorHandler");

// Route not found handler
const notFoundHandler = (req, res, next) => {
  next(
    new AppError(
      `Route not found: ${req.method} ${req.originalUrl}`,
      404,
      "ROUTE_NOT_FOUND",
    ),
  );
};

module.exports = {
  notFoundHandler,
};

// backend/middlewares/requestContext.js - Track request context for errors
const { v4: uuidv4 } = require("uuid");

// AsyncLocalStorage for request context
const { AsyncLocalStorage } = require("async_hooks");
const asyncLocalStorage = new AsyncLocalStorage();

// Middleware to set request context
const requestContext = (req, res, next) => {
  const requestId = req.headers["x-request-id"] || uuidv4();
  const startTime = Date.now();

  const context = {
    requestId,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    userId: req.user?._id || req.user?.id,
    userEmail: req.user?.email,
    startTime,
  };

  // Store context in AsyncLocalStorage
  asyncLocalStorage.run(context, () => {
    // Add requestId to response headers
    res.setHeader("X-Request-ID", requestId);

    // Track response time
    res.on("finish", () => {
      const duration = Date.now() - startTime;
      context.statusCode = res.statusCode;
      context.duration = duration;

      // Log slow requests
      if (duration > 1000) {
        console.warn(
          `⚠️ Slow request: ${req.method} ${req.originalUrl} - ${duration}ms`,
        );
      }
    });

    next();
  });
};

// Get current request context
const getRequestContext = () => {
  return asyncLocalStorage.getStore() || {};
};

// Error tracking now happens centrally in middlewares/errorHandler.js,
// which also has access to this request context via getRequestContext().

module.exports = {
  requestContext,
  getRequestContext,
};

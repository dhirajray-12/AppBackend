// backend/middlewares/rateLimiter.js
const rateLimit = require("express-rate-limit");
const { RateLimitError } = require("./errorHandler");

// Create a rate limiter with custom error handling
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100, // 100 requests per window
    message = "Too many requests, please try again later.",
    skipSuccessfulRequests = false,
    keyGenerator = (req) => req.user?.id || req.ip,
  } = options;

  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      message,
      errorCode: "RATE_LIMIT_EXCEEDED",
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skipSuccessfulRequests,
    keyGenerator,
    handler: (req, res, next, options) => {
      throw new RateLimitError(message);
    },
  });
};

// Specific limiters for different routes
const limiters = {
  // Strict limiter for auth endpoints
  auth: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message:
      "Too many authentication attempts. Please try again after 15 minutes.",
  }),

  // General API limiter
  api: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests. Please try again later.",
  }),

  // Strict limiter for sensitive operations
  sensitive: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: "Too many attempts. Please try again after an hour.",
  }),

  // Relaxed limiter for public endpoints
  public: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: "Too many requests. Please slow down.",
  }),
};

module.exports = limiters;

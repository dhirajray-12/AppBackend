const responseTime = require("response-time");
const crypto = require("crypto");

const SLOW_REQUEST_THRESHOLD_MS = Number(
  process.env.SLOW_REQUEST_THRESHOLD_MS || 750,
);
const LOG_ALL_API_TIMINGS =
  process.env.LOG_ALL_API_TIMINGS === "true" ||
  process.env.NODE_ENV !== "production";

// Track API response times
const performanceMiddleware = responseTime((req, res, time) => {
  const url = req.originalUrl || req.url;
  const method = req.method;
  const statusCode = res.statusCode;
  const roundedTime = Number(time.toFixed(2));

  if (LOG_ALL_API_TIMINGS) {
    console.log(
      `API ${method} ${url} - ${roundedTime}ms - ${statusCode}`,
    );
  }

  // Log slow requests so the worst endpoints stand out during local testing.
  if (time > SLOW_REQUEST_THRESHOLD_MS) {
    console.warn(
      `⚠️ Slow request: ${method} ${url} - ${roundedTime}ms - ${statusCode}`,
    );
  }

  // Store in metrics (could be sent to monitoring service)
  if (global.metrics) {
    global.metrics.apiLatency.observe(
      { method, url: req.route?.path || url },
      roundedTime,
    );
  }
});

// Request ID middleware for tracing
const requestIdMiddleware = (req, res, next) => {
  req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
};

module.exports = {
  performanceMiddleware,
  requestIdMiddleware,
};

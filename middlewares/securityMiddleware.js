const rateLimit = require("express-rate-limit");

// Rate limiting configuration
const createRateLimiter = (
  windowMs = 15 * 60 * 1000,
  max = 100,
  message = "Too many requests from this IP",
) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      message,
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false, // Count all requests
    keyGenerator: (req) => {
      // Use user ID if logged in, otherwise IP
      return req.user?.id || req.ip;
    },
  });
};

// Stricter rate limiter for auth endpoints
const authRateLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  5, // 5 requests
  "Too many authentication attempts, please try again after 15 minutes",
);

// General API rate limiter
const apiRateLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  100, // 100 requests
  "Too many requests, please try again later",
);

// Security headers configuration
const securityHeaders = (req, res, next) => {
  // Additional security headers beyond helmet
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()",
  );

  // Remove powered-by header
  res.removeHeader("X-Powered-By");

  next();
};

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  // Sanitize request body, query, and params
  if (req.body) {
    Object.keys(req.body).forEach((key) => {
      if (typeof req.body[key] === "string") {
        // Remove any script tags or potential XSS
        req.body[key] = req.body[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/javascript:/gi, "")
          .trim();
      }
    });
  }
  next();
};

// IP whitelist middleware for admin routes
const ipWhitelist = (allowedIPs) => {
  return (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    // Remove IPv6 prefix if present
    const cleanIP = clientIP.replace("::ffff:", "");

    if (allowedIPs.includes(cleanIP) || allowedIPs.includes("*")) {
      next();
    } else {
      console.warn(`Blocked access from unauthorized IP: ${cleanIP}`);
      res.status(403).json({
        success: false,
        message: "Access denied from this IP address",
      });
    }
  };
};

module.exports = {
  createRateLimiter,
  authRateLimiter,
  apiRateLimiter,
  securityHeaders,
  sanitizeInput,
  ipWhitelist,
};

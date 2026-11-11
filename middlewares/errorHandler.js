// backend/middlewares/errorHandler.js - COMPLETE ERROR HANDLING SYSTEM
const logger = require("../utils/logger");
const errorTracker = require("../utils/errorTracker");
// CUSTOM ERROR CLASSES
class AppError extends Error {
  constructor(message, statusCode, errorCode = null, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, errors = null) {
    super(message || "Validation failed", 400, "VALIDATION_ERROR");
    this.errors = errors;
  }
}

class AuthenticationError extends AppError {
  constructor(message = "Authentication required. Please log in.") {
    super(message, 401, "AUTHENTICATION_ERROR");
  }
}

class AuthorizationError extends AppError {
  constructor(message = "You do not have permission to access this resource.") {
    super(message, 403, "AUTHORIZATION_ERROR");
  }
}

class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(`${resource} not found.`, 404, "NOT_FOUND_ERROR");
  }
}

class ConflictError extends AppError {
  constructor(message = "Resource already exists.") {
    super(message, 409, "CONFLICT_ERROR");
  }
}

class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please try again later.") {
    super(message, 429, "RATE_LIMIT_ERROR");
  }
}

class DatabaseError extends AppError {
  constructor(message = "Database operation failed.") {
    super(message, 500, "DATABASE_ERROR");
  }
}

class ExternalAPIError extends AppError {
  constructor(message = "External API request failed.", originalError = null) {
    super(message, 502, "EXTERNAL_API_ERROR");
    this.originalError = originalError;
  }
}
// ERROR HANDLER MIDDLEWARE
const errorHandler = (err, req, res, next) => {
  // Generate unique error ID for tracking
  const errorId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Log the error with full context
  logger.error({
    errorId,
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    userId: req.user?._id || req.user?.id,
    userEmail: req.user?.email,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    body: sanitizeRequestBody(req.body),
    query: req.query,
    params: req.params,
    statusCode: err.statusCode || 500,
    errorCode: err.errorCode,
    timestamp: new Date().toISOString(),
  });

  errorTracker.track(err, {
    url: req.originalUrl,
    method: req.method,
    userId: req.user?._id || req.user?.id,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    body: req.body,
    query: req.query,
    params: req.params,
  });
// HANDLE SPECIFIC ERROR TYPES
// 1. MongoDB Validation Errors
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));

    return res.status(400).json({
      success: false,
      errorId,
      message: "Validation Error",
      errorCode: "VALIDATION_ERROR",
      errors,
      timestamp: new Date().toISOString(),
    });
  }

  // 2. MongoDB Duplicate Key Error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    const value = err.keyValue[field];

    return res.status(409).json({
      success: false,
      errorId,
      message: `Duplicate value: ${field} '${value}' already exists.`,
      errorCode: "DUPLICATE_ERROR",
      field,
      timestamp: new Date().toISOString(),
    });
  }

  // 3. MongoDB Cast Error (Invalid ID format)
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      errorId,
      message: `Invalid ${err.path}: ${err.value}`,
      errorCode: "INVALID_ID_FORMAT",
      timestamp: new Date().toISOString(),
    });
  }

  // 4. JWT Errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      errorId,
      message: "Invalid authentication token. Please log in again.",
      errorCode: "INVALID_TOKEN",
      timestamp: new Date().toISOString(),
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      errorId,
      message: "Your session has expired. Please log in again.",
      errorCode: "TOKEN_EXPIRED",
      timestamp: new Date().toISOString(),
    });
  }

  // 5. Multer File Upload Errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      errorId,
      message: "File too large. Maximum size is 5MB.",
      errorCode: "FILE_TOO_LARGE",
      timestamp: new Date().toISOString(),
    });
  }

  if (err.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({
      success: false,
      errorId,
      message: "Too many files uploaded.",
      errorCode: "TOO_MANY_FILES",
      timestamp: new Date().toISOString(),
    });
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      success: false,
      errorId,
      message: "Unexpected field name in file upload.",
      errorCode: "UNEXPECTED_FILE_FIELD",
      timestamp: new Date().toISOString(),
    });
  }

  // 6. Axios/Network Errors
  if (err.isAxiosError) {
    const statusCode = err.response?.status || 502;
    const message =
      err.response?.data?.message ||
      err.message ||
      "External API request failed";

    return res.status(statusCode).json({
      success: false,
      errorId,
      message: `External API Error: ${message}`,
      errorCode: "EXTERNAL_API_ERROR",
      details:
        process.env.NODE_ENV !== "production"
          ? {
              url: err.config?.url,
              method: err.config?.method,
              status: err.response?.status,
            }
          : undefined,
      timestamp: new Date().toISOString(),
    });
  }

  // 7. Custom App Errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      errorId,
      message: err.message,
      errorCode: err.errorCode,
      timestamp: err.timestamp,
      ...(err.errors && { errors: err.errors }),
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  }

  // 8. Rate Limit Errors
  if (err.name === "RateLimitError") {
    return res.status(429).json({
      success: false,
      errorId,
      message: "Too many requests. Please try again after 15 minutes.",
      errorCode: "RATE_LIMIT_EXCEEDED",
      retryAfter: err.retryAfter || 900,
      timestamp: new Date().toISOString(),
    });
  }

  // 9. Default/Unknown Errors
  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production" && statusCode >= 500
      ? "An unexpected error occurred. Our team has been notified."
      : err.message || "Internal Server Error";

  res.status(statusCode).json({
    success: false,
    errorId,
    message,
    errorCode: err.errorCode || "INTERNAL_SERVER_ERROR",
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV !== "production" && {
      stack: err.stack,
      originalMessage: err.message,
    }),
  });
};
// HELPER FUNCTIONS
// Sanitize request body to remove sensitive data before logging
const sanitizeRequestBody = (body) => {
  if (!body) return body;

  const sanitized = { ...body };
  const sensitiveFields = [
    "password",
    "confirmPassword",
    "token",
    "refreshToken",
    "oldPassword",
    "newPassword",
  ];

  sensitiveFields.forEach((field) => {
    if (sanitized[field]) sanitized[field] = "***REDACTED***";
  });

  return sanitized;
};

// Async handler to avoid try-catch in controllers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Global uncaught exception handler
process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  logger.error("UNCAUGHT EXCEPTION:", {
    error: error.message,
    stack: error.stack,
  });
});

// Global unhandled rejection handler
process.on("unhandledRejection", (reason, promise) => {
  logger.error("UNHANDLED REJECTION:", {
    reason: reason?.message || reason,
    promise,
  });
});

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  DatabaseError,
  ExternalAPIError,
  errorHandler,
  asyncHandler,
  sanitizeRequestBody,
};



const ERROR_CODES = {
  // Auth errors (1000-1099)
  AUTH_001: { code: "AUTH_001", message: "Invalid credentials", status: 401 },
  AUTH_002: { code: "AUTH_002", message: "Email not verified", status: 401 },
  AUTH_003: { code: "AUTH_003", message: "Token expired", status: 401 },
  AUTH_004: { code: "AUTH_004", message: "Invalid token", status: 401 },
  AUTH_005: { code: "AUTH_005", message: "Access denied", status: 403 },

  // Validation errors (2000-2099)
  VAL_001: { code: "VAL_001", message: "Validation failed", status: 400 },
  VAL_002: { code: "VAL_002", message: "Invalid email format", status: 400 },
  VAL_003: { code: "VAL_003", message: "Password too weak", status: 400 },

  // Resource errors (3000-3099)
  RES_001: { code: "RES_001", message: "Resource not found", status: 404 },
  RES_002: { code: "RES_002", message: "Resource already exists", status: 409 },

  // Database errors (4000-4099)
  DB_001: {
    code: "DB_001",
    message: "Database connection failed",
    status: 500,
  },
  DB_002: { code: "DB_002", message: "Duplicate entry", status: 409 },

  // External API errors (5000-5099)
  EXT_001: { code: "EXT_001", message: "External API error", status: 502 },
  EXT_002: { code: "EXT_002", message: "MT5 API error", status: 502 },

  // Rate limit errors (6000-6099)
  RATE_001: { code: "RATE_001", message: "Rate limit exceeded", status: 429 },
};

// Helper to get error response
const getErrorResponse = (errorCode, customMessage = null) => {
  const error = ERROR_CODES[errorCode];
  if (!error) {
    return { code: "UNKNOWN", message: "Unknown error", status: 500 };
  }
  return {
    code: error.code,
    message: customMessage || error.message,
    status: error.status,
  };
};

module.exports = {
  ERROR_CODES,
  getErrorResponse,
};

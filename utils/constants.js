module.exports = {
  // Time constants
  ONE_MINUTE_MS: 60000,
  FIVE_MINUTES_MS: 300000,
  ONE_HOUR_MS: 3600000,
  ONE_DAY_MS: 86400000,

  // Cron schedules
  CRON_SCHEDULES: {
    EVERY_MINUTE: "* * * * *",
    EVERY_5_MINUTES: "*/5 * * * *",
    EVERY_HOUR: "0 * * * *",
    EVERY_DAY_2AM: "0 2 * * *",
    EVERY_DAY_MIDNIGHT: "0 0 * * *",
    EVERY_WEEK: "0 0 * * 0",
  },

  // HTTP status codes
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_ERROR: 500,
  },

  // Rate limits
  RATE_LIMITS: {
    AUTH: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // 5 requests per window
    },
    API: {
      windowMs: 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute
    },
  },
};

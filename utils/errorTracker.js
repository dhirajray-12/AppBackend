// backend/utils/errorTracker.js - Track all errors with stack traces
const fs = require("fs");
const path = require("path");
const os = require("os");

// Ensure error logs directory exists
const ERROR_LOG_DIR = path.join(__dirname, "../logs/errors");
if (!fs.existsSync(ERROR_LOG_DIR)) {
  fs.mkdirSync(ERROR_LOG_DIR, { recursive: true });
}

class ErrorTracker {
  constructor() {
    this.errorCount = 0;
    this.errorMap = new Map(); // Track recurring errors
    this.startTime = Date.now();
  }

  // Track and log error with full details
  track(error, context = {}) {
    this.errorCount++;

    const errorInfo = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      name: error.name || "UnknownError",
      message: error.message,
      stack: error.stack,
      code: error.code,
      statusCode: error.statusCode,
      context: {
        url: context.url,
        method: context.method,
        userId: context.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        body: this.sanitizeBody(context.body),
        query: context.query,
        params: context.params,
      },
      systemInfo: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: os.platform(),
      },
    };

    // Write to file immediately for critical errors
    const logFile = path.join(
      ERROR_LOG_DIR,
      `${new Date().toISOString().split("T")[0]}.log`,
    );
    fs.appendFileSync(logFile, JSON.stringify(errorInfo, null, 2) + "\n---\n");

    // Track recurring errors
    const errorKey = `${error.name}:${error.message}`;
    const count = this.errorMap.get(errorKey) || 0;
    this.errorMap.set(errorKey, count + 1);

    // Log to console with color
    console.error("\x1b[31m%s\x1b[0m", "🔴 ERROR TRACKED:", errorInfo.id);
    console.error("\x1b[33m%s\x1b[0m", `   Message: ${error.message}`);
    console.error(
      "\x1b[36m%s\x1b[0m",
      `   Stack: ${error.stack?.split("\n")[1]?.trim() || "No stack"}`,
    );

    return errorInfo.id;
  }

  // Sanitize body to remove sensitive data
  sanitizeBody(body) {
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
  }

  // Get error statistics
  getStats() {
    return {
      totalErrors: this.errorCount,
      uniqueErrors: this.errorMap.size,
      topErrors: Array.from(this.errorMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([key, count]) => ({ error: key, count })),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  }

  // Generate error report
  generateReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      stats: this.getStats(),
      environment: process.env.NODE_ENV,
      nodeVersion: process.version,
      platform: os.platform(),
    };

    const reportPath = path.join(
      ERROR_LOG_DIR,
      `error-report-${Date.now()}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📊 Error report generated: ${reportPath}`);

    return report;
  }
}

module.exports = new ErrorTracker();

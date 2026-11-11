require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const compression = require("compression");
const http = require("http");
const path = require("path");
const { connectDB } = require("./config/db");
const config = require("./config/config");
const setupWebSocket = require("./utils/socketServer");
const cron = require("node-cron");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");
const hpp = require("hpp");
const cookieParser = require("cookie-parser");

// Middleware imports
const {
  authRateLimiter,
  apiRateLimiter,
  securityHeaders,
  sanitizeInput,
  ipWhitelist,
} = require("./middlewares/securityMiddleware");
const { ensureCsrfCookie, verifyCsrfToken } = require("./middlewares/csrf");
const { errorHandler } = require("./middlewares/errorHandler");
const { asyncWrapper } = require("./middlewares/errorBoundary");
const limiters = require("./middlewares/rateLimiter");
const {
  performanceMiddleware,
  requestIdMiddleware,
} = require("./middlewares/performanceMiddleware");
const {
  addNotificationTriggers,
} = require("./middlewares/notificationMiddleware");
const { requestContext } = require("./middlewares/requestContext");
const { notFoundHandler } = require("./middlewares/globalErrorHandler");
const { stripeWebhook } = require("./controllers/stripeWebhookController");
const timezoneResponseMiddleware = require("./middlewares/timezoneResponseMiddleware");

// Utility imports
const errorTracker = require("./utils/errorTracker");
const debuggerUtil = require("./utils/debugger");

// Service imports
const tradeSyncService = require("./services/tradeSyncService");
// Real-time account (balance/equity) sync — replaces the old REST-polling
// accountSyncService, kept on disk but no longer wired in here.
const mt5AccountWebSocketService = require("./services/mt5AccountWebSocketService");
// Real-time open-trade feed — replaces the old REST-polling
// openTradeSyncService, kept on disk but no longer wired in here.
const mt5TradeWebSocketService = require("./services/mt5TradeWebSocketService");
// Real-time symbol price push — replaces the Flutter client's own 1s/2s
// HTTP polling of GET /api/trading/live/chart-data for live ticks; that
// endpoint is still used unmodified for the one-time chart-history fetch.
const marketPriceFeedService = require("./services/marketPriceFeedService");
const emailService = require("./services/emailService");

// Route imports
const authRoutes = require("./routes/authRoutes");
const leverageRoutes = require("./routes/leverageRoutes");
const groupRoutes = require("./routes/groupRoutes");
const paymentMethodRoutes = require("./routes/paymentMethodRoutes");
const appSettingsRoutes = require("./routes/appSettingsRoutes");
const exchangeRoutes = require("./routes/exchangeRoutes");
const accountRoutes = require("./routes/accountRoutes");
const depositRoutes = require("./routes/depositRoutes");
const adminDepositRoutes = require("./routes/admin/adminDepositRoutes");
const withdrawalRoutes = require("./routes/client/withdrawalRoutes");
const adminWithdrawalRoutes = require("./routes/admin/withdrawalRoutes");
const transferRoutes = require("./routes/client/transferRoutes");
const transactionRoutes = require("./routes/client/transactionRoutes");
const profileRoutes = require("./routes/client/profileRoutes");
const clientRoutes = require("./routes/admin/clientRoutes");
const adminTransactionRoutes = require("./routes/admin/adminTransactionRoutes");
const ticketRoutes = require("./routes/ticketRoutes");
const ibConfigurationRoutes = require("./routes/admin/ibAdminConfigurationRoutes");
const ibFlatCommissionRoutes = require("./routes/admin/ibFlatCommissionRoutes");
const adminClientRoutes = require("./routes/adminClientRoutes");
const ibClientConfigurationRoutes = require("./routes/client/ibClientConfigurationRoutes");
const ibWithdrawalRoutes = require("./routes/client/ibwithdrawalRoutes");
const tradingRoutes = require("./routes/client/tradingRoutes");
const adminDashboardRoutes = require("./routes/admin/adminDashboardRoutes");
const clientDashboardRoutes = require("./routes/client/clientDashboardRoutes");
const assistantRoutes = require("./routes/client/assistantRoutes");
const adminIBWithdrawalRoutes = require("./routes/admin/ibWithdrawalRoutes");
const adminPartnerRoutes = require("./routes/admin/adminPartnerRoutes");
const subadminRoutes = require("./routes/admin/subadminRoutes");
const dailyPerformanceRoutes = require("./routes/client/dailyPerformanceRoutes");
const statementRoutes = require("./routes/client/statementRoutes");
const otpRoutes = require("./routes/client/otpRoutes");
const copyRoutes = require("./routes/client/copyRoutes");
const copyTradeRoutes = require("./routes/client/copyTradeRoutes");
const copyRatingRoutes = require("./routes/client/copyRatingRoutes");
const copyCopierRoutes = require("./routes/client/copyCopierRoutes");
const commissionRoutes = require("./routes/client/commissionRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const revenueAnalyticsRoutes = require("./routes/admin/revenueAnalyticsRoutes");
const superadminRoutes = require("./routes/superadminRoutes");
const { evaluateAndSyncSuspension } = require("./services/suspensionService");

class Server {
  constructor() {
    this.app = express();
    this.server = null;
    this.io = null;
    this.isShuttingDown = false;
    this.connections = new Set();
  }

  /**
   * Initialize all server components
   */
  async initialize() {
    try {
      // Log startup
      debuggerUtil.log("Server starting...", {
        env: process.env.NODE_ENV,
        port: process.env.PORT,
        version: process.env.npm_package_version || "1.0.0",
      });

      // Fail fast on missing required env vars instead of surfacing as an
      // obscure error deep inside a request handler later.
      config.validateConfig();

      // Connect to MongoDB
      await connectDB();
      console.log("✅ MongoDB connected successfully");

      // Setup middleware
      this.setupMiddleware();

      // Setup routes
      this.setupRoutes();

      // Setup error handlers
      this.setupErrorHandlers();

      // Create HTTP server
      this.server = http.createServer(this.app);

      // Track connections for graceful shutdown
      this.trackConnections();

      // Setup WebSocket
      this.setupWebSocket();

      // Setup cleanup jobs
      this.setupCleanupJobs();

      // Setup process handlers
      this.setupProcessHandlers();
    } catch (error) {
      console.error("❌ Server initialization failed:", error);
      process.exit(1);
    }
  }

  /**
   * Setup middleware
   */
  setupMiddleware() {
    this.app.disable("x-powered-by");
    this.app.set("trust proxy", 1);

    // Request context
    this.app.use(requestContext);

    // CORS
    const corsMiddleware = this.getCorsConfig();
    this.app.use(corsMiddleware);
    this.app.options(/.*/, corsMiddleware);

    // Security middleware
    this.app.use(
      helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
          },
        },
      }),
    );

    this.app.use(securityHeaders);
    this.app.use(sanitizeInput);
    this.app.use(
      compression({
        threshold: 1024,
        filter: (req, res) => {
          const contentType = res.getHeader("Content-Type");

          if (
            typeof contentType === "string" &&
            /image|video|audio|zip|pdf/i.test(contentType)
          ) {
            return false;
          }

          return compression.filter(req, res);
        },
      }),
    );

    // Request tracking
    this.app.use(requestIdMiddleware);
    this.app.use(performanceMiddleware);

    // Stripe events forwarded by Relaya: must see the raw body (signature),
    // so it comes before the JSON parser, CSRF and input sanitising.
    this.app.post("/api/stripe/webhook", ...stripeWebhook);

    // Body parsing
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));
    this.app.use(cookieParser());

    // CSRF protection (double-submit cookie)
    this.app.use(ensureCsrfCookie);
    this.app.use(verifyCsrfToken);

    // Data sanitization
    this.app.use(mongoSanitize());
    this.app.use(xss());
    this.app.use(hpp());

    // Logging
    this.setupLogging();

    // Static files
    this.setupStaticFiles();

    // Notification middleware
    this.app.use(addNotificationTriggers);

    // Rewrites outgoing date strings to the superadmin-configured timezone
    this.app.use(timezoneResponseMiddleware);
  }

  /**
   * Get CORS configuration
   */
  getCorsConfig() {
    const normalizeOrigin = (origin) => {
      const trimmed = origin?.trim();

      if (!trimmed) return null;

      try {
        return new URL(trimmed).origin;
      } catch (error) {
        return trimmed.replace(/\/+$/, "");
      }
    };

    const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean);

    const defaultAllowedOrigins = [
      "https://dcrm.testcrm.co.in",
      "https://newcrmfrontend.vercel.app",
    ];

    const localAllowedOrigins = [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000",
    ];

    const allowedOrigins = [
      ...new Set(
        [
          ...envAllowedOrigins,
          normalizeOrigin(process.env.CLIENT_URL),
          ...defaultAllowedOrigins,
          ...(process.env.NODE_ENV === "production" ? [] : localAllowedOrigins),
        ].filter(Boolean),
      ),
    ];

    const allowedOriginPatterns =
      process.env.NODE_ENV === "production"
        ? []
        : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];

    if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
      console.warn("⚠️ No ALLOWED_ORIGINS set in production!");
    }

    return cors((req, callback) => {
      const corsOptions = {
        origin: function (origin, originCallback) {
          if (!origin) return originCallback(null, true);

          const requestOrigin = normalizeOrigin(origin);
          const isExplicitlyAllowed = allowedOrigins.includes(requestOrigin);
          const matchesAllowedPattern = allowedOriginPatterns.some((pattern) =>
            pattern.test(requestOrigin),
          );

          if (isExplicitlyAllowed || matchesAllowedPattern) {
            originCallback(null, true);
          } else {
            console.warn(`Blocked CORS request from origin: ${origin}`);
            originCallback(new Error(`Origin ${origin} not allowed by CORS`));
          }
        },
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "x-active-role",
          "x-device-id",
          "x-device-name",
          "x-csrf-token",
        ],
        credentials: true,
        maxAge: 86400,
        optionsSuccessStatus: 200,
        preflightContinue: false,
      };

      const requestedHeaders = req.header("Access-Control-Request-Headers");

      if (requestedHeaders) {
        corsOptions.allowedHeaders = requestedHeaders
          .split(",")
          .map((header) => header.trim())
          .filter(Boolean);
      }

      callback(null, corsOptions);
    });
  }

  /**
   * Setup logging
   */
  setupLogging() {
    if (process.env.NODE_ENV === "production") {
      morgan.token("ist-time", () => {
        return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      });

      morgan.token("status-colored", (req, res) => {
        const status = res.statusCode;
        const color =
          status >= 500
            ? 31
            : status >= 400
              ? 33
              : status >= 300
                ? 36
                : status >= 200
                  ? 32
                  : 0;
        return "\x1b[" + color + "m" + status + "\x1b[0m";
      });

      this.app.use(
        morgan(
          "[:ist-time] :method :url :status-colored :response-time ms - :res[content-length]",
        ),
      );
    } else if (process.env.DEBUG_MODE === "true") {
      this.app.use(morgan("dev"));
    }
  }

  /**
   * Setup static files
   */
  setupStaticFiles() {
    const uploadsDir = path.join(__dirname, "uploads");

    // Uploads (deposit receipts, KYC docs, attachments) are sensitive -
    // reuse the same origin allow-list as the rest of the API instead of
    // wildcarding CORS for this route.
    this.app.use("/uploads", this.getCorsConfig(), express.static(uploadsDir));
  }

  /**
   * Setup routes
   */
  setupRoutes() {
    // Health check
    this.app.get("/api/health", this.healthCheck.bind(this));

    // Sync status
    this.app.get("/api/sync/status", this.getSyncStatus.bind(this));

    // Service status
    this.app.get("/api/status", this.getServiceStatus.bind(this));

    // API routes
    this.app.use("/api/auth", authRoutes);
    this.app.use("/api/leverages", leverageRoutes);
    this.app.use("/api/groups", groupRoutes);
    this.app.use("/api/payment-methods", paymentMethodRoutes);
    this.app.use("/api/app-settings", appSettingsRoutes);
    this.app.use("/api/exchanges", exchangeRoutes);
    this.app.use("/api/admindeposits", adminDepositRoutes);
    this.app.use("/api/adminwithdrawals", adminWithdrawalRoutes);
    this.app.use("/api/clients", clientRoutes);
    this.app.use("/api/admin/clients", adminClientRoutes);
    this.app.use("/api/admin/transactions", adminTransactionRoutes);
    this.app.use("/api/ib-configurations", ibConfigurationRoutes);
    this.app.use("/api/ib-configurations-flat", ibFlatCommissionRoutes);
    this.app.use("/api/admin/dashboard", adminDashboardRoutes);
    this.app.use("/api/admin/ib-withdrawals", adminIBWithdrawalRoutes);
    this.app.use("/api/admin/partners", adminPartnerRoutes);
    this.app.use("/api/admin/subadmins", subadminRoutes);
    this.app.use("/api/admin/revenue-analytics", revenueAnalyticsRoutes);
    this.app.use("/api/superadmin", superadminRoutes);
    this.app.use("/api/accounts", accountRoutes);
    this.app.use("/api/clientdeposits", depositRoutes);
    this.app.use("/api/withdrawals", withdrawalRoutes);
    this.app.use("/api/transfers", transferRoutes);
    this.app.use("/api/transactions", transactionRoutes);
    this.app.use("/api/profile", profileRoutes);
    this.app.use("/api/ibclients/withdrawals", ibWithdrawalRoutes);
    this.app.use(
      "/api/ibclients/ib-configurations",
      ibClientConfigurationRoutes,
    );
    this.app.use("/api/trading", tradingRoutes);
    this.app.use("/api/client/dashboard", clientDashboardRoutes);
    this.app.use("/api/client/assistant", assistantRoutes);
    this.app.use("/api/daily-performance", dailyPerformanceRoutes);
    this.app.use("/api/otp", otpRoutes);
    this.app.use("/api/client/statement", statementRoutes);
    this.app.use("/api/copy", copyRoutes);
    this.app.use("/api/copy-trade", copyTradeRoutes);
    this.app.use("/api/copy-rating", copyRatingRoutes);
    this.app.use("/api/copy-copier", copyCopierRoutes);
    this.app.use("/api/ibclients/commission", commissionRoutes);
    this.app.use("/api/tickets", ticketRoutes);
    this.app.use("/api/notifications", notificationRoutes);
  }

  /**
   * Health check endpoint
   */
  async healthCheck(req, res) {
    const health = {
      success: true,
      message: "Server is running",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      services: {
        database:
          mongoose.connection.readyState === 1 ? "connected" : "disconnected",
        email: emailService?.isInitialized || false,
        websocket: this.io ? "running" : "stopped",
      },
    };

    res.status(200).json(health);
  }

  /**
   * Get sync status
   */
  async getSyncStatus(req, res) {
    try {
      const tradeSyncStatus = tradeSyncService.getSyncStatus();
      const accountSyncStatus = mt5AccountWebSocketService.getSyncStatus();
      const openTradeSyncStatus = mt5TradeWebSocketService.getSyncStatus();

      res.status(200).json({
        success: true,
        tradeSync: tradeSyncStatus,
        accountSync: accountSyncStatus,
        openTradeSync: openTradeSyncStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Sync status error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to get sync status",
        error: error.message,
      });
    }
  }

  /**
   * Get all service status
   */
  async getServiceStatus(req, res) {
    try {
      const status = {
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
        services: {
          tradeSync: tradeSyncService.getSyncStatus(),
          accountSync: mt5AccountWebSocketService.getSyncStatus(),
          openTradeSync: mt5TradeWebSocketService.getSyncStatus(),
          email: emailService.getStatus
            ? emailService.getStatus()
            : { initialized: true },
        },
        timestamp: new Date().toISOString(),
      };

      res.status(200).json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Setup error handlers
   */
  setupErrorHandlers() {
    this.app.use(notFoundHandler);
    this.app.use(errorHandler);
  }

  /**
   * Track HTTP connections for graceful shutdown
   */
  trackConnections() {
    this.server.on("connection", (connection) => {
      this.connections.add(connection);
      connection.on("close", () => {
        this.connections.delete(connection);
      });
    });
  }

  /**
   * Setup WebSocket
   */
  setupWebSocket() {
    this.io = setupWebSocket(this.server);
    this.app.set("io", this.io);
    tradeSyncService.setSocketServer(this.io);
    mt5TradeWebSocketService.setSocketServer(this.io);
    mt5AccountWebSocketService.setSocketServer(this.io);
    marketPriceFeedService.setSocketServer(this.io);
    console.log("✅ WebSocket server initialized");
  }

  /**
   * Setup cleanup jobs
   */
  setupCleanupJobs() {
    // Notification cleanup - runs daily at 2 AM
    cron.schedule("0 2 * * *", async () => {
      try {
        console.log("🧹 Running scheduled notification cleanup...");
        if (this.io && this.io.notificationService) {
          const cleanedCount =
            await this.io.notificationService.cleanupOldNotifications(90);
          console.log(`✅ Cleaned ${cleanedCount} old notifications`);
        }
      } catch (error) {
        console.error("❌ Notification cleanup failed:", error);
      }
    });

    // Session cleanup - runs every hour
    cron.schedule("0 * * * *", async () => {
      try {
        console.log("🧹 Running session cleanup...");
        // Add session cleanup logic here
      } catch (error) {
        console.error("Session cleanup failed:", error);
      }
    });

    // Log rotation - runs daily at midnight
    cron.schedule("0 0 * * *", () => {
      console.log("📝 Running log rotation...");
      // Add log rotation logic here
    });

    cron.schedule("0 9 * * *", async () => {
      try {
        await evaluateAndSyncSuspension({
          io: this.io,
          broadcastIfChanged: true,
        });
        console.log("✅ Billing suspension evaluation completed");
      } catch (error) {
        console.error("Billing suspension evaluation failed:", error);
      }
    });
  }

  /**
   * Setup process handlers
   */
  setupProcessHandlers() {
    // Graceful shutdown
    process.on("SIGTERM", () => this.gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => this.gracefulShutdown("SIGINT"));

    // Uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("💥 Uncaught Exception:", error);
      errorTracker.track(error, { type: "uncaughtException" });
    });

    // Unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
      errorTracker.track(reason, { type: "unhandledRejection" });
    });
  }

  /**
   * Graceful shutdown
   */
  async gracefulShutdown(signal) {
    if (this.isShuttingDown) {
      console.log("Shutdown already in progress...");
      return;
    }

    this.isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

    // Stop accepting new connections
    if (this.server) {
      this.server.close(() => {
        console.log("✅ HTTP server closed");
      });
    }

    // Close existing connections
    console.log(`Closing ${this.connections.size} existing connections...`);
    for (const connection of this.connections) {
      connection.destroy();
    }

    // Stop sync services
    try {
      await tradeSyncService.stopAutoSync();
      console.log("✅ Trade sync service stopped");
    } catch (error) {
      console.error("Error stopping trade sync:", error);
    }

    try {
      await mt5AccountWebSocketService.stopAutoSync();
      console.log("✅ MT5 WebSocket account sync stopped");
    } catch (error) {
      console.error("Error stopping MT5 WebSocket account sync:", error);
    }

    try {
      await mt5TradeWebSocketService.stopAutoSync();
      console.log("✅ MT5 WebSocket open-trade sync stopped");
    } catch (error) {
      console.error("Error stopping MT5 WebSocket open-trade sync:", error);
    }

    try {
      marketPriceFeedService.stop();
      console.log("✅ Market price feed stopped");
    } catch (error) {
      console.error("Error stopping market price feed:", error);
    }

    // Give some time for cleanup
    await this.sleep(2000);

    console.log("✅ Graceful shutdown completed");
    process.exit(0);
  }

  /**
   * Start the server
   */
  async start() {
    const PORT = config.PORT || 5000;

    this.server.listen(PORT, async () => {
      this.printStartupInfo(PORT);

      // Start sync services
      await this.startSyncServices();
    });

    // Handle server errors
    this.server.on("error", (error) => {
      debuggerUtil.log("Server error", error.message);
      errorTracker.track(error, { type: "serverError" });

      if (error.code === "EADDRINUSE") {
        console.error(
          `❌ Port ${PORT} is already in use. Please free the port and restart.`,
        );
        process.exit(1);
      }
    });
  }

  /**
   * Start sync services
   */
  async startSyncServices() {
    const tradeSyncEnabled = process.env.ENABLE_TRADE_SYNC !== "false";
    const accountSyncEnabled = process.env.ENABLE_ACCOUNT_SYNC !== "false";
    const openTradeSyncEnabled = process.env.ENABLE_OPEN_TRADE_SYNC !== "false";
    const marketPriceFeedEnabled =
      process.env.ENABLE_MARKET_PRICE_FEED !== "false";

    const results = await Promise.allSettled([
      tradeSyncEnabled
        ? tradeSyncService.startAutoSync()
        : Promise.resolve("disabled"),
      // Real-time MT5 WebSocket feed replaces the old REST-polling
      // accountSyncService (still on disk, no longer wired in — see
      // services/mt5AccountWebSocketService.js header comment). Reuses the
      // same ENABLE_ACCOUNT_SYNC flag so no new env var is needed to toggle it.
      accountSyncEnabled
        ? mt5AccountWebSocketService.startAutoSync()
        : Promise.resolve("disabled"),
      // Same swap for open trades: mt5TradeWebSocketService replaces the
      // old REST-polling openTradeSyncService, reusing ENABLE_OPEN_TRADE_SYNC.
      openTradeSyncEnabled
        ? mt5TradeWebSocketService.startAutoSync()
        : Promise.resolve("disabled"),
      // Real-time symbol price push — see services/marketPriceFeedService.js.
      // Subscribed symbols are driven entirely by Socket.IO room membership
      // (utils/socketServer.js's market:subscribe/unsubscribe handlers), so
      // starting this here just opens the shared upstream connection; it
      // sends no subscribe message until a client actually asks for one.
      marketPriceFeedEnabled
        ? Promise.resolve(marketPriceFeedService.start())
        : Promise.resolve("disabled"),
    ]);

    if (!tradeSyncEnabled) {
      console.log("Trade sync service disabled (ENABLE_TRADE_SYNC=false)");
    } else if (results[0].status === "fulfilled") {
      console.log("Automated trade sync service started successfully!");
    } else {
      console.error("Failed to start trade sync service:", results[0].reason);
    }

    if (!accountSyncEnabled) {
      console.log("Account sync service disabled (ENABLE_ACCOUNT_SYNC=false)");
    } else if (results[1].status === "fulfilled") {
      console.log("Automated account sync service started successfully!");
    } else {
      console.error("Failed to start account sync service:", results[1].reason);
    }

    if (!openTradeSyncEnabled) {
      console.log(
        "Open-trade sync service disabled (ENABLE_OPEN_TRADE_SYNC=false)",
      );
    } else if (results[2].status === "fulfilled") {
      console.log("Automated open-trade sync service started successfully!");
    } else {
      console.error(
        "Failed to start open-trade sync service:",
        results[2].reason,
      );
    }

    if (!marketPriceFeedEnabled) {
      console.log(
        "Market price feed disabled (ENABLE_MARKET_PRICE_FEED=false)",
      );
    } else if (results[3].status === "fulfilled") {
      console.log("Market price feed started successfully!");
    } else {
      console.error("Failed to start market price feed:", results[3].reason);
    }

    // Test email configuration if not in production
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.TEST_EMAIL_ON_START === "true"
    ) {
      try {
        await emailService.testConfiguration(
          process.env.ADMIN_EMAIL || "admin@test.com",
        );
      } catch (error) {
        console.error("Email test failed:", error);
      }
    }
  }

  /**
   * Print startup information
   */
  printStartupInfo(PORT) {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                    🚀 SERVER STARTED                      ║
╠══════════════════════════════════════════════════════════╣
║ Environment:  ${process.env.NODE_ENV || "development"}${" ".repeat(37 - (process.env.NODE_ENV || "development").length)}║
║ Port:         ${PORT}${" ".repeat(46 - PORT.toString().length)}║
║ Database:     ${mongoose.connection.readyState === 1 ? "✅ Connected" : "❌ Not connected"}${" ".repeat(29)}║
║ Client URL:   ${process.env.CLIENT_URL || "Not set"}${" ".repeat(39 - (process.env.CLIENT_URL || "Not set").length)}║
║ Server URL:   ${process.env.SERVER_URL || "Not set"}${" ".repeat(39 - (process.env.SERVER_URL || "Not set").length)}║
║ Started at:   ${new Date().toLocaleString()}${" ".repeat(26)}║
╚══════════════════════════════════════════════════════════╝
`);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Import mongoose for health check
const mongoose = require("mongoose");
const server = new Server();

// Create and start server
(async () => {
  try {
    await server.initialize(); // ✅ wait for initialization

    await server.start(); // ✅ then start server
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
module.exports = server;

// backend/services/cronJobService.js
const cron = require("node-cron");
const tradeSyncService = require("./tradeSyncService");
const AccountSyncService = require("./accountSyncService");
const EventEmitter = require("events");

class CronJobService extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // Track all scheduled jobs
    this.jobHistory = new Map(); // Track job execution history
    this.isShuttingDown = false;
    const tradeSyncIntervalMs =
      parseInt(process.env.TRADE_SYNC_INTERVAL_MS, 10) || 120000;
    const directTradeSyncEnabled = process.env.ENABLE_TRADE_SYNC !== "false";

    // Configuration with defaults
    this.config = {
      autoSync: {
        schedule:
          process.env.CRON_AUTO_SYNC ||
          this.getCronScheduleFromInterval(tradeSyncIntervalMs),
        enabled:
          !directTradeSyncEnabled && process.env.ENABLE_AUTO_SYNC !== "false",
        timeRangeHours: parseInt(process.env.AUTO_SYNC_RANGE_HOURS) || 1,
      },
      dailySync: {
        schedule: process.env.CRON_DAILY_SYNC || "0 2 * * *", // Default: 2 AM daily
        enabled:
          !directTradeSyncEnabled && process.env.ENABLE_DAILY_SYNC !== "false",
        timeRangeHours: parseInt(process.env.DAILY_SYNC_RANGE_HOURS) || 24,
      },
      accountSync: {
        schedule: process.env.CRON_ACCOUNT_SYNC || "*/5 * * * *", // Default: every 5 minutes
        enabled: process.env.ENABLE_ACCOUNT_SYNC !== "false",
      },
      cleanup: {
        schedule: process.env.CRON_CLEANUP || "0 3 * * *", // Default: 3 AM daily
        enabled: process.env.ENABLE_CLEANUP !== "false",
        retentionDays: parseInt(process.env.DATA_RETENTION_DAYS) || 90,
      },
      healthCheck: {
        schedule: process.env.CRON_HEALTH_CHECK || "*/15 * * * *", // Default: every 15 minutes
        enabled: process.env.ENABLE_HEALTH_CHECK !== "false",
      },
    };

    // Track running jobs to prevent overlaps
    this.runningJobs = new Set();
  }

  getCronScheduleFromInterval(intervalMs) {
    const intervalMinutes = Math.max(
      1,
      Math.ceil(intervalMs / (1000 * 60)),
    );

    if (intervalMinutes >= 60) {
      const intervalHours = Math.max(1, Math.ceil(intervalMinutes / 60));
      return `0 */${intervalHours} * * *`;
    }

    return `*/${intervalMinutes} * * * *`;
  }

  /**
   * Initialize all cron jobs with better error handling
   */
  initializeCronJobs() {
    console.log("🚀 Initializing cron jobs...");

    // Start configured jobs
    if (this.config.autoSync.enabled) {
      this.startAutoSync();
    }

    if (this.config.dailySync.enabled) {
      this.startDailySync();
    }

    if (this.config.accountSync.enabled) {
      this.startAccountSync();
    }

    if (this.config.cleanup.enabled) {
      this.startCleanupJob();
    }

    if (this.config.healthCheck.enabled) {
      this.startHealthCheck();
    }

    console.log(`✅ Initialized ${this.jobs.size} cron jobs`);
    this.emit("initialized", { jobCount: this.jobs.size });

    // Set up graceful shutdown
    this.setupGracefulShutdown();
  }

  /**
   * Start auto sync for trades with improved logic
   */
  startAutoSync() {
    const jobName = "auto-sync";

    if (this.jobs.has(jobName)) {
      console.log(`⚠️ Job ${jobName} already running, stopping it first...`);
      this.stopJob(jobName);
    }

    const job = cron.schedule(
      this.config.autoSync.schedule,
      async () => {
        await this.executeWithLock(jobName, async () => {
          try {
            console.log(
              `[${new Date().toISOString()}] 🔄 Starting automated trade sync...`,
            );

            const endTime = new Date();
            const startTime = new Date(
              endTime.getTime() -
                this.config.autoSync.timeRangeHours * 60 * 60 * 1000,
            );

            const result = await this.executeWithTiming(
              () =>
                tradeSyncService.processDateRange(startTime, endTime),
              jobName,
            );

            console.log(`✅ Auto sync completed:`, {
              tradesProcessed: result?.tradesStored || result?.totalTrades || 0,
              commissionsCreated: result?.commissionsCreated || 0,
              duration: result?.duration,
            });

            this.recordJobSuccess(jobName, result);
            this.emit("job-success", { job: jobName, result });
          } catch (error) {
            console.error(`❌ Error in ${jobName}:`, error);
            this.recordJobFailure(jobName, error);
            this.emit("job-error", { job: jobName, error: error.message });

            // Implement alert for repeated failures
            await this.handleJobFailure(jobName, error);
          }
        });
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || "UTC",
      },
    );

    this.jobs.set(jobName, job);
    console.log(
      `✅ Auto sync cron job started - Schedule: ${this.config.autoSync.schedule}`,
    );
  }

  /**
   * Start daily sync with configurable time range
   */
  startDailySync() {
    const jobName = "daily-sync";

    if (this.jobs.has(jobName)) {
      this.stopJob(jobName);
    }

    const job = cron.schedule(
      this.config.dailySync.schedule,
      async () => {
        await this.executeWithLock(jobName, async () => {
          try {
            console.log(
              `[${new Date().toISOString()}] 📅 Starting daily trade sync...`,
            );

            const endTime = new Date();
            const startTime = new Date(
              endTime.getTime() -
                this.config.dailySync.timeRangeHours * 60 * 60 * 1000,
            );

            const result = await this.executeWithTiming(
              () =>
                tradeSyncService.processDateRange(startTime, endTime),
              jobName,
            );

            console.log(`✅ Daily sync completed:`, {
              tradesProcessed: result?.tradesStored || result?.totalTrades || 0,
              commissionsCreated: result?.commissionsCreated || 0,
              duration: result?.duration,
            });

            this.recordJobSuccess(jobName, result);
            this.emit("job-success", { job: jobName, result });
          } catch (error) {
            console.error(`❌ Error in ${jobName}:`, error);
            this.recordJobFailure(jobName, error);
            this.emit("job-error", { job: jobName, error: error.message });
            await this.handleJobFailure(jobName, error);
          }
        });
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || "UTC",
      },
    );

    this.jobs.set(jobName, job);
    console.log(
      `✅ Daily sync cron job started - Schedule: ${this.config.dailySync.schedule}`,
    );
  }

  /**
   * Start account sync job
   */
  startAccountSync() {
    const jobName = "account-sync";

    if (this.jobs.has(jobName)) {
      this.stopJob(jobName);
    }

    const job = cron.schedule(
      this.config.accountSync.schedule,
      async () => {
        await this.executeWithLock(jobName, async () => {
          try {
            console.log(
              `[${new Date().toISOString()}] 💰 Starting account balance sync...`,
            );

            const result = await this.executeWithTiming(
              () => AccountSyncService.syncAllAccounts(),
              jobName,
            );

            console.log(`✅ Account sync completed:`, result);
            this.recordJobSuccess(jobName, result);
            this.emit("job-success", { job: jobName, result });
          } catch (error) {
            console.error(`❌ Error in ${jobName}:`, error);
            this.recordJobFailure(jobName, error);
            this.emit("job-error", { job: jobName, error: error.message });
            await this.handleJobFailure(jobName, error);
          }
        });
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || "UTC",
      },
    );

    this.jobs.set(jobName, job);
    console.log(
      `✅ Account sync cron job started - Schedule: ${this.config.accountSync.schedule}`,
    );
  }

  /**
   * Start cleanup job for old data
   */
  startCleanupJob() {
    const jobName = "cleanup";

    if (this.jobs.has(jobName)) {
      this.stopJob(jobName);
    }

    const job = cron.schedule(
      this.config.cleanup.schedule,
      async () => {
        await this.executeWithLock(jobName, async () => {
          try {
            console.log(
              `[${new Date().toISOString()}] 🧹 Starting data cleanup...`,
            );

            const result = await this.executeWithTiming(async () => {
              const cutoffDate = new Date();
              cutoffDate.setDate(
                cutoffDate.getDate() - this.config.cleanup.retentionDays,
              );

              // Clean up old processed trades
              const tradesResult = await this.cleanupOldTrades(cutoffDate);

              // Clean up old commissions
              const commissionsResult =
                await this.cleanupOldCommissions(cutoffDate);

              return {
                tradesDeleted: tradesResult.deletedCount,
                commissionsDeleted: commissionsResult.deletedCount,
                retentionDays: this.config.cleanup.retentionDays,
              };
            }, jobName);

            console.log(`✅ Cleanup completed:`, result);
            this.recordJobSuccess(jobName, result);
            this.emit("job-success", { job: jobName, result });
          } catch (error) {
            console.error(`❌ Error in ${jobName}:`, error);
            this.recordJobFailure(jobName, error);
            this.emit("job-error", { job: jobName, error: error.message });
          }
        });
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || "UTC",
      },
    );

    this.jobs.set(jobName, job);
    console.log(
      `✅ Cleanup cron job started - Schedule: ${this.config.cleanup.schedule}`,
    );
  }

  /**
   * Start health check job
   */
  startHealthCheck() {
    const jobName = "health-check";

    if (this.jobs.has(jobName)) {
      this.stopJob(jobName);
    }

    const job = cron.schedule(
      this.config.healthCheck.schedule,
      async () => {
        await this.executeWithLock(jobName, async () => {
          try {
            const healthStatus = await this.checkSystemHealth();

            if (!healthStatus.healthy) {
              console.warn("⚠️ Health check warnings:", healthStatus.warnings);
              this.emit("health-warning", healthStatus);
            } else {
              if (process.env.DEBUG_MODE === "true") {
                console.log("✅ Health check passed:", healthStatus);
              }
            }

            this.recordJobSuccess(jobName, healthStatus);
          } catch (error) {
            console.error(`❌ Health check error:`, error);
            this.recordJobFailure(jobName, error);
          }
        });
      },
      {
        scheduled: true,
        timezone: process.env.TIMEZONE || "UTC",
      },
    );

    this.jobs.set(jobName, job);
    console.log(
      `✅ Health check cron job started - Schedule: ${this.config.healthCheck.schedule}`,
    );
  }

  /**
   * Execute job with lock to prevent concurrent runs
   */
  async executeWithLock(jobName, fn) {
    if (this.runningJobs.has(jobName)) {
      console.log(`⏭️ Job ${jobName} is already running, skipping...`);
      return null;
    }

    if (this.isShuttingDown) {
      console.log(`🛑 Job ${jobName} skipped due to shutdown`);
      return null;
    }

    this.runningJobs.add(jobName);

    try {
      return await fn();
    } finally {
      this.runningJobs.delete(jobName);
    }
  }

  /**
   * Execute function with timing measurement
   */
  async executeWithTiming(fn, jobName) {
    const startTime = Date.now();
    const result = await fn();
    const duration = Date.now() - startTime;

    if (duration > 30000) {
      // Warning if job takes more than 30 seconds
      console.warn(`⚠️ Job ${jobName} took ${duration}ms to complete`);
    }

    return { ...result, duration: `${duration}ms` };
  }

  /**
   * Format date for API
   */
  formatDateTime(date) {
    return date.toISOString().slice(0, 19).replace("T", " ");
  }

  /**
   * Record successful job execution
   */
  recordJobSuccess(jobName, result) {
    const history = this.jobHistory.get(jobName) || [];
    history.push({
      timestamp: new Date(),
      status: "success",
      result: result,
      duration: result?.duration,
    });

    // Keep only last 100 records
    if (history.length > 100) history.shift();
    this.jobHistory.set(jobName, history);
  }

  /**
   * Record failed job execution
   */
  recordJobFailure(jobName, error) {
    const history = this.jobHistory.get(jobName) || [];
    history.push({
      timestamp: new Date(),
      status: "failed",
      error: error.message,
      stack: error.stack,
    });

    if (history.length > 100) history.shift();
    this.jobHistory.set(jobName, history);
  }

  /**
   * Handle job failure with alert logic
   */
  async handleJobFailure(jobName, error) {
    const failures = this.getRecentFailures(jobName, 3600000); // Last hour

    if (failures.length >= 3) {
      console.error(
        `🚨 Job ${jobName} has failed ${failures.length} times in the last hour`,
      );
      this.emit("critical-failure", { job: jobName, failures });

      // Send alert if configured
      if (process.env.ALERT_WEBHOOK_URL) {
        await this.sendAlert(jobName, failures);
      }
    }
  }

  /**
   * Get recent failures for a job
   */
  getRecentFailures(jobName, timeWindowMs) {
    const history = this.jobHistory.get(jobName) || [];
    const cutoff = Date.now() - timeWindowMs;

    return history.filter(
      (entry) =>
        entry.status === "failed" && entry.timestamp.getTime() > cutoff,
    );
  }

  /**
   * Send alert for critical failures
   */
  async sendAlert(jobName, failures) {
    try {
      const axios = require("axios");
      await axios.post(process.env.ALERT_WEBHOOK_URL, {
        service: "CronJobService",
        job: jobName,
        failures: failures.length,
        lastError: failures[failures.length - 1]?.error,
        timestamp: new Date().toISOString(),
      });
    } catch (alertError) {
      console.error("Failed to send alert:", alertError);
    }
  }

  /**
   * Check system health
   */
  async checkSystemHealth() {
    const warnings = [];
    let healthy = true;

    // Check job statuses
    for (const [jobName, job] of this.jobs) {
      const recentFailures = this.getRecentFailures(jobName, 3600000);
      if (recentFailures.length > 2) {
        warnings.push(
          `Job ${jobName} has ${recentFailures.length} failures in last hour`,
        );
        healthy = false;
      }
    }

    // Check database connection
    try {
      const mongoose = require("mongoose");
      if (mongoose.connection.readyState !== 1) {
        warnings.push("Database connection is not ready");
        healthy = false;
      }
    } catch (error) {
      warnings.push(`Database check failed: ${error.message}`);
      healthy = false;
    }

    return {
      healthy,
      warnings,
      timestamp: new Date().toISOString(),
      activeJobs: Array.from(this.jobs.keys()),
      runningJobs: Array.from(this.runningJobs),
    };
  }

  /**
   * Clean up old trades
   */
  async cleanupOldTrades(cutoffDate) {
    const IBClosedTrade = require("../models/IBClosedTrade");
    const result = await IBClosedTrade.deleteMany({
      processed: true,
      closeTime: { $lt: cutoffDate },
    });
    return result;
  }

  /**
   * Clean up old commissions
   */
  async cleanupOldCommissions(cutoffDate) {
    const IBCommission = require("../models/IBCommission");
    const result = await IBCommission.deleteMany({
      status: { $in: ["paid", "cancelled"] },
      createdAt: { $lt: cutoffDate },
    });
    return result;
  }

  /**
   * Manual sync with validation
   */
  async manualSync(startTime, endTime) {
    // Validate input
    const start = new Date(startTime);
    const end = new Date(endTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error("Invalid date format");
    }

    if (start > end) {
      throw new Error("Start time must be before end time");
    }

    const maxRangeHours =
      parseInt(process.env.MAX_MANUAL_SYNC_RANGE_HOURS) || 720; // 30 days
    const rangeHours = (end - start) / (1000 * 60 * 60);

    if (rangeHours > maxRangeHours) {
      throw new Error(`Date range exceeds maximum of ${maxRangeHours} hours`);
    }

    try {
      console.log(`🔧 Manual sync initiated from ${startTime} to ${endTime}`);

      const result = await tradeSyncService.processDateRange(start, end);

      console.log("✅ Manual sync completed:", result);
      this.emit("manual-sync", { startTime, endTime, result });
      return result;
    } catch (error) {
      console.error("❌ Error in manual sync:", error);
      throw error;
    }
  }

  /**
   * Stop a specific job
   */
  stopJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.stop();
      this.jobs.delete(jobName);
      console.log(`⏹️ Stopped job: ${jobName}`);
      return true;
    }
    return false;
  }

  /**
   * Restart a specific job
   */
  restartJob(jobName) {
    this.stopJob(jobName);

    switch (jobName) {
      case "auto-sync":
        this.startAutoSync();
        break;
      case "daily-sync":
        this.startDailySync();
        break;
      case "account-sync":
        this.startAccountSync();
        break;
      case "cleanup":
        this.startCleanupJob();
        break;
      case "health-check":
        this.startHealthCheck();
        break;
      default:
        console.log(`Unknown job: ${jobName}`);
        return false;
    }

    return true;
  }

  /**
   * Get job status and history
   */
  getJobStatus(jobName) {
    return {
      isRunning: this.runningJobs.has(jobName),
      isScheduled: this.jobs.has(jobName),
      history: this.jobHistory.get(jobName)?.slice(-10) || [], // Last 10 executions
      config: this.config[jobName.replace("-", "")],
    };
  }

  /**
   * Get all jobs status
   */
  getAllJobsStatus() {
    const status = {};
    for (const jobName of this.jobs.keys()) {
      status[jobName] = this.getJobStatus(jobName);
    }
    return status;
  }

  /**
   * Setup graceful shutdown
   */
  setupGracefulShutdown() {
    process.on("SIGTERM", async () => {
      await this.shutdown();
    });

    process.on("SIGINT", async () => {
      await this.shutdown();
    });
  }

  /**
   * Shutdown all cron jobs gracefully
   */
  async shutdown() {
    console.log("🛑 Shutting down cron jobs...");
    this.isShuttingDown = true;

    for (const [jobName, job] of this.jobs) {
      job.stop();
      console.log(`Stopped job: ${jobName}`);
    }

    this.jobs.clear();
    console.log("✅ All cron jobs stopped");
    this.emit("shutdown");
  }
}

module.exports = new CronJobService();

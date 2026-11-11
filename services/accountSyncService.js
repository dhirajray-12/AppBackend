const Account = require("../models/client/Account");
const axios = require("axios");
const { metaApi } = require("../API/metaApi");
const EventEmitter = require("events");
const {
  invalidateStatementCaches,
} = require("../controllers/client/statementController");
require("dotenv").config();

class AccountSyncService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.syncInterval = null;
    this.syncStats = {
      lastSyncTime: null,
      lastSuccessfulSync: null,
      successCount: 0,
      errorCount: 0,
      totalAccounts: 0,
      status: "idle",
      currentBatch: {
        processed: 0,
        total: 0,
        errors: 0,
      },
    };

    // Configuration with defaults
    this.config = {
      syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS) || 30000,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 5000,
      batchSize: parseInt(process.env.SYNC_BATCH_SIZE) || 100,
      managerIndex: parseInt(process.env.MANAGER_INDEX) || 3,
      staleAccountThresholdMs:
        parseInt(process.env.STALE_ACCOUNT_THRESHOLD_MS) || 300000, // 5 minutes
    };
  }

  /**
   * Start the automated sync service with improved initialization
   */
  async startAutoSync() {
    if (this.isRunning) {
      console.log("⚠️ Account sync service is already running");
      return;
    }

    this.isRunning = true;
    console.log("🔄 Starting automated account sync service...");
    this.emit("started");

    // Optional: Run initial sync immediately
    if (process.env.RUN_INITIAL_SYNC !== "false") {
      await this.runWithRetry(() => this.syncAllAccounts());
    }

    // Start continuous sync loop
    this.continuousSync();
  }

  /**
   * Continuous sync loop with adaptive timing and error handling
   */
  async continuousSync() {
    while (this.isRunning) {
      const startTime = Date.now();

      try {
        await this.runWithRetry(() => this.syncAllAccounts());

        // Calculate actual time taken and adjust next sync if needed
        const timeTaken = Date.now() - startTime;
        const waitTime = Math.max(0, this.config.syncIntervalMs - timeTaken);

        if (waitTime > 0) {
          await this.sleep(waitTime);
        }
      } catch (error) {
        console.error("❌ Critical error in sync loop:", error);
        this.emit("error", error);

        // Exponential backoff on critical errors
        await this.sleep(this.config.retryDelayMs * 2);
      }
    }
  }

  /**
   * Generic retry wrapper with exponential backoff
   */
  async runWithRetry(fn, retries = this.config.maxRetries) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        const isLastAttempt = i === retries - 1;
        if (isLastAttempt) throw error;

        const delay = this.config.retryDelayMs * Math.pow(2, i);
        console.log(
          `⚠️ Retry ${i + 1}/${retries} in ${delay}ms: ${error.message}`,
        );
        await this.sleep(delay);
      }
    }
  }

  /**
   * Main sync function with batch processing and better error isolation
   */
  async syncAllAccounts() {
    const syncStartTime = Date.now();

    try {
      this.syncStats.status = "syncing";
      this.syncStats.lastSyncTime = new Date();

      console.log(
        `[${new Date().toLocaleString()}] 🔄 Starting account balance sync...`,
      );

      // Get only active accounts that need syncing
      const accounts = await this.getAccountsNeedingSync();

      if (accounts.length === 0) {
        console.log("📭 No accounts need syncing at this time");
        this.syncStats.status = "idle";
        this.syncStats.totalAccounts = 0;
        return;
      }

      this.syncStats.totalAccounts = accounts.length;
      this.syncStats.currentBatch = {
        processed: 0,
        total: accounts.length,
        errors: 0,
      };

      console.log(`📊 Found ${accounts.length} accounts to sync`);

      // Process accounts in batches
      const results = await this.processBatches(accounts);

      // Update sync statistics
      this.syncStats.successCount++;
      this.syncStats.lastSuccessfulSync = new Date();
      this.syncStats.status = "idle";

      const duration = ((Date.now() - syncStartTime) / 1000).toFixed(2);

      console.log(
        `✅ Sync completed in ${duration}s: ${results.updated} updated, ` +
          `${results.errors} errors, ${results.skipped} skipped`,
      );

      this.emit("sync-complete", results);

      return results;
    } catch (error) {
      console.error("❌ Account sync fatal error:", error);
      this.syncStats.errorCount++;
      this.syncStats.status = "error";
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Get accounts that actually need syncing (performance optimization)
   */
  async getAccountsNeedingSync() {
    const staleTime = new Date(
      Date.now() - this.config.staleAccountThresholdMs,
    );

    // Only sync accounts that haven't been updated recently OR force sync all
    const query =
      process.env.FORCE_FULL_SYNC === "true"
        ? { status: true }
        : {
            status: true,
            $or: [
              { updatedAt: { $lt: staleTime } },
              { updatedAt: { $exists: false } },
              { balance: { $exists: false } },
            ],
          };

    const accounts = await Account.find(query)
      .select("mt5Account managerIndex _id user balance equity updatedAt")
      .lean();

    return accounts;
  }

  /**
   * Process accounts in batches to avoid overwhelming the API
   */
  async processBatches(accounts) {
    const batches = this.createBatches(accounts, this.config.batchSize);
    const results = {
      updated: 0,
      errors: 0,
      skipped: 0,
      details: [],
    };

    console.log(
      `📦 Processing ${batches.length} batches of up to ${this.config.batchSize} accounts each`,
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(
        `🔄 Processing batch ${i + 1}/${batches.length} (${batch.accounts.length} accounts)`,
      );

      try {
        const batchResult = await this.syncAccountBatch(batch);
        results.updated += batchResult.updated;
        results.errors += batchResult.errors;
        results.skipped += batchResult.skipped;
        results.details.push(...batchResult.details);

        this.syncStats.currentBatch.processed += batch.accounts.length;
        this.syncStats.currentBatch.errors = results.errors;

        // Small delay between batches to prevent rate limiting
        if (i < batches.length - 1) {
          await this.sleep(1000);
        }
      } catch (batchError) {
        console.error(`❌ Batch ${i + 1} failed:`, batchError.message);
        results.errors += batch.accounts.length;
        results.details.push({
          batch: i + 1,
          error: batchError.message,
          accounts: batch.accounts.map((a) => a.mt5Account),
        });
      }
    }

    return results;
  }

  /**
   * Create batches from accounts array
   */
  createBatches(accounts, batchSize) {
    const batches = [];
    for (let i = 0; i < accounts.length; i += batchSize) {
      batches.push({
        accounts: accounts.slice(i, i + batchSize),
        startIndex: i,
        endIndex: Math.min(i + batchSize, accounts.length),
      });
    }
    return batches;
  }

  /**
   * Sync a single batch of accounts
   */
  async syncAccountBatch(batch) {
    const accountsByManager = new Map();

    for (const account of batch.accounts) {
      const managerIndex =
        Number.parseInt(account.managerIndex, 10) ||
        this.config.managerIndex;

      if (!accountsByManager.has(managerIndex)) {
        accountsByManager.set(managerIndex, []);
      }

      accountsByManager.get(managerIndex).push(account);
    }

    const managerResults = await Promise.all(
      Array.from(accountsByManager.entries()).map(([managerIndex, accounts]) =>
        this.syncAccountsForManager(accounts, managerIndex),
      ),
    );

    const results = managerResults.flatMap((result) => result.results);
    const updatedUserIds = [
      ...new Set(
        results
          .filter((result) => result.success && !result.skipped && result.userId)
          .map((result) => result.userId),
      ),
    ];

    if (updatedUserIds.length > 0) {
      await Promise.all(
        updatedUserIds.map((userId) => invalidateStatementCaches(userId)),
      );
    }

    return {
      updated: results.filter((result) => result.success && !result.skipped).length,
      errors: results.filter((result) => !result.success).length,
      skipped: results.filter((result) => result.success && result.skipped).length,
      details: results.filter((result) => !result.success || result.skipped),
    };
  }

  async syncAccountsForManager(accounts, managerIndex) {
    const mt5AccountNumbers = accounts
      .map((acc) => Number.parseInt(acc.mt5Account, 10))
      .filter(Number.isFinite);
    const accountMappings = new Map(
      accounts.map((acc) => [Number.parseInt(acc.mt5Account, 10), acc]),
    );

    try {
      const response = await metaApi.post(
        `/GetUserInfoByAccounts`,
        {
          Manager_Index: managerIndex,
          MT5Accounts: mt5AccountNumbers,
        },
        {
          timeout: 30000,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error("Invalid API response format");
      }

      const results = await Promise.all(
        response.data.map(async (userInfo) => {
          try {
            const mt5Account = Number.parseInt(
              this.extractAccountNumber(userInfo),
              10,
            );
            const balance = this.extractBalance(userInfo);
            const equity = this.extractEquity(userInfo);

            if (!Number.isFinite(mt5Account)) {
              return {
                success: false,
                reason: "No account number",
                data: userInfo,
                managerIndex,
              };
            }

            const existingAccount = accountMappings.get(mt5Account);
            if (!existingAccount) {
              return {
                success: false,
                reason: "Account not found in mapping",
                mt5Account,
                managerIndex,
              };
            }

            if (
              existingAccount.balance === balance &&
              existingAccount.equity === equity
            ) {
              return {
                success: true,
                skipped: true,
                mt5Account,
                managerIndex,
                reason: "No changes",
              };
            }

            await Account.findByIdAndUpdate(
              existingAccount._id,
              {
                $set: {
                  balance,
                  equity,
                  updatedAt: new Date(),
                },
              },
              { new: true, runValidators: false },
            );

            return {
              success: true,
              mt5Account,
              balance,
              equity,
              managerIndex,
              userId:
                existingAccount.user?.toString?.() || existingAccount.user,
            };
          } catch (err) {
            console.error(
              `Error updating account ${userInfo.MT5Account || "unknown"}:`,
              err.message,
            );
            return {
              success: false,
              error: err.message,
              mt5Account: userInfo.MT5Account,
              managerIndex,
            };
          }
        }),
      );

      return { managerIndex, results };
    } catch (apiError) {
      console.error(
        `API Error for manager ${managerIndex}:`,
        apiError.message,
      );
      throw apiError;
    }
  }

  /**
   * Extract account number from various possible response formats
   */
  extractAccountNumber(userInfo) {
    return (
      userInfo.MT5Account ||
      userInfo.Login ||
      userInfo.login ||
      userInfo.accountId
    );
  }

  /**
   * Extract balance from various possible response formats
   */
  extractBalance(userInfo) {
    const balance = userInfo.Balance || userInfo.balance || 0;
    return typeof balance === "number" ? balance : parseFloat(balance) || 0;
  }

  /**
   * Extract equity from various possible response formats
   */
  extractEquity(userInfo) {
    const equity = userInfo.Equity || userInfo.equity || 0;
    return typeof equity === "number" ? equity : parseFloat(equity) || 0;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stop the automated sync service gracefully
   */
  async stopAutoSync() {
    console.log("⏹️ Stopping account sync service...");
    this.isRunning = false;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.emit("stopped");
    console.log("✅ Account sync service stopped");
  }

  /**
   * Get current sync status with detailed metrics
   */
  getSyncStatus() {
    return {
      isRunning: this.isRunning,
      uptime: this.syncStats.lastSyncTime
        ? Math.floor((Date.now() - this.syncStats.lastSyncTime) / 1000)
        : 0,
      config: this.config,
      ...this.syncStats,
    };
  }

  /**
   * Trigger an immediate manual sync
   */
  async manualSync() {
    if (this.syncStats.status === "syncing") {
      throw new Error("Sync already in progress");
    }

    console.log("🔄 Manual sync triggered");
    return await this.runWithRetry(() => this.syncAllAccounts());
  }

  /**
   * Reset error counters
   */
  resetStats() {
    this.syncStats.errorCount = 0;
    this.syncStats.successCount = 0;
    console.log("📊 Sync statistics reset");
  }
}

// Export singleton instance with event emitter
const syncService = new AccountSyncService();

// Optional: Add graceful shutdown handling
if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, stopping sync service...");
    await syncService.stopAutoSync();
  });

  process.on("SIGINT", async () => {
    console.log("Received SIGINT, stopping sync service...");
    await syncService.stopAutoSync();
  });
}

module.exports = syncService;

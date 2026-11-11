// Keeps a per-user "open trades" mirror warm in cache by polling the
// external MT5 bridge in the background, on a fixed interval — the same
// self-pacing pattern as accountSyncService.js.
//
// Why this exists: tradingController.getUserTrades/getUserOpenTrades used to
// call the live external API synchronously on every request, which could
// take 5-10s depending on the bridge's responsiveness and how many accounts
// a user has. That's fine for a background job, but not for something a
// page blocks on. This service moves that live round trip out of the
// request path entirely — requests just read the warm cache this service
// maintains, so responses become near-instant once the first sync pass has
// run (a few seconds after boot).
const Account = require("../models/client/Account");
const EventEmitter = require("events");
const cacheService = require("../services/cacheService");
require("dotenv").config();

class OpenTradeSyncService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.syncStats = {
      lastSyncTime: null,
      lastSuccessfulSync: null,
      successCount: 0,
      errorCount: 0,
      totalAccounts: 0,
      totalUsers: 0,
      status: "idle",
    };

    this.io = null;

    this.config = {
      syncIntervalMs: parseInt(process.env.OPEN_TRADE_SYNC_INTERVAL_MS) || 5000,
      // Concurrency across the whole account set (not per-user) — keeps the
      // bridge from being hammered even as the account count grows.
      concurrency: parseInt(process.env.OPEN_TRADE_SYNC_CONCURRENCY) || 8,
      retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 5000,
    };

    // Lazily required to avoid a require cycle at module-load time
    // (tradingController doesn't require this service).
    this._trading = null;
  }

  get trading() {
    if (!this._trading) {
      this._trading = require("../controllers/client/tradingController");
    }
    return this._trading;
  }

  setSocketServer(io) {
    this.io = io;
  }

  async startAutoSync() {
    if (this.isRunning) {
      console.log("⚠️ Open-trade sync service is already running");
      return;
    }

    this.isRunning = true;
    console.log("🔄 Starting automated open-trade sync service...");
    this.emit("started");

    this.continuousSync();
  }

  async continuousSync() {
    while (this.isRunning) {
      const startTime = Date.now();

      try {
        await this.syncAllOpenTrades();
      } catch (error) {
        console.error("❌ Critical error in open-trade sync loop:", error);
        this.emit("error", error);
        await this.sleep(this.config.retryDelayMs);
        continue;
      }

      const timeTaken = Date.now() - startTime;
      const waitTime = Math.max(0, this.config.syncIntervalMs - timeTaken);
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }
  }

  async syncAllOpenTrades() {
    const {
      CACHE_KEYS,
      CACHE_TTL,
      runWithConcurrency,
      fetchExternalTradeData,
      formatTradeData,
      buildAccountInfo,
      buildProcessedAccount,
      getActiveUserIds,
    } = this.trading;

    this.syncStats.status = "syncing";
    this.syncStats.lastSyncTime = new Date();

    // Only poll accounts belonging to users who've actually requested
    // trading data in the last 60s — polling every account in the system
    // regardless of who's watching would hammer the external bridge with
    // mostly-pointless calls as the account table grows.
    const activeUserIds = getActiveUserIds();
    if (activeUserIds.length === 0) {
      this.syncStats.status = "idle";
      this.syncStats.totalAccounts = 0;
      this.syncStats.totalUsers = 0;
      return;
    }

    const accounts = await Account.find({
      status: true,
      user: { $in: activeUserIds },
    })
      .select("mt5Account managerIndex name accountType groupName leverage user")
      .lean();

    this.syncStats.totalAccounts = accounts.length;

    if (accounts.length === 0) {
      this.syncStats.status = "idle";
      return;
    }

    // Fetch open trades per account, bridge-wide concurrency limit.
    const perAccountResults = await runWithConcurrency(
      accounts,
      this.config.concurrency,
      async (account) => {
        const accountInfo = buildAccountInfo(account);
        const rawTrades = await fetchExternalTradeData(
          account.mt5Account,
          account.managerIndex || "3",
          "open",
        );
        return {
          userId: account.user?.toString?.() || account.user,
          account: buildProcessedAccount(account),
          trades: (Array.isArray(rawTrades) ? rawTrades : []).map((t) =>
            formatTradeData(t, "open", accountInfo),
          ),
        };
      },
    );

    // Group by user and write one cache entry per user.
    const byUser = new Map();
    for (const result of perAccountResults) {
      if (!result || !result.userId) continue;
      if (!byUser.has(result.userId)) {
        byUser.set(result.userId, { trades: [], accounts: [] });
      }
      const bucket = byUser.get(result.userId);
      bucket.accounts.push(result.account);
      bucket.trades.push(...result.trades);
    }

    const timestamp = Date.now();
    await Promise.all(
      Array.from(byUser.entries()).map(async ([userId, bucket]) => {
        bucket.trades.sort(
          (a, b) => new Date(b.openTime) - new Date(a.openTime),
        );
        await cacheService.set(
          CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId),
          { trades: bucket.trades, accounts: bucket.accounts, updatedAt: timestamp },
          CACHE_TTL.USER_OPEN_TRADES_LIVE,
        );

        // Push a lightweight "your trading data changed, refetch" signal to
        // whoever's actively watching — the actual refetch is now a fast
        // cache/DB read (see tradingController), so this gets open + closed
        // trades onto the client within one sync cycle instead of waiting
        // for the frontend's polling interval or a manual refresh.
        this.io?.emitCacheInvalidation?.(userId, ["tradingData"]);
      }),
    );

    this.syncStats.totalUsers = byUser.size;
    this.syncStats.successCount++;
    this.syncStats.lastSuccessfulSync = new Date();
    this.syncStats.status = "idle";
    this.emit("sync-complete", { accounts: accounts.length, users: byUser.size });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stopAutoSync() {
    console.log("⏹️ Stopping open-trade sync service...");
    this.isRunning = false;
    this.emit("stopped");
  }

  getSyncStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      ...this.syncStats,
    };
  }
}

const syncService = new OpenTradeSyncService();

if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", async () => {
    await syncService.stopAutoSync();
  });
  process.on("SIGINT", async () => {
    await syncService.stopAutoSync();
  });
}

module.exports = syncService;

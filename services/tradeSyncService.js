// Backend/services/tradeSyncService.js - Optimized Version
const axios = require("axios");
const IBClosedTrades = require("../models/IBClosedTrade");
const Account = require("../models/client/Account");
const IBCommission = require("../models/IBCommission");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBAdminConfiguration = require("../models/admin/IBAdminConfiguration");
const IBFlatCommissionConfiguration = require("../models/admin/IBFlatCommissionConfiguration");
const Group = require("../models/Group");
const User = require("../models/User");
const {
  invalidateCommissionCaches,
} = require("../controllers/commissionController");
const {
  invalidateIBConfigCaches,
} = require("../controllers/client/ibClientConfigurationController");
require("dotenv").config();
const { metaApi } = require("../API/metaApi");
const mongoose = require("mongoose");

class TradeSyncService {
  constructor() {
    this.isProcessing = false;
    this.isRunning = false;
    this.syncTimer = null;
    this.lastSyncTime = new Date();
    this.lastSuccessfulSync = null;
    this.workerId =
      process.env.TRADE_SYNC_WORKER_ID ||
      `${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
    this.managerIndexes = (process.env.MANAGER_INDEXES || "3")
      .split(",")
      .map((idx) => parseInt(idx.trim()));

    this.syncModes = {
      INITIAL_SETUP: parseInt(process.env.INITIAL_SYNC_DAYS) || 365,
      REGULAR_SYNC: parseInt(process.env.REGULAR_SYNC_DAYS) || 1,
      MANUAL_RANGE: null,
    };

    this.currentSyncMode = "INITIAL_SETUP";
    this.io = null;
    this.manualSyncWindow = null;

    // Performance configuration
    this.batchSize = parseInt(process.env.TRADE_BATCH_SIZE) || 500;
    this.maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
    this.syncInterval = parseInt(process.env.TRADE_SYNC_INTERVAL_MS) || 120000;
    this.claimTimeoutMs =
      parseInt(process.env.TRADE_CLAIM_TIMEOUT_MS, 10) || 300000;
    this.commissionConcurrency =
      parseInt(process.env.COMMISSION_CONCURRENCY, 10) || 50;
    this.commissionWriteBatchSize =
      parseInt(process.env.COMMISSION_WRITE_BATCH_SIZE, 10) || 5000;
    this.claimChunkSize =
      parseInt(process.env.TRADE_CLAIM_CHUNK_SIZE, 10) || 2000;

    // Statistics tracking
    this.stats = {
      totalTradesSynced: 0,
      totalCommissionsCreated: 0,
      totalErrors: 0,
      lastError: null,
      syncHistory: [],
    };
  }

  /**
   * Start automated trade sync service
   */
  async startAutoSync() {
    if (this.isRunning) {
      console.log("⚠️ Trade sync service is already running");
      return;
    }

    this.isRunning = true;
    console.log("🔄 Starting automated trade sync service...");
    console.log(`📅 Current sync mode: ${this.currentSyncMode}`);
    console.log(`🎯 Manager indexes: ${this.managerIndexes.join(", ")}`);
    console.log(`⏱️ Sync interval: ${this.syncInterval / 1000} seconds`);

    // Initial sync
    await this.syncWithRetry();

    // Set up recurring sync
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncWithRetry();
      } catch (error) {
        console.error("❌ Auto sync error:", error);
        this.stats.totalErrors++;
        this.stats.lastError = error.message;
      }
    }, this.syncInterval);
  }

  async stopAutoSync() {
    console.log("⏹️ Stopping trade sync service...");
    this.isRunning = false;

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    console.log("✅ Trade sync service stopped");
  }

  setSocketServer(io) {
    this.io = io;
  }

  /**
   * Sync trades with retry logic
   */
  async syncWithRetry(retryCount = 0) {
    try {
      await this.syncTrades();
      this.stats.lastError = null;
    } catch (error) {
      if (retryCount < this.maxRetries) {
        const delay = Math.pow(2, retryCount) * 5000;
        console.log(
          `🔄 Retry ${retryCount + 1}/${this.maxRetries} in ${delay}ms`,
        );
        await this.sleep(delay);
        return this.syncWithRetry(retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * Main sync function with improved error handling and performance
   */
  async syncTrades(options = {}) {
    if (this.isProcessing) {
      console.log("⏳ Sync already in progress, skipping...");
      return { success: false, reason: "Already processing" };
    }

    this.isProcessing = true;
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      console.log("🔄 Starting trade sync at:", new Date().toISOString());
      console.log(`📅 Sync mode: ${this.currentSyncMode}`);
      console.log(`🆔 Batch ID: ${batchId}`);
      const stageTimings = {};

      const endTime = options.endTime ? new Date(options.endTime) : new Date();
      const syncStartTime = options.startTime
        ? new Date(options.startTime)
        : await this.getSyncStartTime(endTime);

      // Get active accounts
      const accounts = await this.getActiveAccounts();

      if (accounts.length === 0) {
        console.log("⚠️ No active accounts found");
        return { success: false, reason: "No active accounts" };
      }

      console.log(`📊 Found ${accounts.length} active accounts`);

      const accountsByManager = this.groupAccountsByManager(accounts);
      const managerIndexes = Array.from(accountsByManager.keys());

      console.log(
        `🎯 Syncing managers from active accounts: ${managerIndexes.join(", ")}`,
      );

      // Fetch trades from all relevant managers in parallel
      const managerPromises = managerIndexes.map((managerIndex) =>
        this.fetchTradesFromAPIWithRetry(managerIndex, syncStartTime, endTime),
      );

      const managerResults = await Promise.allSettled(managerPromises);

      // Collect all valid trades
      let allNewTrades = [];
      managerResults.forEach((result, index) => {
        const managerIndex = managerIndexes[index];
        const validMT5Accounts =
          accountsByManager.get(managerIndex) || new Set();

        if (result.status === "fulfilled" && result.value) {
          const validTrades = result.value.filter((trade) =>
            validMT5Accounts.has(trade.MT5Account?.toString()),
          );
          allNewTrades = allNewTrades.concat(validTrades);
        } else if (result.status === "rejected") {
          console.error(
            `Manager fetch failed for ${managerIndex}:`,
            result.reason,
          );
        }
      });

      if (allNewTrades.length === 0) {
        console.log("✅ No new trades found from API");
      } else {
        console.log(`📈 Found ${allNewTrades.length} potential new trades`);
      }

      // Process and store trades in batches
      const storeTradesStartedAt = Date.now();
      const storedTrades =
        allNewTrades.length > 0
          ? await this.processAndStoreTradesBulk(allNewTrades)
          : [];
      stageTimings.storeTradesMs = Date.now() - storeTradesStartedAt;

      if (storedTrades.length > 0) {
        console.log(`💾 Stored ${storedTrades.length} new trades`);

        // Closed trades feed the client's /trading/all "tradingData" cache
        // (statistics, closed-trade list). Unlike openTradeSyncService, this
        // sync loop previously never told connected clients a new closed
        // trade had landed - they only found out on their next 15s poll
        // after this cycle happened to run, which combined with the
        // multi-minute sync interval made closed trades feel like they
        // "never" arrived. Push it the same way openTradeSyncService does
        // for open trades.
        await this.emitTradingDataRealtimeUpdates(storedTrades);
      }

      // Always retry pending commission work, not just trades inserted
      // in the current cycle. This prevents trades from being missed
      // permanently when IB config or admin commission config was not ready
      // during the first pass.
      const claimTradesStartedAt = Date.now();
      const pendingTrades = await this.claimPendingCommissionTrades();
      stageTimings.claimPendingTradesMs = Date.now() - claimTradesStartedAt;
      let commissionResults = { totalCommissions: 0 };

      if (pendingTrades.length > 0) {
        console.log(
          `🧮 Processing ${pendingTrades.length} trades pending commission calculation`,
        );
        const commissionCalculationStartedAt = Date.now();
        commissionResults = await this.calculateCommissionsBatch(
          pendingTrades,
          batchId,
        );
        stageTimings.calculateCommissionsMs =
          Date.now() - commissionCalculationStartedAt;
      } else {
        console.log("✅ No trades pending commission calculation");
        stageTimings.calculateCommissionsMs = 0;
      }

      // Update statistics
      this.stats.totalTradesSynced += storedTrades.length;
      this.stats.totalCommissionsCreated += commissionResults.totalCommissions;

      // Record sync history
      this.recordSyncHistory(
        storedTrades.length,
        commissionResults.totalCommissions,
        startTime,
      );

      // Suggest switching to regular sync if initial setup is complete
      if (
        this.currentSyncMode === "INITIAL_SETUP" &&
        storedTrades.length > 0 &&
        storedTrades.length < 100
      ) {
        console.log(
          "💡 Consider switching to regular sync mode with: tradeSyncService.switchToRegularSync()",
        );
      }

      this.lastSyncTime = new Date();
      this.lastSuccessfulSync = new Date();

      const duration = Date.now() - startTime;
      console.log(`✅ Trade sync completed successfully in ${duration}ms`);
      console.log("⏱️ Trade sync stage timings:", stageTimings);

      return {
        success: true,
        tradesStored: storedTrades.length,
        totalTrades: allNewTrades.length,
        commissionsCreated: commissionResults?.totalCommissions || 0,
        duration: `${duration}ms`,
        batchId,
        startTime: syncStartTime,
        endTime,
        stageTimings,
      };
    } catch (error) {
      console.error("❌ Trade sync error:", error);
      this.stats.totalErrors++;
      this.stats.lastError = error.message;
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Fetch trades from API with retry
   */
  async fetchTradesFromAPIWithRetry(
    managerIndex,
    startTime,
    endTime,
    retryCount = 0,
  ) {
    try {
      return await this.fetchTradesFromAPI(managerIndex, startTime, endTime);
    } catch (error) {
      if (retryCount < this.maxRetries) {
        console.log(
          `🔄 Retry fetching for manager ${managerIndex}, attempt ${retryCount + 1}`,
        );
        await this.sleep(2000 * Math.pow(2, retryCount));
        return this.fetchTradesFromAPIWithRetry(
          managerIndex,
          startTime,
          endTime,
          retryCount + 1,
        );
      }
      throw error;
    }
  }

  /**
   * Fetch trades from API with optimized date range
   */
  async fetchTradesFromAPI(managerIndex, startTime, endTime) {
    try {
      const startTimeStr = this.formatDateForAPI(startTime);
      const endTimeStr = this.formatDateForAPI(endTime);
      const daysToFetch = Math.max(
        1,
        Math.ceil((endTime.getTime() - startTime.getTime()) / 86400000),
      );

      const url = `/GetCloseTradeAllUsers`;
      const params = {
        Manager_Index: managerIndex,
        StartTime: startTimeStr,
        EndTime: endTimeStr,
      };

      console.log(`📡 Fetching trades for Manager ${managerIndex}...`);
      console.log(
        `📅 Time range: ${startTimeStr} to ${endTimeStr} (${daysToFetch} days - ${this.currentSyncMode} mode)`,
      );

      const response = await metaApi.get(url, {
        params,
        timeout: 60000, // 60 second timeout
      });

      if (response.data && Array.isArray(response.data)) {
        console.log(
          `📊 API returned ${response.data.length} trades for Manager ${managerIndex}`,
        );
        return response.data;
      }

      return [];
    } catch (error) {
      console.error(
        `❌ API fetch error for Manager ${managerIndex}:`,
        error.message,
      );
      throw error;
    }
  }

  /**
   * Get optimal start time for initial sync (fetch in chunks)
   */
  async getOptimalStartTime(endTime, daysToFetch) {
    // Check last successful sync to avoid re-fetching old data
    const lastTrade = await IBClosedTrades.findOne()
      .sort({ closeTime: -1 })
      .lean();

    if (lastTrade && lastTrade.closeTime) {
      // Start from last trade time minus 1 day buffer
      const bufferTime = new Date(
        lastTrade.closeTime.getTime() - 24 * 60 * 60 * 1000,
      );
      if (
        bufferTime >
        new Date(endTime.getTime() - daysToFetch * 24 * 60 * 60 * 1000)
      ) {
        console.log(
          `📅 Using optimized start time based on last trade: ${bufferTime}`,
        );
        return bufferTime;
      }
    }

    return new Date(endTime.getTime() - daysToFetch * 24 * 60 * 60 * 1000);
  }

  async getSyncStartTime(endTime) {
    switch (this.currentSyncMode) {
      case "INITIAL_SETUP":
        return this.getOptimalStartTime(endTime, this.syncModes.INITIAL_SETUP);
      case "REGULAR_SYNC":
        return new Date(
          endTime.getTime() - this.syncModes.REGULAR_SYNC * 24 * 60 * 60 * 1000,
        );
      case "MANUAL_RANGE":
        if (this.manualSyncWindow?.startTime) {
          return new Date(this.manualSyncWindow.startTime);
        }
        return new Date(
          endTime.getTime() - this.syncModes.MANUAL_RANGE * 24 * 60 * 60 * 1000,
        );
      default:
        return new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Get active accounts
   */
  async getActiveAccounts() {
    return Account.find({ status: true })
      .select("user mt5Account groupName managerIndex")
      .populate("user", "_id email")
      .lean();
  }

  groupAccountsByManager(accounts) {
    const accountsByManager = new Map();

    for (const account of accounts) {
      const managerIndex = parseInt(account.managerIndex, 10);
      const normalizedManagerIndex = Number.isNaN(managerIndex)
        ? this.managerIndexes[0]
        : managerIndex;

      if (!accountsByManager.has(normalizedManagerIndex)) {
        accountsByManager.set(normalizedManagerIndex, new Set());
      }

      if (account.mt5Account) {
        accountsByManager
          .get(normalizedManagerIndex)
          .add(account.mt5Account.toString());
      }
    }

    if (accountsByManager.size === 0) {
      for (const managerIndex of this.managerIndexes) {
        accountsByManager.set(managerIndex, new Set());
      }
    }

    return accountsByManager;
  }

  /**
   * Process and store trades in bulk for better performance
   */
  async processAndStoreTradesBulk(apiTrades) {
    const storedTrades = [];
    const uniqueTradesByPosition = new Map();

    for (const trade of apiTrades) {
      const positionId = this.getTradePositionId(trade);
      if (!positionId || uniqueTradesByPosition.has(positionId)) {
        continue;
      }

      uniqueTradesByPosition.set(positionId, trade);
    }

    const uniqueApiTrades = Array.from(uniqueTradesByPosition.values());
    const duplicateCount = apiTrades.length - uniqueApiTrades.length;

    if (duplicateCount > 0) {
      console.log(`Skipped ${duplicateCount} duplicate API trade rows`);
    }

    // Get existing trade IDs in bulk
    const positionIds = uniqueApiTrades.map((trade) =>
      this.getTradePositionId(trade),
    );
    const existingTrades = await IBClosedTrades.find({
      positionId: { $in: positionIds },
    })
      .select("positionId")
      .lean();

    const existingIds = new Set(existingTrades.map((t) => t.positionId));

    // Filter new trades
    const newTrades = uniqueApiTrades.filter(
      (trade) => !existingIds.has(this.getTradePositionId(trade)),
    );

    if (newTrades.length === 0) {
      return [];
    }

    console.log(`📝 Processing ${newTrades.length} new trades for storage`);

    // Prepare bulk insert operations
    const bulkOperations = [];
    const tradeDocuments = [];
    for (const apiTrade of newTrades) {
      const tradeData = this.transformTradeData(apiTrade);
      if (!tradeData) {
        continue;
      }
      tradeDocuments.push(tradeData);
      bulkOperations.push({
        insertOne: {
          document: tradeData,
        },
      });
    }

    // Execute bulk insert
    try {
      const result = await IBClosedTrades.bulkWrite(bulkOperations, {
        ordered: false, // Continue on errors
      });

      console.log(
        `💾 Bulk insert result: ${result.insertedCount} trades stored`,
      );
      return tradeDocuments;
    } catch (bulkError) {
      console.error("Bulk insert error:", bulkError.message);
      // Fall back to individual inserts
      for (const apiTrade of newTrades) {
        try {
          const tradeData = this.transformTradeData(apiTrade);
          if (!tradeData) {
            continue;
          }
          const savedTrade = await IBClosedTrades.create(tradeData);
          storedTrades.push(savedTrade);
        } catch (error) {
          if (error.code !== 11000) {
            // Ignore duplicate errors
            console.error("Error storing trade:", error);
          }
        }
      }
      return storedTrades;
    }
  }

  async claimPendingCommissionTrades() {
    const claimedTrades = [];

    while (true) {
      const claimToken = `claim_${this.workerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date();
      const claimExpiresAt = new Date(now.getTime() + this.claimTimeoutMs);
      const claimableFilter = {
        commissionProcessed: false,
        $or: [
          { processingClaimExpiresAt: { $exists: false } },
          { processingClaimExpiresAt: null },
          { processingClaimExpiresAt: { $lt: now } },
        ],
      };

      const candidates = await IBClosedTrades.find(claimableFilter)
        .sort({ closeTime: 1 })
        .limit(this.claimChunkSize)
        .select("_id")
        .lean();

      if (candidates.length === 0) {
        break;
      }

      const candidateIds = candidates.map((trade) => trade._id);
      await IBClosedTrades.updateMany(
        {
          _id: { $in: candidateIds },
          ...claimableFilter,
        },
        {
          $set: {
            processingWorkerId: this.workerId,
            processingClaimToken: claimToken,
            processingClaimedAt: now,
            processingClaimExpiresAt: claimExpiresAt,
          },
        },
      );

      const claimedChunk = await IBClosedTrades.find({
        processingClaimToken: claimToken,
        commissionProcessed: false,
      })
        .sort({ closeTime: 1 })
        .lean();

      if (claimedChunk.length === 0) {
        break;
      }

      claimedTrades.push(...claimedChunk);

      if (candidates.length < this.claimChunkSize) {
        break;
      }
    }

    return claimedTrades;
  }

  getTradePositionId(apiTrade) {
    return this.normalizeTradeIdentifier(
      apiTrade?.PositionId ?? apiTrade?.Ticket,
    );
  }

  /**
   * Transform API trade data to database format
   */
  transformTradeData(apiTrade) {
    const mt5Account = this.normalizeTradeIdentifier(apiTrade?.MT5Account);
    const positionId = this.getTradePositionId(apiTrade);
    const ticket = this.normalizeTradeIdentifier(
      apiTrade?.Ticket ?? apiTrade?.PositionId,
    );
    const openTime = this.parseAPIDate(apiTrade?.Open_Time);
    const closeTime = this.parseAPIDate(apiTrade?.Close_Time);

    if (!mt5Account || !positionId || !ticket || !apiTrade?.Symbol) {
      console.warn("Skipping trade with missing required identifiers", {
        mt5Account,
        positionId,
        ticket,
        symbol: apiTrade?.Symbol,
      });
      return null;
    }

    if (
      Number.isNaN(openTime.getTime()) ||
      Number.isNaN(closeTime.getTime())
    ) {
      console.warn("Skipping trade with invalid API dates", {
        mt5Account,
        positionId,
        openTime: apiTrade?.Open_Time,
        closeTime: apiTrade?.Close_Time,
      });
      return null;
    }

    const fallbackTimestamp = Math.floor(closeTime.getTime() / 1000);
    const fallbackOpenTimeSec = Math.floor(openTime.getTime() / 1000);

    return {
      mt5Account,
      positionId,
      ticket,
      symbol: apiTrade.Symbol,
      openTime,
      closeTime,
      openPrice: parseFloat(apiTrade.Open_Price) || 0,
      closePrice: parseFloat(apiTrade.Close_Price) || 0,
      profit: parseFloat(apiTrade.Profit) || 0,
      volume: parseFloat(apiTrade.Lot) || 0,
      commission: parseFloat(apiTrade.Commission || 0),
      swap: parseFloat(apiTrade.Swap || 0),
      comment: apiTrade.Comment || "",
      stopLoss: parseFloat(apiTrade.Stop_Loss || 0),
      targetPrice: parseFloat(apiTrade.Target_Price || 0),
      taxes: parseFloat(apiTrade.Taxes || 0),
      oBSFlag: parseInt(apiTrade.oBSFlag || 0),
      uPosStatus: parseInt(apiTrade.uPosStatus || 0),
      uTradeFlag: parseInt(apiTrade.uTradeFlag || 0),
      timestamp: parseInt(apiTrade.Timestamp, 10) || fallbackTimestamp,
      openTimeSec: parseInt(apiTrade.Open_Time_Sec, 10) || fallbackOpenTimeSec,
      commissionProcessed: false,
      createdAt: new Date(),
    };
  }

  /**
   * Calculate commissions in batch for better performance
   */
  async calculateCommissionsBatch(trades, batchId) {
    console.log(`💰 Calculating commissions for ${trades.length} trades...`);

    const balanceUpdates = new Map();
    const affectedUserIds = new Set();
    const stageTimings = {};
    const preloadStartedAt = Date.now();
    const commissionContext = await this.preloadCommissionContext(trades);
    stageTimings.preloadContextMs = Date.now() - preloadStartedAt;

    const buildOperationsStartedAt = Date.now();
    const results = await this.runWithConcurrency(
      trades,
      this.commissionConcurrency,
      async (trade, index) => {
        const result = await this.processTradeCommissionsBatch(
          trade,
          batchId,
          commissionContext,
        );

        if ((index + 1) % this.batchSize === 0 || index === trades.length - 1) {
          console.log(`📊 Processed ${index + 1}/${trades.length} trades`);
        }

        return result;
      },
    );
    stageTimings.buildOperationsMs = Date.now() - buildOperationsStartedAt;

    const commissionOperations = [];
    const processedTradeIds = [];
    const releasedTradeIds = [];
    const tradesNeedingRetry = new Set();

    for (const result of results) {
      if (!result) {
        continue;
      }

      if (
        result.tradeAction === "processed" &&
        (!result.commissionOperations || result.commissionOperations.length === 0)
      ) {
        processedTradeIds.push(result.tradeId);
      } else if (result.tradeAction === "released") {
        releasedTradeIds.push(result.tradeId);
      }

      if (result.retryRequired) {
        tradesNeedingRetry.add(result.tradeId.toString());
      }

      for (const commissionOperation of result.commissionOperations || []) {
        commissionOperations.push(commissionOperation);
        affectedUserIds.add(commissionOperation.ibUserId.toString());
      }
    }

    const bulkWriteStartedAt = Date.now();
    const commissionWriteResult = await this.persistCommissionOperationsBatch(
      commissionOperations,
      balanceUpdates,
      tradesNeedingRetry,
    );
    stageTimings.bulkCommissionWriteMs = Date.now() - bulkWriteStartedAt;
    const totalCommissions = commissionWriteResult.totalCreated;

    // Update IB balances in batch
    const balanceUpdateStartedAt = Date.now();
    await this.updateIBBalancesBatch(balanceUpdates);
    stageTimings.updateBalancesMs = Date.now() - balanceUpdateStartedAt;

    const finalizeTradesStartedAt = Date.now();
    await this.markTradesProcessedBatch([
      ...processedTradeIds,
      ...commissionWriteResult.processedTradeIds,
    ]);
    await this.releaseTradeClaimsBatch([
      ...releasedTradeIds,
      ...commissionWriteResult.releasedTradeIds,
    ]);
    stageTimings.finalizeTradesMs = Date.now() - finalizeTradesStartedAt;

    // Confirm commissions
    const confirmStartedAt = Date.now();
    const confirmed = await this.confirmCommissionsBatch(batchId);
    stageTimings.confirmCommissionsMs = Date.now() - confirmStartedAt;

    const realtimeStartedAt = Date.now();
    await this.emitCommissionRealtimeUpdates(affectedUserIds);
    stageTimings.emitRealtimeUpdatesMs = Date.now() - realtimeStartedAt;

    console.log(
      `✅ Commission calculation complete: ${totalCommissions} commissions created, ${confirmed} confirmed`,
    );
    console.log("⏱️ Commission stage timings:", {
      ...stageTimings,
      commissionOperations: commissionOperations.length,
      processedTrades:
        processedTradeIds.length + commissionWriteResult.processedTradeIds.length,
      releasedTrades:
        releasedTradeIds.length + commissionWriteResult.releasedTradeIds.length,
    });

    return { totalCommissions, confirmed, stageTimings };
  }

  /**
   * Process trade commissions in batch
   */
  async processTradeCommissionsBatch(
    trade,
    batchId,
    commissionContext,
  ) {
    try {
      const account = commissionContext.accountMap.get(trade.mt5Account);

      if (!account || !account.user) {
        console.log(`⚠️ No account found for MT5: ${trade.mt5Account}`);
        return {
          tradeId: trade._id,
          tradeAction: "released",
          commissionOperations: [],
        };
      }

      const minHoldSeconds =
        commissionContext.minHoldSecondsByGroupName.get(account.groupName) || 0;

      if (minHoldSeconds > 0 && trade.openTime && trade.closeTime) {
        const heldSeconds =
          (new Date(trade.closeTime).getTime() - new Date(trade.openTime).getTime()) /
          1000;

        if (heldSeconds < minHoldSeconds) {
          console.log(
            `⏱️ Trade ${trade.positionId} held ${heldSeconds.toFixed(0)}s, below the ${minHoldSeconds}s minimum for group ${account.groupName} — no commission`,
          );
          // Trade is already closed, so this outcome can never change — mark
          // it processed (not released/retried) so it isn't reconsidered.
          return {
            tradeId: trade._id,
            tradeAction: "processed",
            commissionOperations: [],
          };
        }
      }

      const clientIBConfig = commissionContext.clientConfigByUserId.get(
        account.user._id.toString(),
      );

      if (!clientIBConfig) {
        console.log(`⚠️ No IB config for user: ${account.user.email}`);
        return {
          tradeId: trade._id,
          tradeAction: "released",
          commissionOperations: [],
        };
      }

      const hierarchy =
        commissionContext.hierarchyMap.get(account.user._id.toString()) || [];

      if (hierarchy.length === 0) {
        console.log(`⚠️ No hierarchy for user: ${account.user.email}`);
        return {
          tradeId: trade._id,
          tradeAction: "processed",
          commissionOperations: [],
        };
      }

      const groupId = commissionContext.groupIdByName.get(account.groupName);
      const commissionMode = groupId
        ? commissionContext.commissionModeByGroupId.get(groupId) || "waterfall"
        : "waterfall";

      // Create commissions for each level in the hierarchy.
      // Level 1 = nearest referrer to the client, increasing toward the root.
      //
      // 'waterfall' mode: each IB earns (own maximumCommission - nearer
      // child's maximumCommission); the nearest referrer (level 1) keeps
      // their full maximumCommission.
      // 'flat' mode: each IB at that depth simply earns the group's
      // configured bonusPerLot for that level — no ceilings, no delegation.
      const commissionOperations = [];
      let retryRequired = false;

      for (let i = 0; i < hierarchy.length; i++) {
        const level = i + 1;
        let commissionResult;

        if (commissionMode === "flat") {
          const levelConfig = commissionContext.flatConfigByGroupId
            .get(groupId)
            ?.get(level);

          commissionResult = await this.createFlatCommissionRecordBatch(
            trade,
            account,
            hierarchy[i],
            level,
            levelConfig,
            batchId,
          );
        } else {
          commissionResult = await this.createCommissionRecordBatch(
            trade,
            account,
            hierarchy,
            i,
            batchId,
          );
        }

        if (commissionResult?.status === "ready") {
          commissionOperations.push(commissionResult.commissionOperation);
        } else if (commissionResult?.status === "retry") {
          retryRequired = true;
        }
      }

      if (commissionOperations.length > 0) {
        if (retryRequired) {
          // Partial resolution: some ancestors are payable now, but at least
          // one level is still blocked (e.g. an unassigned Sub-IB further
          // down). Pay what's resolved, but do NOT mark the trade processed —
          // otherwise the blocked levels' share is permanently stranded and
          // can never be paid once that Sub-IB is assigned.
          console.log(
            `⏳ Trade ${trade.positionId} partially resolved (${commissionOperations.length} level(s) paid); ` +
              `deferring for retry to pick up the remaining blocked level(s)`,
          );
        }
        return {
          tradeId: trade._id,
          tradeAction: "processed",
          commissionOperations,
          retryRequired,
        };
      }

      if (retryRequired) {
        console.log(
          `⏳ Deferring trade ${trade.positionId} for retry after commission prerequisites are available`,
        );
        return {
          tradeId: trade._id,
          tradeAction: "released",
          commissionOperations: [],
        };
      }

      return {
        tradeId: trade._id,
        tradeAction: "processed",
        commissionOperations: [],
      };
    } catch (error) {
      console.error(`Error processing trade ${trade._id}:`, error);
      return {
        tradeId: trade._id,
        tradeAction: "released",
        commissionOperations: [],
      };
    }
  }

  /**
   * Preload all commission prerequisites in bulk
   */
  async preloadCommissionContext(trades) {
    const mt5Accounts = [
      ...new Set(trades.map((trade) => trade.mt5Account).filter(Boolean)),
    ];

    const accounts = await Account.find({
      status: true,
      mt5Account: { $in: mt5Accounts },
    })
      .select("user mt5Account groupName managerIndex")
      .lean();

    const accountMap = new Map(
      accounts.map((account) => [account.mt5Account?.toString(), account]),
    );

    const clientUserIds = [
      ...new Set(
        accounts
          .map((account) => account.user?._id?.toString())
          .filter(Boolean),
      ),
    ];

    const initialConfigs = await IBClientConfiguration.find({
      userId: { $in: clientUserIds },
    })
      .populate("userId", "_id email")
      .lean();

    const ibConfigMap = new Map();
    const clientConfigByUserId = new Map();
    const pendingParentIds = new Set();

    for (const config of initialConfigs) {
      if (!config.userId?._id) {
        console.warn(
          `⚠️ Skipping IB config ${config._id} with orphaned/missing userId reference`,
        );
        continue;
      }

      const configId = config._id.toString();
      ibConfigMap.set(configId, config);
      clientConfigByUserId.set(config.userId._id.toString(), config);

      if (config.parent) {
        pendingParentIds.add(config.parent.toString());
      }
    }

    while (pendingParentIds.size > 0) {
      const missingParentIds = Array.from(pendingParentIds).filter(
        (configId) => !ibConfigMap.has(configId),
      );
      pendingParentIds.clear();

      if (missingParentIds.length === 0) {
        break;
      }

      const parentConfigs = await IBClientConfiguration.find({
        _id: { $in: missingParentIds },
      })
        .populate("userId", "_id email")
        .lean();

      for (const config of parentConfigs) {
        const configId = config._id.toString();
        ibConfigMap.set(configId, config);

        if (config.parent && !ibConfigMap.has(config.parent.toString())) {
          pendingParentIds.add(config.parent.toString());
        }
      }
    }

    const hierarchyMap = new Map();
    for (const [userId, config] of clientConfigByUserId) {
      const hierarchy = this.getHierarchyChainFromMap(config, ibConfigMap);
      hierarchyMap.set(userId, hierarchy);
    }

    // Minimum holding time (per Group) a trade must stay open before it's
    // eligible for commission at all — configured via defaultTimeInSeconds
    // on IBAdminConfiguration but never actually enforced until now.
    const groupNames = [
      ...new Set(accounts.map((account) => account.groupName).filter(Boolean)),
    ];
    const groups = groupNames.length
      ? await Group.find({
          $or: [{ value: { $in: groupNames } }, { name: { $in: groupNames } }],
        })
          .select("_id name value")
          .lean()
      : [];

    const groupIdByName = new Map();
    for (const group of groups) {
      if (group.value) groupIdByName.set(group.value, group._id.toString());
      if (group.name) groupIdByName.set(group.name, group._id.toString());
    }

    const uniqueGroupIds = [...new Set(groupIdByName.values())].map(
      (groupId) => new mongoose.Types.ObjectId(groupId),
    );

    // Each group runs one of two commission calculation models
    // ('waterfall' ceiling-based, or 'flat' per-level bonusPerLot) — load the
    // mode plus both models' configs so per-trade processing can branch.
    const [groupDocs, adminConfigs, flatConfigs] = await Promise.all([
      uniqueGroupIds.length
        ? Group.find({ _id: { $in: uniqueGroupIds } })
            .select("_id commissionMode")
            .lean()
        : [],
      uniqueGroupIds.length
        ? IBAdminConfiguration.find({ groupId: { $in: uniqueGroupIds } })
            .select("groupId defaultTimeInSeconds")
            .lean()
        : [],
      uniqueGroupIds.length
        ? IBFlatCommissionConfiguration.find({ groupId: { $in: uniqueGroupIds } })
            .select("groupId level bonusPerLot defaultTimeInSeconds")
            .lean()
        : [],
    ]);

    const commissionModeByGroupId = new Map(
      groupDocs.map((group) => [
        group._id.toString(),
        group.commissionMode || "waterfall",
      ]),
    );

    const minHoldSecondsByGroupId = new Map(
      adminConfigs.map((config) => [
        config.groupId.toString(),
        config.defaultTimeInSeconds || 0,
      ]),
    );

    // groupId -> Map(level -> { bonusPerLot, defaultTimeInSeconds })
    const flatConfigByGroupId = new Map();
    for (const config of flatConfigs) {
      const groupId = config.groupId.toString();
      if (!flatConfigByGroupId.has(groupId)) {
        flatConfigByGroupId.set(groupId, new Map());
      }
      flatConfigByGroupId.get(groupId).set(config.level, config);
    }

    const minHoldSecondsByGroupName = new Map();
    for (const [name, groupId] of groupIdByName) {
      const mode = commissionModeByGroupId.get(groupId) || "waterfall";
      if (mode === "flat") {
        // All levels share the same default hold time (set together via
        // updateGroupDefaultTime) — read it from the lowest configured
        // level deterministically, since Map iteration order otherwise
        // depends on DB query order rather than level number.
        const levels = flatConfigByGroupId.get(groupId);
        const lowestLevelConfig = levels
          ? [...levels.values()].sort((a, b) => a.level - b.level)[0]
          : null;
        minHoldSecondsByGroupName.set(name, lowestLevelConfig?.defaultTimeInSeconds || 0);
      } else {
        minHoldSecondsByGroupName.set(name, minHoldSecondsByGroupId.get(groupId) || 0);
      }
    }

    return {
      accountMap,
      clientConfigByUserId,
      ibConfigMap,
      hierarchyMap,
      minHoldSecondsByGroupName,
      groupIdByName,
      commissionModeByGroupId,
      flatConfigByGroupId,
    };
  }

  /**
   * Get hierarchy chain from preloaded configuration map
   */
  getHierarchyChainFromMap(clientIBConfig, ibConfigMap) {
    const hierarchy = [];
    let currentConfig = clientIBConfig;
    const visited = new Set(); // Prevent circular references

    while (
      currentConfig &&
      currentConfig.parent &&
      !visited.has(currentConfig._id.toString())
    ) {
      visited.add(currentConfig._id.toString());

      const parentConfig = ibConfigMap.get(currentConfig.parent.toString());

      if (parentConfig) {
        hierarchy.push(parentConfig);
        currentConfig = parentConfig;
      } else {
        break;
      }
    }

    return hierarchy;
  }

  /**
   * Create commission record in batch.
   *
   * hierarchy[0] is the nearest referrer to the trading client (level 1);
   * hierarchy[hierarchy.length - 1] is the root IB. Each ancestor earns
   * (own maximumCommission - nearer child's maximumCommission); the nearest
   * referrer's "child" boundary is 0 since the client itself isn't an IB.
   */
  async createCommissionRecordBatch(trade, account, hierarchy, index, batchId) {
    try {
      const ibConfig = hierarchy[index];
      const level = index + 1;

      if (ibConfig.maximumCommission === null || ibConfig.maximumCommission === undefined) {
        return { status: "retry" };
      }

      const childConfig = index === 0 ? null : hierarchy[index - 1];
      if (
        childConfig &&
        (childConfig.maximumCommission === null ||
          childConfig.maximumCommission === undefined)
      ) {
        return { status: "retry" };
      }

      const childMax = childConfig ? childConfig.maximumCommission : 0;
      let bonusPerLot = ibConfig.maximumCommission - childMax;

      if (bonusPerLot < 0) {
        console.warn(
          `⚠️ Negative commission rate for IB ${ibConfig.userId._id} at level ${level} ` +
            `(own=${ibConfig.maximumCommission}, child=${childMax}). Clamping to 0.`,
        );
        bonusPerLot = 0;
      }

      const commissionAmount = bonusPerLot * trade.volume;

      const commissionData = {
        tradeId: trade._id,
        clientId: account.user._id,
        clientMT5Account: trade.mt5Account,
        ibUserId: ibConfig.userId._id,
        ibConfigurationId: ibConfig._id,
        commissionMode: "waterfall",
        level: level,
        bonusPerLot: bonusPerLot,
        volume: trade.volume,
        commissionAmount: commissionAmount,
        symbol: trade.symbol,
        profit: trade.profit,
        openTime: trade.openTime,
        closeTime: trade.closeTime,
        openPrice: trade.openPrice,
        closePrice: trade.closePrice,
        baseAmount: Math.abs(trade.profit),
        groupName: account.groupName,
        status: "pending",
        batchId: batchId,
        createdAt: new Date(),
      };

      return {
        status: "ready",
        commissionOperation: {
          operation: {
            updateOne: {
              filter: {
                tradeId: trade._id,
                ibUserId: ibConfig.userId._id,
                level: level,
              },
              update: {
                $setOnInsert: commissionData,
              },
              upsert: true,
            },
          },
          tradeId: trade._id.toString(),
          ibConfigId: ibConfig._id.toString(),
          ibUserId: ibConfig.userId._id,
          commissionAmount,
        },
      };
    } catch (error) {
      console.error("Error preparing commission write:", error);
      return { status: "retry" };
    }
  }

  /**
   * Create a "flat" mode commission record: bonusPerLot is a fixed rate
   * configured per (group, level) — no ceiling, no delegation. A level
   * with no configured rate is simply skipped (not deferred for retry,
   * since flat mode has no "pending assignment" concept).
   */
  async createFlatCommissionRecordBatch(
    trade,
    account,
    ibConfig,
    level,
    levelConfig,
    batchId,
  ) {
    try {
      if (!levelConfig || !levelConfig.bonusPerLot || levelConfig.bonusPerLot <= 0) {
        return { status: "skipped" };
      }

      const bonusPerLot = levelConfig.bonusPerLot;
      const commissionAmount = bonusPerLot * trade.volume;

      const commissionData = {
        tradeId: trade._id,
        clientId: account.user._id,
        clientMT5Account: trade.mt5Account,
        ibUserId: ibConfig.userId._id,
        ibConfigurationId: ibConfig._id,
        commissionMode: "flat",
        level: level,
        bonusPerLot: bonusPerLot,
        volume: trade.volume,
        commissionAmount: commissionAmount,
        symbol: trade.symbol,
        profit: trade.profit,
        openTime: trade.openTime,
        closeTime: trade.closeTime,
        openPrice: trade.openPrice,
        closePrice: trade.closePrice,
        baseAmount: Math.abs(trade.profit),
        groupName: account.groupName,
        status: "pending",
        batchId: batchId,
        createdAt: new Date(),
      };

      return {
        status: "ready",
        commissionOperation: {
          operation: {
            updateOne: {
              filter: {
                tradeId: trade._id,
                ibUserId: ibConfig.userId._id,
                level: level,
              },
              update: {
                $setOnInsert: commissionData,
              },
              upsert: true,
            },
          },
          tradeId: trade._id.toString(),
          ibConfigId: ibConfig._id.toString(),
          ibUserId: ibConfig.userId._id,
          commissionAmount,
        },
      };
    } catch (error) {
      console.error("Error preparing flat commission write:", error);
      return { status: "skipped" };
    }
  }

  async persistCommissionOperationsBatch(
    commissionOperations,
    balanceUpdates,
    tradesNeedingRetry = new Set(),
  ) {
    if (commissionOperations.length === 0) {
      return {
        totalCreated: 0,
        processedTradeIds: [],
        releasedTradeIds: [],
      };
    }

    let totalCreated = 0;
    const tradeStatus = new Map();

    for (const entry of commissionOperations) {
      const tradeId = entry.tradeId;
      if (!tradeStatus.has(tradeId)) {
        // A trade with other still-blocked levels (e.g. an unassigned
        // Sub-IB further down the chain) must not be finalized as processed
        // even though these particular levels wrote successfully — otherwise
        // the blocked levels' share can never be paid once resolved.
        tradeStatus.set(tradeId, { failed: tradesNeedingRetry.has(tradeId) });
      }
    }

    for (
      let startIndex = 0;
      startIndex < commissionOperations.length;
      startIndex += this.commissionWriteBatchSize
    ) {
      const chunk = commissionOperations.slice(
        startIndex,
        startIndex + this.commissionWriteBatchSize,
      );

      let bulkResult;
      let writeErrors = [];

      try {
        bulkResult = await IBCommission.bulkWrite(
          chunk.map((entry) => entry.operation),
          { ordered: false },
        );
      } catch (error) {
        bulkResult = error?.result || error?.writeResult || error;
        writeErrors = this.extractBulkWriteErrors(error);
        const nonDuplicateErrors = writeErrors.filter(
          (writeError) => writeError?.code !== 11000,
        );

        if (nonDuplicateErrors.length > 0) {
          console.error(
            "Non-duplicate errors occurred during bulk commission writes:",
            nonDuplicateErrors.map((writeError) => writeError.errmsg || writeError.message || writeError),
          );
        }
      }

      const upsertedIndexes = this.extractBulkUpsertIndexes(bulkResult);
      totalCreated += upsertedIndexes.length;
      const failedIndexes = new Set(
        writeErrors
          .filter((writeError) => writeError?.code !== 11000)
          .map((writeError) => writeError.index)
          .filter(Number.isInteger),
      );

      for (const index of upsertedIndexes) {
        const entry = chunk[index];
        if (!entry) {
          continue;
        }

        balanceUpdates.set(
          entry.ibConfigId,
          (balanceUpdates.get(entry.ibConfigId) || 0) + entry.commissionAmount,
        );
      }

      for (const failedIndex of failedIndexes) {
        const failedEntry = chunk[failedIndex];
        if (!failedEntry) {
          continue;
        }

        const status = tradeStatus.get(failedEntry.tradeId);
        if (status) {
          status.failed = true;
        }
      }
    }

    const processedTradeIds = [];
    const releasedTradeIds = [];

    for (const [tradeId, status] of tradeStatus.entries()) {
      if (status.failed) {
        releasedTradeIds.push(tradeId);
      } else {
        processedTradeIds.push(tradeId);
      }
    }

    return {
      totalCreated,
      processedTradeIds,
      releasedTradeIds,
    };
  }

  /**
   * Update IB balances in batch
   */
  async updateIBBalancesBatch(balanceUpdates) {
    if (balanceUpdates.size === 0) return;

    console.log(`💳 Updating balances for ${balanceUpdates.size} IB configs`);

    const bulkOperations = [];
    for (const [ibConfigId, amount] of balanceUpdates) {
      bulkOperations.push({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(ibConfigId) },
          update: { $inc: { IBbalance: amount } },
        },
      });
    }

    try {
      const result = await IBClientConfiguration.bulkWrite(bulkOperations);
      console.log(`✅ Updated ${result.modifiedCount} IB balances`);
    } catch (error) {
      console.error("Error updating IB balances in batch:", error);
      // Fall back to individual updates
      for (const [ibConfigId, amount] of balanceUpdates) {
        try {
          await IBClientConfiguration.findByIdAndUpdate(ibConfigId, {
            $inc: { IBbalance: amount },
          });
        } catch (err) {
          console.error(`Failed to update balance for ${ibConfigId}:`, err);
        }
      }
    }
  }

  /**
   * Confirm commissions in batch
   */
  async confirmCommissionsBatch(batchId) {
    try {
      const result = await IBCommission.updateMany(
        { batchId: batchId, status: "pending" },
        {
          $set: {
            status: "confirmed",
            confirmedAt: new Date(),
          },
        },
      );
      console.log(
        `✅ Confirmed ${result.modifiedCount} commissions for batch ${batchId}`,
      );
      return result.modifiedCount;
    } catch (error) {
      console.error(`Error confirming commissions:`, error);
      return 0;
    }
  }

  /**
   * Push a live "your closed trades changed, refetch" signal to whichever
   * users own the accounts a newly-stored batch of trades belongs to.
   * Mirrors openTradeSyncService's emitCacheInvalidation(userId,
   * ["tradingData"]) so the same React Query key gets refreshed instantly
   * for a close event, not just an open one.
   */
  async emitTradingDataRealtimeUpdates(storedTrades) {
    if (!this.io || !storedTrades || storedTrades.length === 0) {
      return;
    }

    const mt5Accounts = [
      ...new Set(
        storedTrades.map((trade) => trade.mt5Account).filter(Boolean),
      ),
    ];

    if (mt5Accounts.length === 0) {
      return;
    }

    const accounts = await Account.find({ mt5Account: { $in: mt5Accounts } })
      .select("user")
      .lean();

    const affectedUserIds = new Set(
      accounts.map((account) => account.user?.toString()).filter(Boolean),
    );

    for (const userId of affectedUserIds) {
      this.io.emitCacheInvalidation(userId, ["tradingData"]);
    }
  }

  async emitCommissionRealtimeUpdates(userIds) {
    if (!userIds || userIds.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        await Promise.all([
          invalidateCommissionCaches(userId),
          invalidateIBConfigCaches(userId),
        ]);

        if (!this.io) {
          return;
        }

        this.io.to(`user_${userId}`).emit("commission_updated", {
          userId,
          timestamp: new Date().toISOString(),
        });
        this.io.emitCacheInvalidation(userId, [
          "commission",
          "partners",
          "partner",
          "dashboard",
          "ibConfig",
        ]);
      }),
    );

    if (this.io) {
      this.io.broadcastToAdmins("commission_updated", {
        userIds: Array.from(userIds),
      });
    }
  }

  /**
   * Mark trade as processed
   */
  async markTradeProcessed(tradeId) {
    await IBClosedTrades.updateOne(
      { _id: tradeId },
      {
        $set: {
          commissionProcessed: true,
          processedAt: new Date(),
        },
        $unset: {
          processingWorkerId: "",
          processingClaimToken: "",
          processingClaimedAt: "",
          processingClaimExpiresAt: "",
        },
      },
    );
  }

  async releaseTradeClaim(tradeId) {
    await IBClosedTrades.updateOne(
      { _id: tradeId, commissionProcessed: false },
      {
        $unset: {
          processingWorkerId: "",
          processingClaimToken: "",
          processingClaimedAt: "",
          processingClaimExpiresAt: "",
        },
      },
    );
  }

  async markTradesProcessedBatch(tradeIds) {
    if (!tradeIds || tradeIds.length === 0) {
      return;
    }

    await IBClosedTrades.updateMany(
      { _id: { $in: tradeIds } },
      {
        $set: {
          commissionProcessed: true,
          processedAt: new Date(),
        },
        $unset: {
          processingWorkerId: "",
          processingClaimToken: "",
          processingClaimedAt: "",
          processingClaimExpiresAt: "",
        },
      },
    );
  }

  async releaseTradeClaimsBatch(tradeIds) {
    if (!tradeIds || tradeIds.length === 0) {
      return;
    }

    await IBClosedTrades.updateMany(
      {
        _id: { $in: tradeIds },
        commissionProcessed: false,
      },
      {
        $unset: {
          processingWorkerId: "",
          processingClaimToken: "",
          processingClaimedAt: "",
          processingClaimExpiresAt: "",
        },
      },
    );
  }

  /**
   * Record sync history
   */
  recordSyncHistory(tradesCount, commissionsCount, startTime) {
    const duration = Date.now() - startTime;
    this.stats.syncHistory.unshift({
      timestamp: new Date(),
      tradesCount,
      commissionsCount,
      duration,
      mode: this.currentSyncMode,
    });

    // Keep only last 100 records
    if (this.stats.syncHistory.length > 100) {
      this.stats.syncHistory.pop();
    }
  }

  /**
   * Format date for API
   */
  formatDateForAPI(date) {
    return date
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
  }

  /**
   * Parse API date format
   */
  parseAPIDate(dateString) {
    try {
      if (dateString instanceof Date) {
        return dateString;
      }

      if (typeof dateString !== "string" || !dateString.trim()) {
        return new Date(Number.NaN);
      }

      if (dateString.includes("T")) {
        return new Date(dateString);
      }

      const [datePart, timePart] = dateString.split(" ");
      if (!datePart || !timePart) {
        return new Date(dateString);
      }

      const [year, month, day] = datePart.split(".");
      if (!year || !month || !day) {
        return new Date(dateString);
      }

      const formattedDate = `${year}-${month}-${day} ${timePart}`;
      return new Date(formattedDate);
    } catch (error) {
      console.error(`Error parsing date: ${dateString}`);
      return new Date(Number.NaN);
    }
  }

  normalizeTradeIdentifier(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const normalizedValue = value.toString().trim();
    return normalizedValue || null;
  }

  /**
   * Set sync mode
   */
  setSyncMode(mode, customDays = null) {
    this.currentSyncMode = mode;
    if (mode === "MANUAL_RANGE" && customDays) {
      this.syncModes.MANUAL_RANGE = customDays;
    }
    console.log(`🔧 Sync mode changed to: ${mode}`);
  }

  /**
   * Switch to regular sync
   */
  switchToRegularSync() {
    this.currentSyncMode = "REGULAR_SYNC";
    console.log("🔄 Switched to regular sync mode");
  }

  /**
   * Process custom date range
   */
  async processDateRange(startDate, endDate) {
    console.log(`🔄 Manual processing: ${startDate} to ${endDate}`);

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error("Invalid date format");
    }

    if (start > end) {
      throw new Error("Start time must be before end time");
    }

    const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    if (daysDiff > 365) {
      throw new Error("Date range cannot exceed 365 days");
    }

    const previousMode = this.currentSyncMode;
    const previousManualRangeDays = this.syncModes.MANUAL_RANGE;
    const previousManualWindow = this.manualSyncWindow;

    this.setSyncMode("MANUAL_RANGE", Math.max(1, daysDiff));
    this.manualSyncWindow = {
      startTime: start,
      endTime: end,
    };

    try {
      return await this.syncTrades({
        startTime: start,
        endTime: end,
      });
    } finally {
      this.currentSyncMode = previousMode;
      this.syncModes.MANUAL_RANGE = previousManualRangeDays;
      this.manualSyncWindow = previousManualWindow;
    }
  }

  /**
   * Get sync status with detailed info
   */
  getSyncStatus() {
    return {
      isProcessing: this.isProcessing,
      lastSyncTime: this.lastSyncTime,
      lastSuccessfulSync: this.lastSuccessfulSync,
      syncMode: this.currentSyncMode,
      daysRange: this.syncModes[this.currentSyncMode],
      managerIndexes: this.managerIndexes,
      stats: {
        totalTradesSynced: this.stats.totalTradesSynced,
        totalCommissionsCreated: this.stats.totalCommissionsCreated,
        totalErrors: this.stats.totalErrors,
        lastError: this.stats.lastError,
        recentSyncs: this.stats.syncHistory.slice(0, 5),
      },
      cacheStatus: {
        enabled: false,
        mode: "realtime",
      },
    };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  extractBulkWriteErrors(error) {
    if (!error) {
      return [];
    }

    if (Array.isArray(error.writeErrors)) {
      return error.writeErrors;
    }

    if (typeof error.getWriteErrors === "function") {
      return error.getWriteErrors();
    }

    if (Array.isArray(error.result?.writeErrors)) {
      return error.result.writeErrors;
    }

    if (Array.isArray(error.writeResult?.writeErrors)) {
      return error.writeResult.writeErrors;
    }

    return [];
  }

  extractBulkUpsertIndexes(result) {
    if (!result) {
      return [];
    }

    if (result.upsertedIds && !Array.isArray(result.upsertedIds)) {
      return Object.keys(result.upsertedIds)
        .map((index) => Number.parseInt(index, 10))
        .filter(Number.isInteger);
    }

    if (Array.isArray(result.upserted)) {
      return result.upserted
        .map((entry) => entry.index)
        .filter(Number.isInteger);
    }

    if (Array.isArray(result.result?.upserted)) {
      return result.result.upserted
        .map((entry) => entry.index)
        .filter(Number.isInteger);
    }

    if (Array.isArray(result.getRawResponse?.().upserted)) {
      return result.getRawResponse()
        .upserted.map((entry) => entry.index)
        .filter(Number.isInteger);
    }

    return [];
  }

  async runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let currentIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));

    const runners = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = currentIndex++;
        if (index >= items.length) {
          return;
        }

        results[index] = await worker(items[index], index);
      }
    });

    await Promise.all(runners);
    return results;
  }
}

module.exports = new TradeSyncService();

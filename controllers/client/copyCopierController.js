// Backend/controllers/client/copyCopierController.js - FULLY OPTIMIZED
const Account = require("../../models/client/Account");
const axios = require("axios");
const config = require("../../config/config");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const { invalidateAccountCaches } = require("./accountController");
const { AppError } = require("../../middlewares/errorHandler");

const COPY_API_URL = process.env.COPY_API_URL || "https://copyapi.infoapi.biz";

// Cache keys
const CACHE_KEYS = {
  MASTERS_AND_COPIERS: (userId, role) => `copy:masters:${role}:${userId}`,
  TRADE_HISTORY: (accountIds, page, pageSize) =>
    `copy:trade:history:${JSON.stringify(accountIds)}:${page}:${pageSize}`,
  OPEN_TRADES_CHECK: (accountIds) =>
    `copy:trades:open:${JSON.stringify(accountIds)}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  MASTERS_AND_COPIERS: 30, // 30 seconds - account status changes
  TRADE_HISTORY: 60, // 1 minute
  OPEN_TRADES_CHECK: 10, // 10 seconds - near real-time
};

// API timeout
const API_TIMEOUT = 15000; // 15 seconds
const EXTERNAL_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

const getCopyUserAccountNumbers = async (userId, userRole) => {
  const query = userRole === "admin" ? {} : { user: userId };
  const accounts = await Account.find(query).select("mt5Account").lean();
  return accounts
    .map((account) => parseInt(account.mt5Account, 10))
    .filter((num) => !isNaN(num));
};

const fetchMastersAndCopiersData = async (accountNumbers) =>
  axios.post(
    `${COPY_API_URL}/api/getAllCopierDetailsByAccouts`,
    { copiers: accountNumbers },
    { timeout: API_TIMEOUT },
  );

const summarizeMastersAndCopiers = (masterAccounts = []) => {
  let totalCopiers = 0;
  let totalProfit = 0;

  for (const master of masterAccounts) {
    totalCopiers += master.copiers?.length || 0;
    totalProfit += master.master?.totalProfit || 0;
  }

  return {
    totalCopiers,
    totalMasters: masterAccounts.length,
    totalProfit,
    activeTrades: 0,
  };
};

// Get all masters and their copiers for a user
exports.getMastersAndCopiers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const cacheKey = CACHE_KEYS.MASTERS_AND_COPIERS(userId, userRole);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        count: cached.count,
        message: cached.message,
        fromCache: true,
      });
    }

    const accountNumbers = await getCopyUserAccountNumbers(userId, userRole);

    if (accountNumbers.length === 0) {
      const emptyResponse = {
        success: true,
        count: 0,
        data: [],
        message:
          userRole === "admin"
            ? "No accounts found in the system"
            : "No accounts found for this user",
      };
      return res.status(200).json(emptyResponse);
    }

    // Call external API with timeout
    const response = await fetchMastersAndCopiersData(accountNumbers);

    if (response.data.status === "success") {
      const result = {
        success: true,
        data: response.data.masterAccounts,
        count: response.data.masterAccounts?.length || 0,
        message: "Masters and copiers fetched successfully",
      };

      // Cache the result
      await cacheService.set(cacheKey, result, CACHE_TTL.MASTERS_AND_COPIERS);

      return res.status(200).json(result);
    }

    return res.status(400).json({
      success: false,
      message: response.data.message || "Failed to fetch master accounts",
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Get trade history for specific copier accounts
exports.getTradeHistory = async (req, res, next) => {
  try {
    const { copierAccounts, page = 1, pageSize = 10 } = req.body;

    if (
      !copierAccounts ||
      !Array.isArray(copierAccounts) ||
      copierAccounts.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Copier accounts are required",
      });
    }

    const pageNum = parseInt(page);
    const pageSizeNum = Math.min(parseInt(pageSize), 100); // Max 100 per page

    // Sort account IDs for consistent cache key
    const sortedAccounts = [...copierAccounts].sort();
    const cacheKey = CACHE_KEYS.TRADE_HISTORY(
      sortedAccounts,
      pageNum,
      pageSizeNum,
    );

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const response = await axios.post(
      `${COPY_API_URL}/api/getCopiersTradeHistoryByAccountsByPage`,
      {
        copierAccounts: copierAccounts,
        page: pageNum,
        page_size: pageSizeNum,
      },
      { timeout: API_TIMEOUT },
    );

    if (!response.data.error) {
      // Cache the response
      await cacheService.set(cacheKey, response.data, CACHE_TTL.TRADE_HISTORY);

      return res.status(200).json({
        success: true,
        data: response.data,
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data.message || "Failed to fetch trade history",
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Unlink copier account
exports.unlinkCopier = async (req, res, next) => {
  try {
    const { mt5Account } = req.body;

    if (!mt5Account) {
      return res.status(400).json({
        success: false,
        message: "MT5 account number is required",
      });
    }

    // Verify account belongs to user (if not admin)
    if (req.user.role !== "admin") {
      const account = await Account.findOne({
        mt5Account: mt5Account.toString(),
        user: req.user.id,
      }).lean();

      if (!account) {
        return res.status(403).json({
          success: false,
          message: "You don't have permission to unlink this account",
        });
      }
    }

    // Create form data
    const FormData = require("form-data");
    const formData = new FormData();
    formData.append("mt5Account", mt5Account.toString());

    const response = await axios.post(
      `${COPY_API_URL}/api/deleteUserAccount`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: API_TIMEOUT,
      },
    );

    if (response.data.message === "user accounts deleted.") {
      // Invalidate caches for this user
      await invalidateCopyCaches(req.user.id, req.user.role);
      await invalidateAccountCaches(req.user._id || req.user.id);

      const io = req.app.get("io");
      if (io) {
        if (io.emitCacheInvalidation) {
          io.emitCacheInvalidation(req.user.id, [
            "mastersAndCopiers",
            "copyTradingStats",
            "accounts",
          ]);
        }
        if (io.broadcastCacheInvalidation) {
          io.broadcastCacheInvalidation(["mastersAndCopiers", "copyTradingStats"]);
        }
      }

      return res.status(200).json({
        success: true,
        message: "Copier account unlinked successfully",
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data.message || "Failed to unlink copier account",
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Check if copier has open trades
exports.checkOpenTrades = async (req, res, next) => {
  try {
    const { copierAccounts } = req.body;

    if (
      !copierAccounts ||
      !Array.isArray(copierAccounts) ||
      copierAccounts.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Copier accounts are required",
      });
    }

    // Sort for consistent cache key
    const sortedAccounts = [...copierAccounts].sort();
    const cacheKey = CACHE_KEYS.OPEN_TRADES_CHECK(sortedAccounts);

    // Try to get from cache (short TTL for near real-time)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        hasOpenTrades: cached.hasOpenTrades,
        openTradesCount: cached.openTradesCount,
        fromCache: true,
      });
    }

    const response = await axios.post(
      `${COPY_API_URL}/api/getCopiersTradeHistoryByAccountsByPage`,
      {
        copierAccounts: copierAccounts,
        page: 1,
        page_size: 100,
      },
      { timeout: API_TIMEOUT },
    );

    if (!response.data.error) {
      let openTradesCount = 0;

      if (response.data.trades && Array.isArray(response.data.trades)) {
        openTradesCount = response.data.trades.filter((trade) =>
          trade.associated_trades?.some(
            (assocTrade) =>
              assocTrade.Close_Time === null &&
              copierAccounts.includes(assocTrade.MT5Account),
          ),
        ).length;
      }

      const result = {
        hasOpenTrades: openTradesCount > 0,
        openTradesCount,
      };

      // Cache with short TTL
      await cacheService.set(cacheKey, result, CACHE_TTL.OPEN_TRADES_CHECK);

      return res.status(200).json({
        success: true,
        ...result,
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data.message || "Failed to check open trades",
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Get details for a specific copier account
exports.getCopierDetails = async (req, res, next) => {
  try {
    const { mt5Account } = req.params;

    if (!mt5Account) {
      return res.status(400).json({
        success: false,
        message: "MT5 account number is required",
      });
    }

    const cacheKey = `copy:copier:details:${mt5Account}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Verify account access
    if (req.user.role !== "admin") {
      const account = await Account.findOne({
        mt5Account: mt5Account.toString(),
        user: req.user.id,
      }).lean();

      if (!account) {
        return res.status(403).json({
          success: false,
          message: "You don't have permission to view this account",
        });
      }
    }

    const response = await axios.post(
      `${COPY_API_URL}/api/getCopierDetails`,
      { mt5Account: mt5Account.toString() },
      { timeout: API_TIMEOUT },
    );

    if (!response.data.error) {
      await cacheService.set(cacheKey, response.data, 60);
      return res.status(200).json({
        success: true,
        data: response.data,
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data.message || "Failed to fetch copier details",
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Get summary statistics for copy trading dashboard
exports.getCopySummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `copy:summary:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const accountNumbers = await getCopyUserAccountNumbers(userId, "client");

    if (accountNumbers.length === 0) {
      const emptyResult = {
        totalCopiers: 0,
        totalMasters: 0,
        totalProfit: 0,
        activeTrades: 0,
      };
      await cacheService.set(cacheKey, emptyResult, 60);
      return res.status(200).json({ success: true, data: emptyResult });
    }

    const response = await fetchMastersAndCopiersData(accountNumbers);
    const result =
      response.data.status === "success" && response.data.masterAccounts
        ? summarizeMastersAndCopiers(response.data.masterAccounts)
        : {
            totalCopiers: 0,
            totalMasters: 0,
            totalProfit: 0,
            activeTrades: 0,
          };

    await cacheService.set(cacheKey, result, 60);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(error);
  }
};

// Invalidate copy-related caches for a user
async function invalidateCopyCaches(userId, userRole) {
  const promises = [
    cacheService.deletePattern(`copy:masters:${userRole}:${userId}`),
    cacheService.deletePattern(`copy:summary:${userId}`),
    cacheService.deletePattern("copy:trade:history:*"),
    cacheService.deletePattern("copy:trades:open:*"),
  ];

  await Promise.all(promises);
  console.log(`🗑️ Copy copier caches invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateCopyCaches = invalidateCopyCaches;

function isExternalApiTimeout(error) {
  return (
    EXTERNAL_TIMEOUT_CODES.has(error?.code) ||
    EXTERNAL_TIMEOUT_CODES.has(error?.cause?.code)
  );
}

function formatExternalApiError(error) {
  return {
    message: error.message,
    code: error.code,
    causeCode: error.cause?.code,
    status: error.response?.status,
    url: error.config?.url,
    method: error.config?.method,
  };
}

const axios = require("axios");
const config = require("../../config/config");
const cacheService = require("../../services/cacheService");
const FormData = require("form-data");
const {
  invalidateAccountCaches,
} = require("./accountController");
const { AppError } = require("../../middlewares/errorHandler");
require("dotenv").config();

const COPY_API_URL = process.env.COPY_API_URL || "https://copyapi.infoapi.biz";
const API_TIMEOUT = 30000; // 30 seconds
const EXTERNAL_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);
const KNOWN_COPY_FAILURE_PATTERNS = [
  { pattern: "already copied", statusCode: 409 },
  { pattern: "already exists", statusCode: 409 },
  { pattern: "duplicate", statusCode: 409 },
  { pattern: "zero balance", statusCode: 400 },
  { pattern: "insufficient balance", statusCode: 400 },
  { pattern: "balance is 0", statusCode: 400 },
  { pattern: "balance should be greater than 0", statusCode: 400 },
];

// Cache keys
const CACHE_KEYS = {
  ALL_MASTERS: (managerIndex) => `copy:rating:masters:all:${managerIndex}`,
  MASTER_DETAILS: (masterId) => `copy:rating:master:${masterId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_MASTERS: 60, // 1 minute - master list updates less frequently
  MASTER_DETAILS: 120, // 2 minutes - details are relatively static
};

// Pre-computed avatar list for better performance
const AVATARS = ["👨‍💼", "👩‍💼", "🧑‍💻", "👨‍🔬", "👩‍🔬", "🧑‍🚀", "👨‍🎨", "👩‍🎨"];

// Helper function to calculate risk score based on gain
const calculateRiskScore = (gain) => {
  if (gain <= 10) return 1;
  if (gain <= 30) return 2;
  if (gain <= 60) return 3;
  if (gain <= 100) return 4;
  return 5;
};

// Helper function to determine expertise level
const getExpertiseLevel = (gain, copierCount) => {
  if (gain > 100 && copierCount > 100) return "legend";
  if (gain > 50 && copierCount > 50) return "expert";
  if (gain > 80) return "vertical_take_off";
  if (gain > 20 && copierCount < 20) return "young_talent";
  return "new_comers";
};

// Helper function to get avatar based on name (deterministic)
const getAvatar = (name) => {
  const index = name.length % AVATARS.length;
  return AVATARS[index];
};

// Helper function to format date consistently
const formatDate = (date, locale = "en-IN") => {
  return new Date(date).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const getCopyRatingManagerIndex = () => parseInt(process.env.Manager_Index) || 1;

const fetchAllMasterAccounts = async (managerIndex) => {
  const response = await axios.post(
    `${COPY_API_URL}/api/getAllMasterByManagerIndex`,
    { Manager_Index: managerIndex },
    { timeout: API_TIMEOUT },
  );

  if (response.data.error) {
    const error = new Error(
      response.data.message || "Failed to fetch master traders",
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    masterAccounts: response.data.masterAccounts || [],
    totalCount: response.data.noOfMaster,
  };
};

const transformMasterAccounts = (masterAccounts) => {
  const transformedMasters = masterAccounts.map((master) => {
    const gain = master.gain || 0;
    const copierCount = master.copierCount || 0;
    const profit = master.profit || 0;
    const balance = master.balance || 0;
    const commission = master.commission || 0;
    const minInvest = master.min_invest || 100;
    const createdAt = master.created_at || new Date();

    return {
      id: master.login?.toString() || "",
      name: master.name || "Unknown",
      avatar: getAvatar(master.name || "Unknown"),
      expertise: getExpertiseLevel(gain, copierCount),
      riskScore: calculateRiskScore(gain),
      growth: `${gain.toFixed(2)}%`,
      profitLoss: Math.round(profit),
      copiers: copierCount,
      fees: commission === 0 ? "FREE" : `${commission}%`,
      capital: balance > 0 ? balance.toLocaleString() : "0",
      minInvestment: minInvest,
      activeSince: formatDate(createdAt, "en-IN"),
      _createdAtSort: new Date(createdAt).getTime(),
      _gainValue: gain,
      _isFree: commission === 0,
    };
  });

  transformedMasters.sort((a, b) => b._createdAtSort - a._createdAtSort);
  return transformedMasters.map(({ _createdAtSort, _gainValue, _isFree, ...rest }) => rest);
};

const summarizeMasterAccounts = (masterAccounts) => {
  let totalCopiers = 0;
  let gainTotal = 0;
  let topGain = 0;
  let freeMasters = 0;

  for (const master of masterAccounts) {
    const gain = master.gain || 0;
    totalCopiers += master.copierCount || 0;
    gainTotal += gain;
    if (gain > topGain) topGain = gain;
    if ((master.commission || 0) === 0) freeMasters++;
  }

  return {
    totalMasters: masterAccounts.length,
    totalCopiers,
    averageGain:
      masterAccounts.length > 0 ? (gainTotal / masterAccounts.length).toFixed(2) : 0,
    topGain,
    freeMasters,
  };
};
// Get all master traders
exports.getAllMasters = async (req, res, next) => {
  try {
    const managerIndex = getCopyRatingManagerIndex();
    const cacheKey = CACHE_KEYS.ALL_MASTERS(managerIndex);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        totalCount: cached.totalCount,
        fromCache: true,
      });
    }

    const { masterAccounts, totalCount } = await fetchAllMasterAccounts(managerIndex);
    const transformedMasters = transformMasterAccounts(masterAccounts);

    const result = {
      success: true,
      data: transformedMasters,
      totalCount: totalCount || transformedMasters.length,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.ALL_MASTERS);

    res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return next(new AppError(error.message, error.statusCode));
    }

    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(new AppError("Internal server error", 500));
  }
};
// Get master details
exports.getMasterDetails = async (req, res, next) => {
  try {
    const { masterId } = req.params;
    const cacheKey = CACHE_KEYS.MASTER_DETAILS(masterId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const response = await axios.get(
      `${COPY_API_URL}/api/getMasterDetailsByAccount`,
      {
        params: { MT5Account: masterId },
        timeout: API_TIMEOUT,
      },
    );

    if (!response.data.success) {
      return res.status(400).json({
        success: false,
        message: response.data.message || "Failed to fetch master details",
      });
    }

    const masterData = response.data.data;
    const stats = masterData.stats || {};
    const allStats = stats.all || { gain: 0, profit: 0, copierCount: 0 };
    const gain = allStats.gain || 0;
    const copierCount = allStats.copierCount || 0;
    const profit = allStats.profit || 0;
    const balance = masterData.balance || 0;
    const commission = masterData.commission || 0;
    const minInvest = masterData.min_invest || 100;
    const floatingProfit = masterData.floating_profit || 0;
    const description = masterData.description || "No description available";
    const chatLink = masterData.chat_link || null;
    const createdAt = masterData.created_at || new Date();

    // Transform API data efficiently
    const transformedMaster = {
      id: masterData.login?.toString() || "",
      name: masterData.name || "Unknown",
      avatar: getAvatar(masterData.name || "Unknown"),
      expertise: getExpertiseLevel(gain, copierCount),
      riskScore: calculateRiskScore(gain),
      growth: `${gain.toFixed(2)}%`,
      profitLoss: Math.round(profit),
      copiers: copierCount,
      fees: commission === 0 ? "FREE" : `${commission}%`,
      capital: balance > 0 ? balance.toLocaleString() : "0",
      minInvestment: minInvest,
      activeSince: formatDate(createdAt, "en-US"),
      description,
      telegramLink: chatLink,

      performance: {
        profit: `${gain.toFixed(2)}%`,
        copier: copierCount,
        profitAndLoss: Math.round(profit).toLocaleString(),
      },

      accountDetails: {
        unrealizedProfit: Math.round(floatingProfit),
        accountBalance: Math.round(balance).toLocaleString(),
        masterTraderBonus: "0",
        lever: "100",
      },

      riskManagement: {
        maxUnrealizedLoss: 5000,
        maxLossDuration: "7 days",
      },

      activityData: {
        "1W": generateCachedActivityData(masterId, 7),
        "1M": generateCachedActivityData(masterId, 30),
        "3M": generateCachedActivityData(masterId, 90),
        "6M": generateCachedActivityData(masterId, 180),
        ALL: generateCachedActivityData(masterId, 365),
      },

      trades: [
        {
          id: "T001",
          symbol: "EURUSD",
          type: "buy",
          openTime: new Date().toISOString(),
          closeTime: new Date().toISOString(),
          duration: "2h 15m",
          profit: Math.random() * 200 - 100,
        },
      ],

      stats: {
        weekly: stats.weekly || { gain: 0, profit: 0, copierCount: 0 },
        monthly: stats.monthly || { gain: 0, profit: 0, copierCount: 0 },
        threeMonths: stats.three_months || {
          gain: 0,
          profit: 0,
          copierCount: 0,
        },
        sixMonths: stats.six_months || { gain: 0, profit: 0, copierCount: 0 },
        all: allStats,
      },
    };

    // Cache the result
    await cacheService.set(
      cacheKey,
      transformedMaster,
      CACHE_TTL.MASTER_DETAILS,
    );

    res.status(200).json({
      success: true,
      data: transformedMaster,
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

    next(new AppError("Internal server error", 500));
  }
};
// Setup copying
exports.setupCopying = async (req, res, next) => {
  try {
    const { masterAccount, copierAccount, minInvestment } = req.body;

    // Validate required fields
    if (!masterAccount || !copierAccount || !minInvestment) {
      return res.status(400).json({
        success: false,
        message:
          "Master account, copier account, and minimum investment are required",
      });
    }

    // Validate minInvestment
    if (minInvestment < 0) {
      return res.status(400).json({
        success: false,
        message: "Minimum investment must be greater than 0",
      });
    }

    // Prepare form data
    const formData = new FormData();
    formData.append("userId", process.env.User_Id);
    formData.append("mt5Account", copierAccount);
    formData.append("masterAccount", masterAccount);
    formData.append("min_invest", minInvestment.toString());

    // Call external API
    const response = await axios.post(
      `${COPY_API_URL}/api/addAccountToMasterByCheckingBalance`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: API_TIMEOUT,
      },
    );

    if (response.data.error) {
      const normalized = normalizeCopySetupError(response.data);
      return res.status(normalized.statusCode).json({
        success: false,
        message: normalized.message,
      });
    }

    // Invalidate relevant caches
    await invalidateCopyRatingCaches(masterAccount);
    await invalidateAccountCaches(req.user._id || req.user.id);

    const io = req.app.get("io");
    if (io) {
      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(req.user._id || req.user.id, [
          "mastersAndCopiers",
          "copyTradingStats",
          "accounts",
        ]);
      }
      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation(["mastersAndCopiers", "copyTradingStats"]);
      }
    }

    res.status(200).json({
      success: true,
      message: response.data.message || "Successfully set up copying",
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

    if (error.response && error.response.data) {
      const normalized = normalizeCopySetupError(error.response.data);
      return next(new AppError(normalized.message, normalized.statusCode));
    }

    next(new AppError("Failed to setup copying", 500));
  }
};
// Get master statistics summary (for dashboard)
exports.getMasterStatistics = async (req, res, next) => {
  try {
    const managerIndex = getCopyRatingManagerIndex();
    const cacheKey = `copy:rating:stats:${managerIndex}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const { masterAccounts } = await fetchAllMasterAccounts(managerIndex);
    const statistics = summarizeMasterAccounts(masterAccounts);

    await cacheService.set(cacheKey, statistics, 300); // 5 minutes cache

    res.status(200).json({
      success: true,
      data: statistics,
    });
  } catch (error) {
    if (error.statusCode) {
      return next(new AppError(error.message, error.statusCode));
    }

    if (isExternalApiTimeout(error)) {
      return next(
        new AppError(
          "Copy trading API is not responding right now. Please try again.",
          504,
        ),
      );
    }

    next(new AppError("Internal server error", 500));
  }
};
// Activity data cache storage
const activityDataCache = new Map();
const ACTIVITY_CACHE_TTL = 3600000; // 1 hour in milliseconds

// Generate activity data with caching
function generateCachedActivityData(masterId, days) {
  const cacheKey = `${masterId}:${days}`;
  const cached = activityDataCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < ACTIVITY_CACHE_TTL) {
    return cached.data;
  }

  const data = generateActivityData(days);
  activityDataCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });

  return data;
}

// Generate activity data for chart (optimized)
function generateActivityData(days) {
  const data = [];
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Pre-calculate random values for consistency
  const baseValue = 500;
  const baseProfit = 0;

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);

    // Use deterministic values based on date to avoid random fluctuations
    const dayOfYear = date.getDate();
    const value = baseValue + (dayOfYear % 500);
    const profit = baseProfit + ((dayOfYear % 200) - 100);

    data.push({
      date: date.toISOString().split("T")[0],
      value: Math.round(value),
      profit: Math.round(profit),
    });
  }

  return data;
}

// Invalidate copy rating caches
async function invalidateCopyRatingCaches(masterId = null) {
  const managerIndex = parseInt(process.env.Manager_Index) || 1;
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.ALL_MASTERS(managerIndex)),
    cacheService.deletePattern(`copy:rating:stats:${managerIndex}`),
  ];

  if (masterId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.MASTER_DETAILS(masterId)),
    );
    // Also clear activity cache for this master
    for (const key of activityDataCache.keys()) {
      if (key.startsWith(masterId)) {
        activityDataCache.delete(key);
      }
    }
  }

  await Promise.all(promises);
  console.log(
    `🗑️ Copy rating caches invalidated${masterId ? ` for master: ${masterId}` : ""}`,
  );
}

// Export cache invalidation function
exports.invalidateCopyRatingCaches = invalidateCopyRatingCaches;

function normalizeCopySetupError(payload = {}) {
  const message = extractCopyErrorMessage(payload);
  const normalizedMessage = message || "Failed to setup copying";
  const lowerMessage = normalizedMessage.toLowerCase();

  const matchedRule = KNOWN_COPY_FAILURE_PATTERNS.find(({ pattern }) =>
    lowerMessage.includes(pattern),
  );

  return {
    statusCode: matchedRule?.statusCode || 400,
    message: normalizedMessage,
  };
}

function extractCopyErrorMessage(payload = {}) {
  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    if (typeof firstError === "string" && firstError.trim()) {
      return firstError.trim();
    }
    if (typeof firstError?.message === "string" && firstError.message.trim()) {
      return firstError.message.trim();
    }
  }

  return null;
}

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

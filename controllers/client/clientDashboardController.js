// Backend/controllers/client/clientDashboardController.js - FULLY OPTIMIZED
const cacheService = require("../../services/cacheService");
const User = require("../../models/User");
const Account = require("../../models/client/Account");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const mongoose = require("mongoose");
const { AppError } = require("../../middlewares/errorHandler");

const CACHE_TTL = {
  OVERVIEW: 30,
  RECENT_TRANSACTIONS: 20,
  ACTIVE_ACCOUNTS: 30,
  FILTER_OPTIONS: 120,
  ACCOUNT_PERFORMANCE: 60,
  DASHBOARD_SUMMARY: 20,
};

const CACHE_KEYS = {
  overview: (userId) => `dashboard:overview:${userId}`,
  recentTransactions: (userId, limit) =>
    `dashboard:recent-transactions:${userId}:${limit}`,
  activeAccounts: (userId, filtersHash) =>
    `dashboard:active-accounts:${userId}:${filtersHash}`,
  filterOptions: (userId) => `dashboard:filter-options:${userId}`,
  accountPerformance: (userId, period) =>
    `dashboard:account-performance:${userId}:${period}`,
  dashboardSummary: (userId, limit) =>
    `dashboard:summary:${userId}:${limit}`,
};

const getCacheHash = (params) => cacheService.generateKey("dashboard", params);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildClientDepositRecentPipeline = (userObjectId) => [
  { $match: { user: userObjectId } },
  {
    $lookup: {
      from: Account.collection.name,
      localField: "account",
      foreignField: "_id",
      as: "account",
    },
  },
  { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: "$_id",
      type: { $literal: "deposit" },
      amount: "$amount",
      status: "$status",
      date: { $ifNull: ["$updatedAt", "$requestedDate"] },
      processedDate: { $ifNull: ["$approvedDate", "$rejectedDate"] },
      account: "$account.mt5Account",
      paymentMethod: "$paymentType",
      createdAt: { $ifNull: ["$createdAt", "$requestedDate"] },
      sortDate: { $ifNull: ["$createdAt", "$requestedDate"] },
    },
  },
];

const buildClientWithdrawalRecentPipeline = (userObjectId) => [
  { $match: { user: userObjectId } },
  {
    $lookup: {
      from: Account.collection.name,
      localField: "account",
      foreignField: "_id",
      as: "account",
    },
  },
  { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: "$_id",
      type: { $literal: "withdrawal" },
      amount: "$amount",
      status: "$status",
      date: { $ifNull: ["$updatedAt", "$requestedDate"] },
      processedDate: { $ifNull: ["$approvedDate", "$rejectedDate"] },
      account: "$account.mt5Account",
      paymentMethod: "$paymentMethod",
      createdAt: { $ifNull: ["$createdAt", "$requestedDate"] },
      sortDate: { $ifNull: ["$createdAt", "$requestedDate"] },
    },
  },
];

const buildClientTransferRecentPipeline = (accountIds) => [
  {
    $match: {
      $or: [{ fromAccount: { $in: accountIds } }, { toAccount: { $in: accountIds } }],
    },
  },
  {
    $lookup: {
      from: Account.collection.name,
      localField: "fromAccount",
      foreignField: "_id",
      as: "fromAccount",
    },
  },
  { $unwind: { path: "$fromAccount", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: Account.collection.name,
      localField: "toAccount",
      foreignField: "_id",
      as: "toAccount",
    },
  },
  { $unwind: { path: "$toAccount", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: "$_id",
      type: { $literal: "transfer" },
      amount: "$amount",
      status: "$status",
      date: "$updatedAt",
      processedDate: { $ifNull: ["$approvedDate", "$rejectedDate"] },
      fromAccount: "$fromAccount.mt5Account",
      toAccount: "$toAccount.mt5Account",
      createdAt: { $ifNull: ["$createdAt", "$requestedDate"] },
      sortDate: { $ifNull: ["$createdAt", "$requestedDate"] },
    },
  },
];

async function getRecentTransactionsAggregate(userId, limit = 20) {
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const depositWithdrawalPipeline = [
    ...buildClientDepositRecentPipeline(userObjectId),
    {
      $unionWith: {
        coll: Withdrawal.collection.name,
        pipeline: buildClientWithdrawalRecentPipeline(userObjectId),
      },
    },
    { $sort: { sortDate: -1, id: -1 } },
    { $limit: limit },
  ];

  // Account lookup only feeds the transfer stage, so run it alongside the
  // deposit/withdrawal aggregate instead of blocking on it first.
  const [depositWithdrawalResults, userAccounts] = await Promise.all([
    Deposit.aggregate(depositWithdrawalPipeline).allowDiskUse(true),
    Account.find({ user: userObjectId }).select("_id").lean(),
  ]);

  const accountIds = userAccounts.map((account) => account._id);

  const transferResults = accountIds.length
    ? await Transfer.aggregate([
        ...buildClientTransferRecentPipeline(accountIds),
        { $sort: { sortDate: -1, id: -1 } },
        { $limit: limit },
      ])
    : [];

  return [...depositWithdrawalResults, ...transferResults]
    .sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate))
    .slice(0, limit);
}

async function getDashboardOverviewMetrics(userId) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const [accountStats, depositStats, withdrawalStats] = await Promise.all([
    Account.aggregate([
      { $match: { user: userObjectId } },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: "$balance" },
          totalEquity: { $sum: "$equity" },
          totalMt5Accounts: { $sum: 1 },
        },
      },
    ]),
    Deposit.aggregate([
      { $match: { user: userObjectId, status: "Approved" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Withdrawal.aggregate([
      { $match: { user: userObjectId, status: "Approved" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const accounts = accountStats[0] || {
    totalBalance: 0,
    totalEquity: 0,
    totalMt5Accounts: 0,
  };
  const deposits = depositStats[0] || { total: 0, count: 0 };
  const withdrawals = withdrawalStats[0] || { total: 0, count: 0 };

  return {
    totalBalance: accounts.totalBalance.toFixed(2),
    totalEquity: accounts.totalEquity.toFixed(2),
    totalDeposits: deposits.total.toFixed(2),
    totalWithdrawals: withdrawals.total.toFixed(2),
    totalMt5Accounts: accounts.totalMt5Accounts,
    netBalance: (accounts.totalBalance + accounts.totalEquity).toFixed(2),
  };
}

/**
 * Get dashboard overview statistics
 */
const getDashboardOverview = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.overview(userId);
    let result = await cacheService.get(cacheKey);

    if (!result) {
      result = await getDashboardOverviewMetrics(userId);
      await cacheService.set(cacheKey, result, CACHE_TTL.OVERVIEW);
    }

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to fetch dashboard overview", 500));
  }
};


/**
 * Get all recent transactions (deposits, withdrawals, transfers) - with limit
 */
const getRecentTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limitNum = parsePositiveInt(req.query.limit, 20);
    const cacheKey = CACHE_KEYS.recentTransactions(userId, limitNum);
    let limitedTransactions = await cacheService.get(cacheKey);

    if (!limitedTransactions) {
      limitedTransactions = await getRecentTransactionsAggregate(userId, limitNum);
      await cacheService.set(
        cacheKey,
        limitedTransactions,
        CACHE_TTL.RECENT_TRANSACTIONS,
      );
    }

    const result = {
      transactions: limitedTransactions,
      totalTransactions: limitedTransactions.length,
    };

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to fetch recent transactions", 500));
  }
};
/**
 * Get all active accounts with search and filter - with pagination
 */
const getActiveAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      search = "",
      accountType = "",
      leverage = "",
      status = "",
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;
    const normalizedUserId = String(userId);

    // Build filter query efficiently
    const filterQuery = { user: userId };

    // Only add search if provided
    if (search) {
      const searchRegex = new RegExp(search, "i");
      filterQuery.$or = [
        { mt5Account: searchRegex },
        { name: searchRegex },
        { groupName: searchRegex },
      ];
    }

    if (accountType) filterQuery.accountType = accountType;
    if (leverage) filterQuery.leverage = leverage;
    if (status !== "") filterQuery.status = status === "true";

    const cacheKey = CACHE_KEYS.activeAccounts(
      normalizedUserId,
      getCacheHash({
        search,
        accountType,
        leverage,
        status,
        page: pageNum,
        limit: limitNum,
      }),
    );
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Run queries in parallel
    const [accounts, total, filterOptions, user] = await Promise.all([
      Account.find(filterQuery)
        .select(
          "mt5Account name balance equity leverage accountType groupName status platform createdAt",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),

      Account.countDocuments(filterQuery),

      // Get filter options only once (cache separately)
      getFilterOptions(userId),
      User.findById(userId).select("isEmailVerified").lean(),
    ]);

    // Format accounts efficiently
    const formattedAccounts = accounts.map((account) => ({
      id: account._id,
      mt5Account: account.mt5Account,
      name: account.name,
      balance: parseFloat(account.balance || 0).toFixed(2),
      equity: parseFloat(account.equity || 0).toFixed(2),
      leverage: account.leverage,
      accountType: account.accountType,
      groupName: account.groupName,
      platform: account.platform,
      status: account.status,
      kycStatus: user?.isEmailVerified ? "Verified" : "Pending",
      createdAt: account.createdAt,
      totalValue: (
        parseFloat(account.balance || 0) + parseFloat(account.equity || 0)
      ).toFixed(2),
    }));

    const totalPages = Math.ceil(total / limitNum);

    const result = {
      accounts: formattedAccounts,
      totalAccounts: total,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
      filterOptions,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.ACTIVE_ACCOUNTS);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to fetch active accounts", 500));
  }
};

// Helper function to get filter options
async function getFilterOptions(userId) {
  const cacheKey = CACHE_KEYS.filterOptions(userId);
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  const filterOptions = await Account.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        accountTypes: { $addToSet: "$accountType" },
        leverages: { $addToSet: "$leverage" },
      },
    },
  ]);

  const result = {
    accountTypes: filterOptions[0]?.accountTypes || [],
    leverages: filterOptions[0]?.leverages || [],
  };

  await cacheService.set(cacheKey, result, CACHE_TTL.FILTER_OPTIONS);
  return result;
}
/**
 * Get account performance data
 */
const getAccountPerformance = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { period = "7d" } = req.query;
    const cacheKey = CACHE_KEYS.accountPerformance(userId, period);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Single aggregation: account list projection + summary totals computed
    // in one round trip instead of fetching docs and reducing them in JS.
    const [facetResult] = await Account.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId) } },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          accounts: [
            {
              $project: {
                _id: 0,
                accountNumber: "$mt5Account",
                balance: { $ifNull: ["$balance", 0] },
                equity: { $ifNull: ["$equity", 0] },
              },
            },
          ],
          summary: [
            {
              $group: {
                _id: null,
                totalAccounts: { $sum: 1 },
                totalValue: {
                  $sum: {
                    $add: [
                      { $ifNull: ["$balance", 0] },
                      { $ifNull: ["$equity", 0] },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ]);

    const rawAccounts = facetResult?.accounts || [];
    const summaryTotals = facetResult?.summary?.[0] || {
      totalAccounts: 0,
      totalValue: 0,
    };

    if (rawAccounts.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          accounts: [],
          period,
          summary: {
            totalAccounts: 0,
            totalValue: "0.00",
            averagePerformance: 0,
          },
        },
      });
    }

    const performanceData = rawAccounts.map((account) => ({
      accountNumber: account.accountNumber,
      currentValue: (account.balance + account.equity).toFixed(2),
      balance: account.balance.toFixed(2),
      equity: account.equity.toFixed(2),
      performance: {
        dailyChange: 0,
        weeklyChange: 0,
        monthlyChange: 0,
        totalReturn: 0,
      },
    }));

    const result = {
      accounts: performanceData,
      period,
      summary: {
        totalAccounts: summaryTotals.totalAccounts,
        totalValue: summaryTotals.totalValue.toFixed(2),
        averagePerformance: 0,
      },
    };

    await cacheService.set(
      cacheKey,
      result,
      CACHE_TTL.ACCOUNT_PERFORMANCE,
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to fetch account performance", 500));
  }
};
/**
 * Get dashboard summary with paginated transactions (optimized for homepage)
 */
const getDashboardSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const transactionLimit = parsePositiveInt(req.query.transactionLimit, 5);
    const cacheKey = CACHE_KEYS.dashboardSummary(userId, transactionLimit);
    const cached = await cacheService.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Run both queries in parallel
    const [overview, recentTransactions] = await Promise.all([
      getDashboardOverviewData(userId),
      getRecentTransactionsData(userId, transactionLimit),
    ]);

    const result = {
      overview,
      recentTransactions,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.DASHBOARD_SUMMARY);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to fetch dashboard summary", 500));
  }
};

// Helper function to get overview data
async function getDashboardOverviewData(userId) {
  return getDashboardOverviewMetrics(userId);
}

// Helper function to get recent transactions
async function getRecentTransactionsData(userId, limit = 5) {
  return getRecentTransactionsAggregate(userId, limit);
}
/**
 * Invalidate all client dashboard caches for a user
 * Call this when deposits, withdrawals, transfers, or accounts change
 */
const invalidateClientCaches = async (userId) => {
  if (!userId) {
    return;
  }

  await Promise.all([
    cacheService.deletePattern(`dashboard:overview:${userId}`),
    cacheService.deletePattern(`dashboard:recent-transactions:${userId}:*`),
    cacheService.deletePattern(`dashboard:active-accounts:${userId}:*`),
    cacheService.deletePattern(`dashboard:filter-options:${userId}`),
    cacheService.deletePattern(`dashboard:account-performance:${userId}:*`),
    cacheService.deletePattern(`dashboard:summary:${userId}:*`),
  ]);
};

// Export cache invalidation function
module.exports = {
  getDashboardOverview,
  getRecentTransactions,
  getActiveAccounts,
  getAccountPerformance,
  getDashboardSummary, // NEW
  invalidateClientCaches, // NEW
};

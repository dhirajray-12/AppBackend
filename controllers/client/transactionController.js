// Backend/controllers/client/transactionController.js - FULLY OPTIMIZED
const Deposit = require("../../models/Deposit");
const mongoose = require("mongoose");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const transactionService = require("../../services/transactionService");
const { asyncHandler } = require("../../middlewares/errorHandler");
const cacheService = require("../../services/cacheService");
const {
  getConfiguredTimezone,
  formatDateForDisplay,
} = require("../../utils/timezoneUtils");

// Cache keys
const CACHE_KEYS = {
  USER_TRANSACTIONS: (userId, filters) =>
    `transactions:user:${userId}:${JSON.stringify(filters)}`,
  EXPORT_TRANSACTIONS: (userId, filters) =>
    `transactions:export:${userId}:${JSON.stringify(filters)}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_TRANSACTIONS: 30, // 30 seconds
  EXPORT_TRANSACTIONS: 60, // 1 minute
};

// Helper to generate consistent cache key from filters
const generateFiltersKey = (filters) => {
  const { type, status, startDate, endDate, search, page, limit } = filters;
  return JSON.stringify({
    type,
    status,
    startDate,
    endDate,
    search,
    page: parseInt(page),
    limit: parseInt(limit),
  });
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
// Get all transactions for a user
exports.getUserTransactions = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const {
    type = "all",
    status = "all",
    startDate,
    endDate,
    search = "",
    page = 1,
    limit = 10,
  } = req.query;

  const pageNum = parsePositiveInt(page, 1);
  const limitNum = parsePositiveInt(limit, 10);

  const filters = {
    type,
    status,
    startDate,
    endDate,
    search,
    page: pageNum,
    limit: limitNum,
  };
  const cacheKey = CACHE_KEYS.USER_TRANSACTIONS(
    userId,
    generateFiltersKey(filters),
  );

  // Try to get from cache
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({
      success: true,
      message: "Transactions fetched successfully",
      data: cached,
      fromCache: true,
    });
  }

  const result = await transactionService.getUserTransactions(userId, {
    type,
    status,
    startDate,
    endDate,
    search,
    page: pageNum,
    limit: limitNum,
  });

  // Cache the result
  await cacheService.set(cacheKey, result, CACHE_TTL.USER_TRANSACTIONS);

  res.status(200).json({
    success: true,
    message: "Transactions fetched successfully",
    data: result,
  });
});
// Export transactions data (JSON only)
exports.exportTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      type = "all",
      status = "all",
      startDate,
      endDate,
      search = "",
    } = req.query;

    const filters = { type, status, startDate, endDate, search };
    const cacheKey = CACHE_KEYS.EXPORT_TRANSACTIONS(
      userId,
      generateFiltersKey(filters),
    );

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Date filtering
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { $gte: new Date(startDate) } : {}),
        ...(endDate ? { $lte: new Date(endDate + "T23:59:59.999Z") } : {}),
      };
    }

    const statusFilter = status !== "all" ? { status } : {};
    const searchRegex = search ? new RegExp(search, "i") : null;
    const userIdObj = new mongoose.Types.ObjectId(userId);

    // OPTIMIZED: Run all queries in parallel
    const queryPromises = [];

    if (type === "all" || type === "deposit") {
      const depositQuery = { user: userIdObj, ...dateFilter, ...statusFilter };
      if (searchRegex) {
        depositQuery.$or = [
          { accountNumber: searchRegex },
          { paymentType: searchRegex },
          { notes: searchRegex },
          { remarks: searchRegex },
        ];
      }
      queryPromises.push(
        Deposit.find(depositQuery)
          .select(
            "amount status requestedDate approvedDate rejectedDate createdAt account accountNumber paymentType",
          )
          .populate("account", "mt5Account name accountType")
          .lean(),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    if (type === "all" || type === "withdrawal") {
      const withdrawalQuery = {
        user: userIdObj,
        ...dateFilter,
        ...statusFilter,
      };
      if (searchRegex) {
        withdrawalQuery.$or = [
          { accountNumber: searchRegex },
          { paymentMethod: searchRegex },
          { remarks: searchRegex },
          { "bankDetails.bankName": searchRegex },
          { "bankDetails.accountHolderName": searchRegex },
          { "eWalletDetails.type": searchRegex },
        ];
      }
      queryPromises.push(
        Withdrawal.find(withdrawalQuery)
          .select(
            "amount status requestedDate approvedDate rejectedDate createdAt account accountNumber paymentMethod bankDetails eWalletDetails remarks",
          )
          .populate("account", "mt5Account name accountType")
          .lean(),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    if (type === "all" || type === "transfer") {
      const transferQuery = { user: userIdObj, ...dateFilter, ...statusFilter };
      queryPromises.push(
        Transfer.find(transferQuery)
          .select("amount status createdAt fromAccount toAccount")
          .populate("fromAccount", "mt5Account name accountType")
          .populate("toAccount", "mt5Account name accountType")
          .lean(),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    const [deposits, withdrawals, transfers] = await Promise.all(queryPromises);

    // Process deposits
    const formattedDeposits = deposits.map((deposit) => ({
      _id: deposit._id,
      date:
        deposit.status === "Pending"
          ? deposit.requestedDate
          : deposit.status === "Approved"
            ? deposit.approvedDate
            : deposit.status === "Rejected"
              ? deposit.rejectedDate
              : deposit.createdAt,
      type: "Deposit",
      description: `${deposit.paymentType} Deposit`,
      amount: `+$${deposit.amount.toFixed(2)}`,
      account:
        deposit.account?.mt5Account || deposit.accountNumber || "Unknown",
      status: deposit.status,
      createdAt: deposit.createdAt,
    }));

    // Process withdrawals
    const formattedWithdrawals = withdrawals.map((withdrawal) => ({
      _id: withdrawal._id,
      date:
        withdrawal.status === "Pending"
          ? withdrawal.requestedDate
          : withdrawal.status === "Approved"
            ? withdrawal.approvedDate
            : withdrawal.status === "Rejected"
              ? withdrawal.rejectedDate
              : withdrawal.createdAt,
      type: "Withdrawal",
      description: `${withdrawal.paymentMethod} Withdrawal`,
      amount: `-$${withdrawal.amount.toFixed(2)}`,
      account:
        withdrawal.account?.mt5Account || withdrawal.accountNumber || "Unknown",
      status: withdrawal.status,
      createdAt: withdrawal.createdAt,
    }));

    // Process transfers
    const formattedTransfers = [];
    for (const transfer of transfers) {
      if (
        searchRegex &&
        !transfer.fromAccount?.mt5Account?.match(searchRegex) &&
        !transfer.toAccount?.mt5Account?.match(searchRegex)
      ) {
        continue;
      }

      const fromMt5 = transfer.fromAccount?.mt5Account || "Unknown";
      const toMt5 = transfer.toAccount?.mt5Account || "Unknown";

      formattedTransfers.push({
        _id: `${transfer._id}-from`,
        date: transfer.createdAt,
        type: "Transfer",
        description: `Transfer to ${toMt5}`,
        amount: `-$${transfer.amount.toFixed(2)}`,
        account: fromMt5,
        fromAccount: fromMt5,
        toAccount: toMt5,
        status: transfer.status,
        createdAt: transfer.createdAt,
      });

      formattedTransfers.push({
        _id: `${transfer._id}-to`,
        date: transfer.createdAt,
        type: "Transfer",
        description: `Transfer from ${fromMt5}`,
        amount: `+$${transfer.amount.toFixed(2)}`,
        account: toMt5,
        fromAccount: fromMt5,
        toAccount: toMt5,
        status: transfer.status,
        createdAt: transfer.createdAt,
      });
    }

    // Combine all transactions
    let allTransactions = [
      ...formattedDeposits,
      ...formattedWithdrawals,
      ...formattedTransfers,
    ];

    // Apply general search if provided
    if (searchRegex && type === "all") {
      allTransactions = allTransactions.filter(
        (transaction) =>
          transaction.account?.match(searchRegex) ||
          transaction.description?.match(searchRegex) ||
          transaction.status?.match(searchRegex) ||
          transaction.type?.match(searchRegex),
      );
    }

    // Sort by date (most recent first)
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Format dates for export, in the superadmin-configured timezone
    const exportTimezone = await getConfiguredTimezone();
    for (const transaction of allTransactions) {
      transaction.formattedDate = formatDateForDisplay(
        transaction.date,
        exportTimezone,
      );
    }

    // Cache the result
    await cacheService.set(
      cacheKey,
      allTransactions,
      CACHE_TTL.EXPORT_TRANSACTIONS,
    );

    res.json({
      success: true,
      data: allTransactions,
    });
  } catch (error) {
    next(error);
  }
};
// Get transaction summary statistics for dashboard
exports.getTransactionSummary = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const cacheKey = `transactions:summary:${userId}`;

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({
      success: true,
      data: cached,
      fromCache: true,
    });
  }

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const today = new Date();
  const startOfDay = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  // OPTIMIZED: Single aggregation pipeline using $facet
  const [summary] = await Deposit.aggregate([
    { $match: { user: userIdObj, status: "Approved" } },
    {
      $facet: {
        today: [
          { $match: { approvedDate: { $gte: startOfDay } } },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ],
        thisWeek: [
          { $match: { approvedDate: { $gte: startOfWeek } } },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ],
        thisMonth: [
          { $match: { approvedDate: { $gte: startOfMonth } } },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ],
        total: [
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  const result = {
    deposits: {
      today: summary?.today[0]?.total || 0,
      thisWeek: summary?.thisWeek[0]?.total || 0,
      thisMonth: summary?.thisMonth[0]?.total || 0,
      total: summary?.total[0]?.total || 0,
      todayCount: summary?.today[0]?.count || 0,
      totalCount: summary?.total[0]?.count || 0,
    },
  };

  await cacheService.set(cacheKey, result, 60); // 1 minute cache

  res.status(200).json({
    success: true,
    data: result,
  });
});
// Get monthly transaction breakdown for charts
exports.getMonthlyTransactions = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { year = new Date().getFullYear() } = req.query;
  const targetYear = parseInt(year);

  const cacheKey = `transactions:monthly:${userId}:${targetYear}`;

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({
      success: true,
      data: cached,
      fromCache: true,
    });
  }

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const startDate = new Date(targetYear, 0, 1);
  const endDate = new Date(targetYear, 11, 31, 23, 59, 59);

  const monthlyData = await Deposit.aggregate([
    {
      $match: {
        user: userIdObj,
        status: "Approved",
        approvedDate: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: { month: { $month: "$approvedDate" } },
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.month": 1 } },
  ]);

  const monthlyWithdrawals = await Withdrawal.aggregate([
    {
      $match: {
        user: userIdObj,
        status: "Approved",
        approvedDate: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: { month: { $month: "$approvedDate" } },
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.month": 1 } },
  ]);

  // Create maps for O(1) lookup
  const depositsMap = new Map(monthlyData.map((d) => [d._id.month, d]));
  const withdrawalsMap = new Map(
    monthlyWithdrawals.map((w) => [w._id.month, w]),
  );

  const result = [];
  for (let i = 1; i <= 12; i++) {
    const deposits = depositsMap.get(i) || { total: 0, count: 0 };
    const withdrawals = withdrawalsMap.get(i) || { total: 0, count: 0 };

    result.push({
      month: i,
      monthName: new Date(targetYear, i - 1).toLocaleString("en-US", {
        month: "short",
      }),
      deposits: deposits.total,
      depositsCount: deposits.count,
      withdrawals: withdrawals.total,
      withdrawalsCount: withdrawals.count,
      netFlow: deposits.total - withdrawals.total,
    });
  }

  await cacheService.set(cacheKey, result, 3600); // 1 hour cache

  res.status(200).json({
    success: true,
    data: result,
  });
});
// Invalidate transaction caches for a user
const invalidateTransactionCaches = async (userId) => {
  const patterns = [
    `transactions:user:${userId}:*`,
    `transactions:export:${userId}:*`,
    `transactions:summary:${userId}`,
    `transactions:monthly:${userId}:*`,
  ];

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Transaction caches invalidated for user: ${userId}`);
};

// Export cache invalidation function
exports.invalidateTransactionCaches = invalidateTransactionCaches;

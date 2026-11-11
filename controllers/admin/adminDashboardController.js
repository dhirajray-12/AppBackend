// Backend/controllers/admin/adminDashboardController.js - FIXED VERSION
const User = require("../../models/User");
const Profile = require("../../models/client/Profile");
const Ticket = require("../../models/Ticket");
const Account = require("../../models/client/Account");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const AppSetting = require("../../models/AppSetting");
const cacheService = require("../../services/cacheService");
const {
  buildSessionSummary,
  getLatestClientSessionsOverview,
} = require("../../services/deviceSessionService");

// Cache keys
const CACHE_KEYS = {
  DASHBOARD_STATS: "admin:dashboard:stats",
  REVENUE_CHART: (days) => `admin:revenue:${days}`,
  CLIENT_DISTRIBUTION: "admin:distribution",
  RECENT_TRANSACTIONS: (limit) => `admin:transactions:${limit}`,
  DAILY_STATS: "admin:daily:stats",
  TOP_CLIENTS: (limit) => `admin:topclients:${limit}`,
  TODAY_PERFORMANCE: "admin:today:performance",
  DEVICE_SESSIONS: (limit) => `admin:device-sessions:${limit}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  DASHBOARD_STATS: 60, // 1 minute
  REVENUE_CHART: 3600, // 1 hour
  CLIENT_DISTRIBUTION: 300, // 5 minutes
  RECENT_TRANSACTIONS: 30, // 30 seconds
  DAILY_STATS: 300, // 5 minutes
  TOP_CLIENTS: 600, // 10 minutes
  TODAY_PERFORMANCE: 15, // 15 seconds
  DEVICE_SESSIONS: 30,
};

// Helper function to safely format dates
const formatDateKey = (date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const buildDashboardUserProjection = () => ({
  name: {
    $trim: {
      input: {
        $concat: [
          { $ifNull: ["$user.firstName", ""] },
          " ",
          { $ifNull: ["$user.lastName", ""] },
        ],
      },
    },
  },
  email: { $ifNull: ["$user.email", ""] },
});

const buildRecentDepositPipeline = (limit) => [
  { $sort: { createdAt: -1 } },
  { $limit: limit },
  {
    $lookup: {
      from: User.collection.name,
      localField: "user",
      foreignField: "_id",
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
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
      type: { $literal: "Deposit" },
      amount: "$amount",
      user: buildDashboardUserProjection(),
      account: { $ifNull: ["$account.mt5Account", "N/A"] },
      status: "$status",
      date: "$createdAt",
      paymentMethod: "$paymentType",
      sortDate: "$createdAt",
    },
  },
];

const buildRecentWithdrawalPipeline = (limit) => [
  { $sort: { createdAt: -1 } },
  { $limit: limit },
  {
    $lookup: {
      from: User.collection.name,
      localField: "user",
      foreignField: "_id",
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
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
      type: { $literal: "Withdrawal" },
      amount: "$amount",
      user: buildDashboardUserProjection(),
      account: {
        $ifNull: ["$accountNumber", "$account.mt5Account", "N/A"],
      },
      status: "$status",
      date: "$createdAt",
      paymentMethod: "$paymentMethod",
      sortDate: "$createdAt",
    },
  },
];

const buildRecentTransferPipeline = (limit) => [
  { $sort: { createdAt: -1 } },
  { $limit: limit },
  {
    $lookup: {
      from: User.collection.name,
      localField: "user",
      foreignField: "_id",
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
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
      type: { $literal: "Transfer" },
      amount: "$amount",
      user: buildDashboardUserProjection(),
      account: {
        $concat: [
          { $ifNull: ["$fromAccount.mt5Account", "?"] },
          " → ",
          { $ifNull: ["$toAccount.mt5Account", "?"] },
        ],
      },
      status: "$status",
      date: "$createdAt",
      paymentMethod: { $literal: "Internal Transfer" },
      sortDate: "$createdAt",
    },
  },
];

const calculateGrowth = (current, previous) => {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? 100 : 0;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
};

exports.getAdminDashboardStats = async (req, res, next) => {
  const cacheKey = cacheService.generateKey(CACHE_KEYS.DASHBOARD_STATS, {
    role: req.user.role,
  });

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const previous30DaysStart = new Date(
      last30Days.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    const [
      clientStats,
      depositStats,
      withdrawalStats,
      ibStats,
      accountStats,
      transferStats,
      profileStats,
      equityStats,
      ticketStats,
    ] = await Promise.all([
      User.aggregate([
        { $match: { role: "client" } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            today: { $sum: { $cond: [{ $gte: ["$createdAt", today] }, 1, 0] } },
            thisWeek: {
              $sum: { $cond: [{ $gte: ["$createdAt", startOfWeek] }, 1, 0] },
            },
            thisMonth: {
              $sum: { $cond: [{ $gte: ["$createdAt", startOfMonth] }, 1, 0] },
            },
            current30Days: {
              $sum: { $cond: [{ $gte: ["$createdAt", last30Days] }, 1, 0] },
            },
            previous30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Deposit.aggregate([
        {
          $group: {
            _id: null,
            totalAmount: {
              $sum: {
                $cond: [{ $eq: ["$status", "Approved"] }, "$amount", 0],
              },
            },
            totalCount: {
              $sum: { $cond: [{ $eq: ["$status", "Approved"] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] },
            },
            todayAmount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$approvedDate", today] },
                      { $eq: ["$status", "Approved"] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            todayCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$approvedDate", today] },
                      { $eq: ["$status", "Approved"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            current30Amount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", last30Days] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            previous30Amount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", previous30DaysStart] },
                      { $lt: ["$approvedDate", last30Days] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            current30Count: {
              $sum: { $cond: [{ $gte: ["$createdAt", last30Days] }, 1, 0] },
            },
            previous30Count: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Withdrawal.aggregate([
        {
          $group: {
            _id: null,
            totalAmount: {
              $sum: {
                $cond: [{ $eq: ["$status", "Approved"] }, "$amount", 0],
              },
            },
            totalCount: {
              $sum: { $cond: [{ $eq: ["$status", "Approved"] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] },
            },
            current30Amount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", last30Days] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            previous30Amount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", previous30DaysStart] },
                      { $lt: ["$approvedDate", last30Days] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            current30Count: {
              $sum: { $cond: [{ $gte: ["$createdAt", last30Days] }, 1, 0] },
            },
            previous30Count: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      IBClientConfiguration.aggregate([
        {
          $group: {
            _id: null,
            total: {
              $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
            },
            current30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "active"] },
                      { $gte: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            previous30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "active"] },
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Account.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: { $cond: [{ $eq: ["$status", true] }, 1, 0] } },
            today: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", true] },
                      { $gte: ["$createdAt", today] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            current30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", true] },
                      { $gte: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            previous30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", true] },
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Transfer.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            current30Count: {
              $sum: { $cond: [{ $gte: ["$createdAt", last30Days] }, 1, 0] },
            },
            previous30Count: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ["$createdAt", previous30DaysStart] },
                      { $lt: ["$createdAt", last30Days] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Profile.aggregate([
        { $match: { kycStatus: "unverified" } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            today: {
              $sum: {
                $cond: [{ $gte: ["$createdAt", today] }, 1, 0],
              },
            },
          },
        },
      ]),

      Account.aggregate([
        { $match: { status: true } },
        {
          $group: {
            _id: null,
            totalEquity: { $sum: "$equity" },
          },
        },
      ]),

      Ticket.aggregate([
        { $match: { status: { $in: ["open", "pending", "Open", "Pending"] } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Extract results with safe defaults
    const clients = clientStats[0] || {
      total: 0,
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
    };
    const deposits = depositStats[0] || {
      totalAmount: 0,
      totalCount: 0,
      pending: 0,
      todayAmount: 0,
    };
    const withdrawals = withdrawalStats[0] || {
      totalAmount: 0,
      totalCount: 0,
      pending: 0,
      current30Amount: 0,
      previous30Amount: 0,
      current30Count: 0,
      previous30Count: 0,
    };
    const ibPartners = ibStats[0] || {
      total: 0,
      pending: 0,
      current30Days: 0,
      previous30Days: 0,
    };
    const accounts = accountStats[0] || {
      total: 0,
      today: 0,
      current30Days: 0,
      previous30Days: 0,
    };
    const transfers = transferStats[0] || {
      total: 0,
      current30Count: 0,
      previous30Count: 0,
    };

    const clientGrowthPercentage = calculateGrowth(
      clients.current30Days || 0,
      clients.previous30Days || 0,
    );
    const depositGrowthPercentage = calculateGrowth(
      deposits.current30Amount || 0,
      deposits.previous30Amount || 0,
    );
    const withdrawalGrowthPercentage = calculateGrowth(
      withdrawals.current30Amount || 0,
      withdrawals.previous30Amount || 0,
    );
    const ibGrowthPercentage = calculateGrowth(
      ibPartners.current30Days || 0,
      ibPartners.previous30Days || 0,
    );
    const accountsGrowthPercentage = calculateGrowth(
      accounts.current30Days || 0,
      accounts.previous30Days || 0,
    );

    const currentTransactionCount =
      (deposits.current30Count || 0) +
      (withdrawals.current30Count || 0) +
      (transfers.current30Count || 0);
    const previousTransactionCount =
      (deposits.previous30Count || 0) +
      (withdrawals.previous30Count || 0) +
      (transfers.previous30Count || 0);
    const transactionGrowthPercentage = calculateGrowth(
      currentTransactionCount,
      previousTransactionCount,
    );

    const totalTransactions =
      deposits.totalCount + withdrawals.totalCount + (transfers.total || 0);

    const profiles = profileStats[0] || { total: 0, today: 0 };
    const equities = equityStats[0] || { totalEquity: 0 };
    const tickets = ticketStats[0] || { total: 0 };

    const result = {
      clients: {
        total: clients.total,
        today: clients.today,
        thisWeek: clients.thisWeek,
        thisMonth: clients.thisMonth,
        growth: clientGrowthPercentage,
        pending: deposits.pending,
      },
      deposits: {
        total: deposits.totalAmount,
        count: deposits.totalCount,
        today: deposits.todayAmount,
        pending: deposits.pending,
        growth: depositGrowthPercentage,
      },
      withdrawals: {
        total: withdrawals.totalAmount,
        count: withdrawals.totalCount,
        pending: withdrawals.pending,
        growth: withdrawalGrowthPercentage,
      },
      transactions: {
        total: totalTransactions,
        growth: transactionGrowthPercentage,
      },
      ibPartners: {
        total: ibPartners.total,
        pending: ibPartners.pending,
        growth: ibGrowthPercentage,
      },
      accounts: {
        total: accounts.total,
        today: accounts.today,
        growth: accountsGrowthPercentage,
      },
      kyc: {
        pending: profiles.total,
        today: profiles.today,
      },
      equity: {
        total: equities.totalEquity,
      },
      alerts: {
        active: tickets.total,
      },
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.DASHBOARD_STATS);

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
exports.getRevenueChartData = async (req, res, next) => {
  const days = parseInt(req.query.days) || 365;
  const cacheKey = cacheService.generateKey(CACHE_KEYS.REVENUE_CHART(days), {});

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const now = new Date();
    const months = 12;
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth() - months + 1,
      1,
    );
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const [depositsByMonth, withdrawalsByMonth] = await Promise.all([
      Deposit.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$approvedDate" },
              month: { $month: "$approvedDate" },
            },
            total: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$approvedDate" },
              month: { $month: "$approvedDate" },
            },
            total: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    const depositsMap = new Map();
    depositsByMonth.forEach((d) => {
      depositsMap.set(`${d._id.year}-${d._id.month}`, d.total);
    });

    const withdrawalsMap = new Map();
    withdrawalsByMonth.forEach((w) => {
      withdrawalsMap.set(`${w._id.year}-${w._id.month}`, w.total);
    });

    const last12Months = [];
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
      const deposits = depositsMap.get(key) || 0;
      const withdrawals = withdrawalsMap.get(key) || 0;

      last12Months.push({
        month: date.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        }),
        deposits,
        withdrawals,
        net: deposits - withdrawals,
      });
    }

    await cacheService.set(cacheKey, last12Months, CACHE_TTL.REVENUE_CHART);
    res.status(200).json({ success: true, data: last12Months });
  } catch (error) {
    next(error);
  }
};
exports.getClientDistribution = async (req, res, next) => {
  const cacheKey = CACHE_KEYS.CLIENT_DISTRIBUTION;

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const distribution = await Account.aggregate([
      { $match: { status: true } },
      {
        $group: {
          _id: "$accountType",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const total = distribution.reduce((sum, item) => sum + item.count, 0);

    const result = distribution.map((item) => ({
      name: item._id || "Unknown",
      value: item.count,
      percentage: total > 0 ? ((item.count / total) * 100).toFixed(1) : 0,
    }));

    await cacheService.set(cacheKey, result, CACHE_TTL.CLIENT_DISTRIBUTION);
    res.status(200).json({ success: true, data: result });
    } catch (error) {
    next(error);
    }
    };

    exports.getAccountsByType = async (req, res, next) => {
    try {
    const { type } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const query = { status: true };
    if (type && type !== "Unknown") {
      query.accountType = type;
    } else if (type === "Unknown") {
      query.accountType = { $exists: false };
    }

    const totalAccounts = await Account.countDocuments(query);
    const accounts = await Account.find(query)
      .populate("user", "firstName lastName email")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    res.status(200).json({
      success: true,
      data: {
        accounts,
        pagination: {
          total: totalAccounts,
          page: pageNum,
          pages: Math.ceil(totalAccounts / limitNum),
          limit: limitNum,
        },
      },
    });
    } catch (error) {
    next(error);
    }
    };

    exports.getRecentTransactions = async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 10;
  const cacheKey = cacheService.generateKey(
    CACHE_KEYS.RECENT_TRANSACTIONS(limit),
    {},
  );

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const limitedTransactions = await Deposit.aggregate([
      ...buildRecentDepositPipeline(limit),
      {
        $unionWith: {
          coll: Withdrawal.collection.name,
          pipeline: buildRecentWithdrawalPipeline(limit),
        },
      },
      {
        $unionWith: {
          coll: Transfer.collection.name,
          pipeline: buildRecentTransferPipeline(limit),
        },
      },
      { $sort: { sortDate: -1, id: -1 } },
      { $limit: limit },
    ]).allowDiskUse(true);

    await cacheService.set(
      cacheKey,
      limitedTransactions,
      CACHE_TTL.RECENT_TRANSACTIONS,
    );
    res.status(200).json({ success: true, data: limitedTransactions });
  } catch (error) {
    next(error);
  }
};
exports.getDailyStats = async (req, res, next) => {
  const cacheKey = CACHE_KEYS.DAILY_STATS;

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - 29);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);

    const [
      clientCounts,
      depositResults,
      withdrawalResults,
      transferCounts,
      ibCounts,
    ] = await Promise.all([
      User.aggregate([
        {
          $match: {
            role: "client",
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
              day: { $dayOfMonth: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Deposit.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$approvedDate" },
              month: { $month: "$approvedDate" },
              day: { $dayOfMonth: "$approvedDate" },
            },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$approvedDate" },
              month: { $month: "$approvedDate" },
              day: { $dayOfMonth: "$approvedDate" },
            },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
      Transfer.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
              day: { $dayOfMonth: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      IBClientConfiguration.aggregate([
        {
          $match: {
            status: "active",
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
              day: { $dayOfMonth: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const clientMap = new Map();
    clientCounts.forEach((c) => {
      clientMap.set(`${c._id.year}-${c._id.month}-${c._id.day}`, c.count);
    });

    const depositMap = new Map();
    depositResults.forEach((d) => {
      depositMap.set(`${d._id.year}-${d._id.month}-${d._id.day}`, {
        total: d.total,
        count: d.count,
      });
    });

    const withdrawalMap = new Map();
    withdrawalResults.forEach((w) => {
      withdrawalMap.set(`${w._id.year}-${w._id.month}-${w._id.day}`, {
        total: w.total,
        count: w.count,
      });
    });

    const transferMap = new Map();
    transferCounts.forEach((t) => {
      transferMap.set(`${t._id.year}-${t._id.month}-${t._id.day}`, t.count);
    });

    const ibMap = new Map();
    ibCounts.forEach((ib) => {
      ibMap.set(`${ib._id.year}-${ib._id.month}-${ib._id.day}`, ib.count);
    });

    const last30Days = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const key = `${currentDate.getFullYear()}-${currentDate.getMonth() + 1}-${currentDate.getDate()}`;
      const deposits = depositMap.get(key) || { total: 0, count: 0 };
      const withdrawals = withdrawalMap.get(key) || { total: 0, count: 0 };
      const transfersCount = transferMap.get(key) || 0;

      last30Days.push({
        date: formatDateKey(currentDate),
        clients: clientMap.get(key) || 0,
        deposits: deposits.total,
        withdrawals: withdrawals.total,
        transactions: deposits.count + withdrawals.count + transfersCount,
        ibPartners: ibMap.get(key) || 0,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    await cacheService.set(cacheKey, last30Days, CACHE_TTL.DAILY_STATS);
    res.status(200).json({ success: true, data: last30Days });
  } catch (error) {
    next(error);
  }
};
exports.getTopPerformingClients = async (req, res, next) => {
  const limit = parseInt(req.query.limit) || 10;
  const cacheKey = cacheService.generateKey(CACHE_KEYS.TOP_CLIENTS(limit), {});

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const topClients = await Deposit.aggregate([
      { $match: { status: "Approved" } },
      {
        $group: {
          _id: "$user",
          totalDeposited: { $sum: "$amount" },
          depositCount: { $sum: 1 },
        },
      },
      { $sort: { totalDeposited: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
          pipeline: [
            { $project: { firstName: 1, lastName: 1, email: 1, createdAt: 1 } },
          ],
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "accounts",
          localField: "_id",
          foreignField: "user",
          as: "accounts",
          pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
        },
      },
      {
        $project: {
          _id: 1,
          totalDeposited: 1,
          depositCount: 1,
          user: 1,
          accountsCount: { $size: "$accounts" },
        },
      },
    ]);

    await cacheService.set(cacheKey, topClients, CACHE_TTL.TOP_CLIENTS);
    res.status(200).json({ success: true, data: topClients });
  } catch (error) {
    next(error);
  }
};
exports.getTodayPerformance = async (req, res, next) => {
  const cacheKey = CACHE_KEYS.TODAY_PERFORMANCE;

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const today = new Date();
    const startOfDay = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const endOfDay = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
    );

    const [
      todayDepositsResult,
      todayWithdrawalsResult,
      todayTransfersCount,
      todayNewClients,
      todayNewIBPartners,
    ] = await Promise.all([
      Deposit.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startOfDay, $lt: endOfDay },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
        },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            status: "Approved",
            approvedDate: { $gte: startOfDay, $lt: endOfDay },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
        },
      ]),
      Transfer.countDocuments({
        createdAt: { $gte: startOfDay, $lt: endOfDay },
      }),
      User.countDocuments({
        role: "client",
        createdAt: { $gte: startOfDay, $lt: endOfDay },
      }),
      IBClientConfiguration.countDocuments({
        status: "active",
        createdAt: { $gte: startOfDay, $lt: endOfDay },
      }),
    ]);

    const todayDeposits = todayDepositsResult[0] || { total: 0, count: 0 };
    const todayWithdrawals = todayWithdrawalsResult[0] || {
      total: 0,
      count: 0,
    };

    const result = {
      deposits: {
        amount: todayDeposits.total,
        count: todayDeposits.count,
      },
      withdrawals: {
        amount: todayWithdrawals.total,
        count: todayWithdrawals.count,
      },
      transactions:
        todayDeposits.count + todayWithdrawals.count + todayTransfersCount,
      newClients: todayNewClients,
      ibPartners: todayNewIBPartners,
      date: startOfDay.toISOString(),
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.TODAY_PERFORMANCE);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getClientDeviceSessionsOverview = async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  const cacheKey = cacheService.generateKey(CACHE_KEYS.DEVICE_SESSIONS(limit), {});

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached });
  }

  try {
    const sessions = await getLatestClientSessionsOverview(limit);

    const data = sessions.map((session) => ({
        ...buildSessionSummary(session),
        user: {
          id: session.user._id,
          firstName: session.user.firstName,
          lastName: session.user.lastName,
          email: session.user.email,
          role: session.user.role,
        },
      }));

    await cacheService.set(cacheKey, data, CACHE_TTL.DEVICE_SESSIONS);

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
// Aggregates the warm per-user open-trade cache that
// mt5TradeWebSocketService maintains (services/mt5TradeWebSocketService.js)
// into a broker-level snapshot: total floating P&L, net long/short exposure
// per symbol, and the largest open positions. Deliberately reads the
// *existing* live cache instead of hitting the MT5 bridge itself — that
// cache is intentionally scoped to users currently connected to our
// Socket.IO (see mt5AccountWebSocketService.setUserOnline/setUserOffline),
// not every client in the system, so this is a live view of currently
// logged-in traders' exposure, not a full-book snapshot. The frontend
// surfaces that scope explicitly rather than implying broker-wide coverage
// it doesn't have.
exports.getRiskExposure = async (req, res, next) => {
  try {
    const entries = cacheService.entriesWithPrefix("trading:open-live:");
    const KEY_PREFIX = "trading:open-live:";

    let totalFloatingPL = 0;
    let openPositions = 0;
    let lastUpdated = 0;
    let activeTraders = 0;
    const bySymbol = new Map(); // symbol -> { longLots, shortLots, pl, positions }
    const byUser = []; // { userId, totalPL, trades: [...] } - resolved to names below

    for (const { key, value } of entries) {
      if (!value || !Array.isArray(value.trades) || value.trades.length === 0) {
        continue;
      }

      if (value.updatedAt) lastUpdated = Math.max(lastUpdated, value.updatedAt);
      activeTraders += 1;

      const userId = key.slice(KEY_PREFIX.length);
      let userTotalPL = 0;
      const userTrades = [];

      for (const trade of value.trades) {
        const profit = Number(trade.profit) || 0;
        const lots = Number(trade.lotSize) || 0;
        const symbol = trade.symbol || "N/A";
        const isBuy = (trade.tradeType || "").toLowerCase() === "buy";

        openPositions += 1;
        totalFloatingPL += profit;
        userTotalPL += profit;
        userTrades.push({
          symbol,
          direction: isBuy ? "buy" : "sell",
          lots: Number(lots.toFixed(2)),
          profit: Number(profit.toFixed(2)),
          account: trade.account || null,
        });

        if (!bySymbol.has(symbol)) {
          bySymbol.set(symbol, { longLots: 0, shortLots: 0, pl: 0, positions: 0 });
        }
        const bucket = bySymbol.get(symbol);
        bucket.pl += profit;
        bucket.positions += 1;
        if (isBuy) bucket.longLots += lots;
        else bucket.shortLots += lots;
      }

      byUser.push({
        userId,
        totalPL: Number(userTotalPL.toFixed(2)),
        positionCount: userTrades.length,
        trades: userTrades.sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit)),
      });
    }

    const symbolExposure = Array.from(bySymbol.entries())
      .map(([symbol, bucket]) => ({
        symbol,
        longLots: Number(bucket.longLots.toFixed(2)),
        shortLots: Number(bucket.shortLots.toFixed(2)),
        netLots: Number((bucket.longLots - bucket.shortLots).toFixed(2)),
        pl: Number(bucket.pl.toFixed(2)),
        positions: bucket.positions,
      }))
      .sort((a, b) => Math.abs(b.netLots) - Math.abs(a.netLots))
      .slice(0, 10);

    // Biggest exposure first (winners and losers both matter to an admin
    // scanning for risk), capped so the payload stays bounded regardless of
    // how many clients happen to be actively watching trades at once.
    const topTraders = byUser
      .sort((a, b) => Math.abs(b.totalPL) - Math.abs(a.totalPL))
      .slice(0, 20);

    const traderUserIds = topTraders.map((t) => t.userId).filter(Boolean);
    const users = traderUserIds.length
      ? await User.find({ _id: { $in: traderUserIds } })
          .select("firstName lastName email")
          .lean()
      : [];
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const traderPositions = topTraders.map((t) => {
      const user = userById.get(t.userId);
      return {
        userId: t.userId,
        name: user
          ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown"
          : "Unknown client",
        email: user?.email || null,
        totalPL: t.totalPL,
        positionCount: t.positionCount,
        trades: t.trades,
      };
    });

    const thresholds = await getRiskThresholds();
    const alerts = [];
    if (thresholds.enabled) {
      if (
        thresholds.maxFloatingLossUsd > 0 &&
        totalFloatingPL <= -thresholds.maxFloatingLossUsd
      ) {
        alerts.push({
          severity: "critical",
          message: `Total floating loss (${totalFloatingPL.toFixed(2)}) has exceeded your configured limit of -$${thresholds.maxFloatingLossUsd}.`,
        });
      }
      for (const row of symbolExposure) {
        if (
          thresholds.maxSymbolNetLots > 0 &&
          Math.abs(row.netLots) > thresholds.maxSymbolNetLots
        ) {
          alerts.push({
            severity: "warning",
            message: `${row.symbol} net exposure (${row.netLots} lots) exceeds your configured limit of ${thresholds.maxSymbolNetLots} lots.`,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        totalFloatingPL: Number(totalFloatingPL.toFixed(2)),
        openPositions,
        activeTraders,
        symbolExposure,
        traderPositions,
        alerts,
        thresholds,
        lastUpdated: lastUpdated || null,
        scope: "active-traders", // see comment above - not a full-book figure
      },
    });
  } catch (error) {
    next(error);
  }
};

const DEFAULT_RISK_THRESHOLDS = {
  enabled: false,
  maxFloatingLossUsd: 5000,
  maxSymbolNetLots: 50,
};

const getRiskThresholds = async () => {
  const settings = await AppSetting.findOne().select("riskThresholds").lean();
  const stored = settings?.riskThresholds || {};
  return { ...DEFAULT_RISK_THRESHOLDS, ...stored };
};

exports.getRiskThresholdsConfig = async (req, res, next) => {
  try {
    const thresholds = await getRiskThresholds();
    res.status(200).json({ success: true, data: thresholds });
  } catch (error) {
    next(error);
  }
};

exports.updateRiskThresholdsConfig = async (req, res, next) => {
  try {
    const { enabled, maxFloatingLossUsd, maxSymbolNetLots } = req.body || {};

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "enabled must be a boolean",
      });
    }
    if (
      maxFloatingLossUsd !== undefined &&
      (typeof maxFloatingLossUsd !== "number" || maxFloatingLossUsd < 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "maxFloatingLossUsd must be a non-negative number",
      });
    }
    if (
      maxSymbolNetLots !== undefined &&
      (typeof maxSymbolNetLots !== "number" || maxSymbolNetLots < 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "maxSymbolNetLots must be a non-negative number",
      });
    }

    let settings = await AppSetting.findOne();
    if (!settings) {
      settings = await AppSetting.create({});
    }
    if (!settings.riskThresholds) {
      settings.riskThresholds = {};
    }

    if (enabled !== undefined) settings.riskThresholds.enabled = enabled;
    if (maxFloatingLossUsd !== undefined) {
      settings.riskThresholds.maxFloatingLossUsd = maxFloatingLossUsd;
    }
    if (maxSymbolNetLots !== undefined) {
      settings.riskThresholds.maxSymbolNetLots = maxSymbolNetLots;
    }

    await settings.save();

    res.status(200).json({
      success: true,
      data: { ...DEFAULT_RISK_THRESHOLDS, ...settings.riskThresholds.toObject() },
    });
  } catch (error) {
    next(error);
  }
};

exports.invalidateDashboardCache = async () => {
  const patterns = [
    CACHE_KEYS.DASHBOARD_STATS,
    CACHE_KEYS.REVENUE_CHART("*"),
    CACHE_KEYS.CLIENT_DISTRIBUTION,
    CACHE_KEYS.RECENT_TRANSACTIONS("*"),
    CACHE_KEYS.DAILY_STATS,
    CACHE_KEYS.TOP_CLIENTS("*"),
    CACHE_KEYS.TODAY_PERFORMANCE,
    CACHE_KEYS.DEVICE_SESSIONS("*"),
  ];

  for (const pattern of patterns) {
    await cacheService.deletePattern(pattern);
  }
  console.log("🗑️ Dashboard cache invalidated");
};

// Backend/controllers/admin/revenueAnalyticsController.js - FULLY OPTIMIZED
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const IBCommission = require("../../models/IBCommission");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const cacheService = require("../../services/cacheService");

// Cache keys
const CACHE_KEYS = {
  REVENUE_ANALYTICS: (days) => `admin:revenue:analytics:${days}`,
  REVENUE_TIMESERIES: (days, granularity) =>
    `admin:revenue:timeseries:${days}:${granularity}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  REVENUE_ANALYTICS: 300, // 5 minutes - revenue data doesn't change rapidly
  REVENUE_TIMESERIES: 600, // 10 minutes - historical data
};

// Valid days values
const VALID_DAYS = [7, 14, 30, 60, 90];

const calculateGrowth = (current, previous) => {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? 100 : 0;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
};
/**
 * @desc    Get revenue analytics data with time-based filtering
 * @route   GET /api/admin/revenue-analytics?days=30
 * @access  Private (Admin/SuperAdmin)
 */
exports.getRevenueAnalytics = async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days);

    // Validate days parameter
    if (!VALID_DAYS.includes(daysNum)) {
      return res.status(400).json({
        success: false,
        message: `Invalid days parameter. Allowed values: ${VALID_DAYS.join(", ")}`,
      });
    }

    const cacheKey = CACHE_KEYS.REVENUE_ANALYTICS(daysNum);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        period: cached.period,
        data: cached.data,
        fromCache: true,
      });
    }

    // Calculate date ranges
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const previousPeriodStart = new Date(startDate);
    previousPeriodStart.setDate(previousPeriodStart.getDate() - daysNum);
    const previousPeriodEnd = new Date(startDate);

    const [
      depositStatsResult,
      withdrawalStatsResult,
      currentIbCommissionStats,
      ibPartnerStats,
    ] = await Promise.all([
      Deposit.aggregate([
        {
          $group: {
            _id: null,
            currentTotal: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", startDate] },
                      { $lte: ["$approvedDate", endDate] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            currentCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", startDate] },
                      { $lte: ["$approvedDate", endDate] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            previousTotal: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", previousPeriodStart] },
                      { $lt: ["$approvedDate", previousPeriodEnd] },
                    ],
                  },
                  "$amount",
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
            currentTotal: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", startDate] },
                      { $lte: ["$approvedDate", endDate] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            currentCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", startDate] },
                      { $lte: ["$approvedDate", endDate] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            previousTotal: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "Approved"] },
                      { $gte: ["$approvedDate", previousPeriodStart] },
                      { $lt: ["$approvedDate", previousPeriodEnd] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
          },
        },
      ]),
      IBCommission.aggregate([
        {
          $match: {
            status: { $in: ["confirmed", "paid"] },
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: null,
            totalCommission: { $sum: "$commissionAmount" },
            totalVolume: { $sum: "$volume" },
            count: { $sum: 1 },
          },
        },
      ]),
      IBClientConfiguration.aggregate([
        {
          $group: {
            _id: null,
            active: {
              $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    // Extract values with safe defaults
    const deposits = depositStatsResult[0] || {
      currentTotal: 0,
      currentCount: 0,
      previousTotal: 0,
    };
    const withdrawals = withdrawalStatsResult[0] || {
      currentTotal: 0,
      currentCount: 0,
      previousTotal: 0,
    };
    const ibCommissionStats = currentIbCommissionStats[0] || {
      totalCommission: 0,
      totalVolume: 0,
      count: 0,
    };
    const activeIBPartners = ibPartnerStats[0]?.active || 0;
    const netRevenue = deposits.currentTotal - withdrawals.currentTotal;
    const prevNetRevenue = deposits.previousTotal - withdrawals.previousTotal;

    const response = {
      success: true,
      period: {
        days: daysNum,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      data: {
        deposits: {
          total: deposits.currentTotal,
          count: deposits.currentCount,
          growth: calculateGrowth(deposits.currentTotal, deposits.previousTotal),
        },
        withdrawals: {
          total: withdrawals.currentTotal,
          count: withdrawals.currentCount,
          growth: calculateGrowth(
            withdrawals.currentTotal,
            withdrawals.previousTotal,
          ),
        },
        netRevenue: {
          total: netRevenue,
          growth: calculateGrowth(netRevenue, prevNetRevenue),
        },
        ibCommission: {
          total: ibCommissionStats.totalCommission,
          count: ibCommissionStats.count,
        },
        ibPartners: {
          active: activeIBPartners,
        },
        ibTradingVolume: {
          total: ibCommissionStats.totalVolume,
        },
      },
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.REVENUE_ANALYTICS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
/**
 * @desc    Get time-series data for charts (daily/weekly breakdown)
 * @route   GET /api/admin/revenue-analytics/timeseries?days=30&granularity=daily
 * @access  Private (Admin/SuperAdmin)
 */
exports.getRevenueTimeSeries = async (req, res, next) => {
  try {
    const { days = 30, granularity = "daily" } = req.query;
    const daysNum = parseInt(days);

    // Validate parameters
    if (!VALID_DAYS.includes(daysNum)) {
      return res.status(400).json({
        success: false,
        message: `Invalid days parameter. Allowed values: ${VALID_DAYS.join(", ")}`,
      });
    }

    if (!["daily", "weekly"].includes(granularity)) {
      return res.status(400).json({
        success: false,
        message: "Invalid granularity. Allowed values: daily, weekly",
      });
    }

    const cacheKey = CACHE_KEYS.REVENUE_TIMESERIES(daysNum, granularity);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        period: cached.period,
        data: cached.data,
        fromCache: true,
      });
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    let timeSeriesData = [];

    if (granularity === "daily") {
      timeSeriesData = await getDailyTimeSeries(startDate, endDate, daysNum);
    } else {
      timeSeriesData = await getWeeklyTimeSeries(startDate, endDate, daysNum);
    }

    const response = {
      success: true,
      period: {
        days: daysNum,
        granularity,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      data: timeSeriesData,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.REVENUE_TIMESERIES);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
/**
 * Get daily time series data - OPTIMIZED with single aggregation
 */
async function getDailyTimeSeries(startDate, endDate, daysNum) {
  // Create date range array for lookup
  const dateRange = [];
  const currentDate = new Date(startDate);
  for (let i = 0; i < daysNum; i++) {
    dateRange.push({
      date: new Date(currentDate),
      dateStr: currentDate.toISOString().split("T")[0],
      dayName: currentDate.toLocaleDateString("en-US", { weekday: "short" }),
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Get all deposits in one aggregation
  const depositsByDay = await Deposit.aggregate([
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
      },
    },
  ]);

  // Get all withdrawals in one aggregation
  const withdrawalsByDay = await Withdrawal.aggregate([
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
      },
    },
  ]);

  // Create maps for O(1) lookup
  const depositsMap = new Map();
  depositsByDay.forEach((d) => {
    const key = `${d._id.year}-${d._id.month}-${d._id.day}`;
    depositsMap.set(key, d.total);
  });

  const withdrawalsMap = new Map();
  withdrawalsByDay.forEach((w) => {
    const key = `${w._id.year}-${w._id.month}-${w._id.day}`;
    withdrawalsMap.set(key, w.total);
  });

  // Build time series data
  return dateRange.map((item) => {
    const key = `${item.date.getFullYear()}-${item.date.getMonth() + 1}-${item.date.getDate()}`;
    const deposits = depositsMap.get(key) || 0;
    const withdrawals = withdrawalsMap.get(key) || 0;

    return {
      date: item.dateStr,
      day: item.dayName,
      deposits,
      withdrawals,
      revenue: deposits - withdrawals,
    };
  });
}

/**
 * Get weekly time series data - OPTIMIZED with single aggregation
 */
async function getWeeklyTimeSeries(startDate, endDate, daysNum) {
  const weeksCount = Math.ceil(daysNum / 7);
  const weeks = [];

  // Build week ranges
  for (let i = 0; i < weeksCount; i++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + i * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // Cap at endDate
    if (weekEnd > endDate) {
      weekEnd.setTime(endDate.getTime());
    }

    weeks.push({
      index: i,
      start: weekStart,
      end: weekEnd,
      startStr: weekStart.toISOString().split("T")[0],
      endStr: weekEnd.toISOString().split("T")[0],
    });
  }

  // Get all deposits in one aggregation with week grouping
  const depositsByWeek = await Deposit.aggregate([
    {
      $match: {
        status: "Approved",
        approvedDate: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: {
          week: { $floor: { $divide: [{ $dayOfYear: "$approvedDate" }, 7] } },
          year: { $year: "$approvedDate" },
        },
        total: { $sum: "$amount" },
      },
    },
  ]);

  // Get all withdrawals in one aggregation with week grouping
  const withdrawalsByWeek = await Withdrawal.aggregate([
    {
      $match: {
        status: "Approved",
        approvedDate: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: {
          week: { $floor: { $divide: [{ $dayOfYear: "$approvedDate" }, 7] } },
          year: { $year: "$approvedDate" },
        },
        total: { $sum: "$amount" },
      },
    },
  ]);

  // Create maps
  const depositsMap = new Map();
  depositsByWeek.forEach((d) => {
    const key = `${d._id.year}-${d._id.week}`;
    depositsMap.set(key, d.total);
  });

  const withdrawalsMap = new Map();
  withdrawalsByWeek.forEach((w) => {
    const key = `${w._id.year}-${w._id.week}`;
    withdrawalsMap.set(key, w.total);
  });

  // Build weekly data
  return weeks.map((week) => {
    // Calculate week number for key matching
    const weekNumber = Math.floor(
      (week.start.getTime() -
        new Date(week.start.getFullYear(), 0, 1).getTime()) /
        (7 * 24 * 60 * 60 * 1000),
    );
    const key = `${week.start.getFullYear()}-${weekNumber}`;

    const deposits = depositsMap.get(key) || 0;
    const withdrawals = withdrawalsMap.get(key) || 0;

    return {
      name: `Week ${week.index + 1}`,
      startDate: week.startStr,
      endDate: week.endStr,
      deposits,
      withdrawals,
      revenue: deposits - withdrawals,
    };
  });
}
/**
 * @desc    Get revenue summary for dashboard (lightweight version)
 * @route   GET /api/admin/revenue-analytics/summary
 * @access  Private (Admin/SuperAdmin)
 */
exports.getRevenueSummary = async (req, res, next) => {
  try {
    const cacheKey = "admin:revenue:summary";

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const startOfToday = new Date(today);
    startOfToday.setHours(0, 0, 0, 0);

    const [summaryData] = await Deposit.aggregate([
      {
        $group: {
          _id: null,
          today: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "Approved"] },
                    { $gte: ["$approvedDate", startOfToday] },
                  ],
                },
                "$amount",
                0,
              ],
            },
          },
          thisMonth: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "Approved"] },
                    { $gte: ["$approvedDate", startOfMonth] },
                  ],
                },
                "$amount",
                0,
              ],
            },
          },
          thisYear: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "Approved"] },
                    { $gte: ["$approvedDate", startOfYear] },
                  ],
                },
                "$amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const response = {
      today: summaryData?.today || 0,
      thisMonth: summaryData?.thisMonth || 0,
      thisYear: summaryData?.thisYear || 0,
    };

    await cacheService.set(cacheKey, response, 60); // 1 minute cache

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Invalidate all revenue analytics caches
 * Call this when deposits/withdrawals/IB commissions change
 */
exports.invalidateRevenueCaches = async () => {
  await Promise.all([
    cacheService.deletePattern("admin:revenue:analytics:*"),
    cacheService.deletePattern("admin:revenue:timeseries:*"),
    cacheService.deletePattern("admin:revenue:summary"),
  ]);
  console.log("🗑️ Revenue analytics caches invalidated");
};

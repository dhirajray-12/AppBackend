// Backend/controllers/client/dailyPerformanceController.js - FULLY OPTIMIZED
const User = require("../../models/User");
const Account = require("../../models/client/Account");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const IBClosedTrades = require("../../models/IBClosedTrade");
const mongoose = require("mongoose");
const cacheService = require("../../services/cacheService");
const {
  getConfiguredTimezone,
  formatDateForDisplay,
} = require("../../utils/timezoneUtils");

// Cache keys
const CACHE_KEYS = {
  DAILY_PERFORMANCE: (userId, days) =>
    `client:daily:performance:${userId}:${days}`,
  TODAY_PERFORMANCE: (userId) => `client:daily:today:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  DAILY_PERFORMANCE: 300, // 5 minutes - historical data
  TODAY_PERFORMANCE: 30, // 30 seconds - near real-time
};

// Valid days options
const VALID_DAYS = [7, 14, 30, 60, 90];

const getUserTradingAccounts = async (userId) => {
  const cacheKey = `client:daily:accounts:${userId}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  const accounts = await Account.find({ user: userId })
    .select("_id mt5Account")
    .lean();

  await cacheService.set(cacheKey, accounts, 300);
  return accounts;
};

/**
 * Get daily performance trends data for the last X days - OPTIMIZED
 */
const getDailyPerformanceTrends = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { days = 30 } = req.query;
    const daysNum = parseInt(days);

    // Validate days parameter
    if (!VALID_DAYS.includes(daysNum)) {
      return res.status(400).json({
        success: false,
        message: `Invalid days parameter. Allowed values: ${VALID_DAYS.join(", ")}`,
      });
    }

    const cacheKey = CACHE_KEYS.DAILY_PERFORMANCE(userId, daysNum);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Calculate date ranges
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - daysNum);

    const previousStartDate = new Date(startDate);
    previousStartDate.setDate(previousStartDate.getDate() - daysNum);
    const previousEndDate = new Date(startDate);

    // Get user accounts
    const userAccounts = await getUserTradingAccounts(userId);

    const accountIds = userAccounts.map((account) => account._id);
    const mt5Accounts = userAccounts.map((account) => account.mt5Account);

    if (userAccounts.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          chartData: [],
          summary: {
            totalDeposits: 0,
            totalWithdrawals: 0,
            totalTransactions: 0,
            totalTradingPnL: 0,
            totalNewClients: 0,
            totalIBPartners: 0,
            depositsCount: 0,
            withdrawalsCount: 0,
            totalTrades: 0,
          },
          changes: {
            deposits: 0,
            withdrawals: 0,
            transactions: 0,
            tradingPnL: 0,
            newClients: 0,
            ibPartners: 0,
          },
          period: `${daysNum} days`,
          dateRange: {
            start: startDate.toISOString(),
            end: endDate.toISOString(),
          },
        },
      });
    }

    // OPTIMIZED: Run all aggregations in parallel
    const [
      depositsData,
      withdrawalsData,
      transactionsData,
      tradingData,
      newAccountsData,
      previousDeposits,
      previousWithdrawals,
      previousTransactions,
      previousTrading,
    ] = await Promise.all([
      // Deposits by day
      Deposit.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$approvedDate" },
            },
            amount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Withdrawals by day
      Withdrawal.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$approvedDate" },
            },
            amount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Transfers by day
      Transfer.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            $or: [
              { fromAccount: { $in: accountIds } },
              { toAccount: { $in: accountIds } },
            ],
            status: "Completed",
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Trading P&L by day
      IBClosedTrades.aggregate([
        {
          $match: {
            mt5Account: { $in: mt5Accounts },
            closeTime: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$closeTime" } },
            profit: { $sum: "$profit" },
            commission: { $sum: "$commission" },
            swap: { $sum: "$swap" },
            trades: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // New accounts by day
      Account.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Previous period deposits
      Deposit.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: previousStartDate, $lt: previousEndDate },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Previous period withdrawals
      Withdrawal.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: previousStartDate, $lt: previousEndDate },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Previous period transactions
      Transfer.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            $or: [
              { fromAccount: { $in: accountIds } },
              { toAccount: { $in: accountIds } },
            ],
            status: "Completed",
            createdAt: { $gte: previousStartDate, $lt: previousEndDate },
          },
        },
        { $group: { _id: null, count: { $sum: 1 } } },
      ]),

      // Previous period trading
      IBClosedTrades.aggregate([
        {
          $match: {
            mt5Account: { $in: mt5Accounts },
            closeTime: { $gte: previousStartDate, $lt: previousEndDate },
          },
        },
        {
          $group: {
            _id: null,
            profit: { $sum: "$profit" },
            commission: { $sum: "$commission" },
            swap: { $sum: "$swap" },
          },
        },
      ]),
    ]);

    // Create maps for O(1) lookup
    const depositsMap = new Map(depositsData.map((d) => [d._id, d]));
    const withdrawalsMap = new Map(withdrawalsData.map((d) => [d._id, d]));
    const transactionsMap = new Map(transactionsData.map((d) => [d._id, d]));
    const tradingMap = new Map(tradingData.map((d) => [d._id, d]));
    const newAccountsMap = new Map(newAccountsData.map((d) => [d._id, d]));

    // Generate date series efficiently
    const dateSeries = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      dateSeries.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Build chart data
    const chartTimezone = await getConfiguredTimezone();
    const chartData = dateSeries.map((date) => {
      const dateStr = date.toISOString().split("T")[0];
      const deposits = depositsMap.get(dateStr) || { amount: 0, count: 0 };
      const withdrawals = withdrawalsMap.get(dateStr) || {
        amount: 0,
        count: 0,
      };
      const transactions = transactionsMap.get(dateStr) || { count: 0 };
      const trading = tradingMap.get(dateStr) || {
        profit: 0,
        commission: 0,
        swap: 0,
        trades: 0,
      };
      const newAccounts = newAccountsMap.get(dateStr) || { count: 0 };

      return {
        date: dateStr,
        formattedDate: formatDateForDisplay(date, chartTimezone, {
          month: "short",
          day: "numeric",
          hour: undefined,
          minute: undefined,
          hour12: undefined,
        }),
        deposits: parseFloat(deposits.amount.toFixed(2)),
        withdrawals: parseFloat(withdrawals.amount.toFixed(2)),
        transactions: transactions.count,
        tradingPnL: parseFloat(
          (trading.profit + trading.commission + trading.swap).toFixed(2),
        ),
        newClients: newAccounts.count,
        ibPartners: 0,
        depositsCount: deposits.count,
        withdrawalsCount: withdrawals.count,
        tradesCount: trading.trades,
      };
    });

    // Calculate summary totals
    const summary = {
      totalDeposits: depositsData.reduce((sum, d) => sum + d.amount, 0),
      totalWithdrawals: withdrawalsData.reduce((sum, d) => sum + d.amount, 0),
      totalTransactions: transactionsData.reduce((sum, d) => sum + d.count, 0),
      totalTradingPnL: tradingData.reduce(
        (sum, d) => sum + d.profit + d.commission + d.swap,
        0,
      ),
      totalNewClients: newAccountsData.reduce((sum, d) => sum + d.count, 0),
      totalIBPartners: 0,
      depositsCount: depositsData.reduce((sum, d) => sum + d.count, 0),
      withdrawalsCount: withdrawalsData.reduce((sum, d) => sum + d.count, 0),
      totalTrades: tradingData.reduce((sum, d) => sum + d.trades, 0),
    };

    // Calculate percentage changes
    const prevDeposits = previousDeposits[0]?.total || 0;
    const prevWithdrawals = previousWithdrawals[0]?.total || 0;
    const prevTransactions = previousTransactions[0]?.count || 0;
    const prevTrading = previousTrading[0]
      ? previousTrading[0].profit +
        previousTrading[0].commission +
        previousTrading[0].swap
      : 0;

    const calculateChange = (current, previous) => {
      if (previous === 0 && current === 0) return 0;
      if (previous === 0) return current > 0 ? 100 : 0;
      return parseFloat((((current - previous) / previous) * 100).toFixed(1));
    };

    const changes = {
      deposits: calculateChange(summary.totalDeposits, prevDeposits),
      withdrawals: calculateChange(summary.totalWithdrawals, prevWithdrawals),
      transactions: calculateChange(
        summary.totalTransactions,
        prevTransactions,
      ),
      tradingPnL: calculateChange(summary.totalTradingPnL, prevTrading),
      newClients: 0,
      ibPartners: 0,
    };

    const result = {
      chartData,
      summary,
      changes,
      period: `${daysNum} days`,
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.DAILY_PERFORMANCE);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get real-time performance summary for today - OPTIMIZED
 */
const getTodayPerformance = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.TODAY_PERFORMANCE(userId);

    // Try to get from cache (short TTL for near real-time)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Get today's date range
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

    // Get user accounts
    const userAccounts = await getUserTradingAccounts(userId);

    const accountIds = userAccounts.map((account) => account._id);
    const mt5Accounts = userAccounts.map((account) => account.mt5Account);

    if (userAccounts.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          today: {
            deposits: 0,
            withdrawals: 0,
            transactions: 0,
            tradingPnL: 0,
            trades: 0,
            depositsCount: 0,
            withdrawalsCount: 0,
          },
          date: today.toISOString().split("T")[0],
        },
      });
    }

    // OPTIMIZED: Run all queries in parallel
    const [todayDeposits, todayWithdrawals, todayTransfers, todayTrades] =
      await Promise.all([
        Deposit.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startOfDay, $lt: endOfDay },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Withdrawal.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startOfDay, $lt: endOfDay },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Transfer.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              $or: [
                { fromAccount: { $in: accountIds } },
                { toAccount: { $in: accountIds } },
              ],
              status: "Completed",
              createdAt: { $gte: startOfDay, $lt: endOfDay },
            },
          },
          { $group: { _id: null, count: { $sum: 1 } } },
        ]),
        IBClosedTrades.aggregate([
          {
            $match: {
              mt5Account: { $in: mt5Accounts },
              closeTime: { $gte: startOfDay, $lt: endOfDay },
            },
          },
          {
            $group: {
              _id: null,
              profit: { $sum: "$profit" },
              commission: { $sum: "$commission" },
              swap: { $sum: "$swap" },
              trades: { $sum: 1 },
            },
          },
        ]),
      ]);

    const todaySummary = {
      deposits: todayDeposits[0]?.total || 0,
      withdrawals: todayWithdrawals[0]?.total || 0,
      transactions: todayTransfers[0]?.count || 0,
      tradingPnL: todayTrades[0]
        ? todayTrades[0].profit +
          todayTrades[0].commission +
          todayTrades[0].swap
        : 0,
      trades: todayTrades[0]?.trades || 0,
      depositsCount: todayDeposits[0]?.count || 0,
      withdrawalsCount: todayWithdrawals[0]?.count || 0,
    };

    const result = {
      today: todaySummary,
      date: today.toISOString().split("T")[0],
    };

    // Cache with short TTL
    await cacheService.set(cacheKey, result, CACHE_TTL.TODAY_PERFORMANCE);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Get weekly performance summary (optimized for dashboard)
 */
const getWeeklyPerformance = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `client:daily:weekly:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 7);

    const userAccounts = await getUserTradingAccounts(userId);
    const accountIds = userAccounts.map((account) => account._id);
    const mt5Accounts = userAccounts.map((account) => account.mt5Account);

    const [weeklyDeposits, weeklyWithdrawals, weeklyTrading] =
      await Promise.all([
        Deposit.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        Withdrawal.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        IBClosedTrades.aggregate([
          {
            $match: {
              mt5Account: { $in: mt5Accounts },
              closeTime: { $gte: startDate, $lte: endDate },
            },
          },
          {
            $group: {
              _id: null,
              profit: { $sum: "$profit" },
              commission: { $sum: "$commission" },
              swap: { $sum: "$swap" },
            },
          },
        ]),
      ]);

    const result = {
      deposits: weeklyDeposits[0]?.total || 0,
      withdrawals: weeklyWithdrawals[0]?.total || 0,
      netFlow:
        (weeklyDeposits[0]?.total || 0) - (weeklyWithdrawals[0]?.total || 0),
      tradingPnL: weeklyTrading[0]
        ? weeklyTrading[0].profit +
          weeklyTrading[0].commission +
          weeklyTrading[0].swap
        : 0,
      period: {
        start: startDate.toISOString().split("T")[0],
        end: endDate.toISOString().split("T")[0],
      },
    };

    await cacheService.set(cacheKey, result, 600); // 10 minutes cache

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get monthly performance summary
 */
const getMonthlyPerformance = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `client:daily:monthly:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    const userAccounts = await getUserTradingAccounts(userId);
    const accountIds = userAccounts.map((account) => account._id);
    const mt5Accounts = userAccounts.map((account) => account.mt5Account);

    const [monthlyDeposits, monthlyWithdrawals, monthlyTrading] =
      await Promise.all([
        Deposit.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        Withdrawal.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        IBClosedTrades.aggregate([
          {
            $match: {
              mt5Account: { $in: mt5Accounts },
              closeTime: { $gte: startDate, $lte: endDate },
            },
          },
          {
            $group: {
              _id: null,
              profit: { $sum: "$profit" },
              commission: { $sum: "$commission" },
              swap: { $sum: "$swap" },
            },
          },
        ]),
      ]);

    const result = {
      deposits: monthlyDeposits[0]?.total || 0,
      withdrawals: monthlyWithdrawals[0]?.total || 0,
      netFlow:
        (monthlyDeposits[0]?.total || 0) - (monthlyWithdrawals[0]?.total || 0),
      tradingPnL: monthlyTrading[0]
        ? monthlyTrading[0].profit +
          monthlyTrading[0].commission +
          monthlyTrading[0].swap
        : 0,
      month: formatDateForDisplay(startDate, await getConfiguredTimezone(), {
        month: "long",
        year: "numeric",
        hour: undefined,
        minute: undefined,
        hour12: undefined,
      }),
    };

    await cacheService.set(cacheKey, result, 1800); // 30 minutes cache

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Invalidate daily performance caches for a user
 */
const invalidateDailyPerformanceCaches = async (userId) => {
  const patterns = [
    `client:daily:performance:${userId}:*`,
    `client:daily:today:${userId}`,
    `client:daily:weekly:${userId}`,
    `client:daily:monthly:${userId}`,
    `client:daily:accounts:${userId}`,
  ];

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Daily performance caches invalidated for user: ${userId}`);
};

// Export cache invalidation function
module.exports = {
  getDailyPerformanceTrends,
  getTodayPerformance,
  getWeeklyPerformance,
  getMonthlyPerformance,
  invalidateDailyPerformanceCaches,
};

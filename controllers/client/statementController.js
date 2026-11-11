const Account = require("../../models/client/Account");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const User = require("../../models/User");
const mongoose = require("mongoose");
const cacheService = require("../../services/cacheService");

// Cache keys
const CACHE_KEYS = {
  ACCOUNT_STATEMENT: (userId, accountId, startDate, endDate) =>
    `statement:account:${userId}:${accountId}:${startDate}:${endDate}`,
  CONSOLIDATED: (userId, startDate, endDate) =>
    `statement:consolidated:${userId}:${startDate}:${endDate}`,
  MONTHLY_SUMMARY: (userId, year, month) =>
    `statement:monthly:${userId}:${year}:${month}`,
  YTD_SUMMARY: (userId, year) => `statement:ytd:${userId}:${year}`,
  TRANSACTION_HISTORY: (userId, filters) =>
    `statement:history:${userId}:${JSON.stringify(filters)}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ACCOUNT_STATEMENT: 300, // 5 minutes
  CONSOLIDATED: 300, // 5 minutes
  MONTHLY_SUMMARY: 600, // 10 minutes
  YTD_SUMMARY: 600, // 10 minutes
  TRANSACTION_HISTORY: 60, // 1 minute
};

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
};

const getUserAccountsLite = async (userId, select = "_id") =>
  Account.find({ user: userId }).select(select).lean();

const buildDateFilter = (startDate, endDate, field = "createdAt") => {
  const dateFilter = {};

  if (startDate) {
    dateFilter[field] = {
      ...dateFilter[field],
      $gte: new Date(startDate),
    };
  }

  if (endDate) {
    dateFilter[field] = {
      ...dateFilter[field],
      $lte: new Date(endDate),
    };
  }

  return dateFilter;
};

const buildAmountFilter = (minAmount, maxAmount) => {
  const amountFilter = {};

  if (minAmount !== undefined) {
    amountFilter.amount = {
      ...amountFilter.amount,
      $gte: parseFloat(minAmount),
    };
  }

  if (maxAmount !== undefined) {
    amountFilter.amount = {
      ...amountFilter.amount,
      $lte: parseFloat(maxAmount),
    };
  }

  return amountFilter;
};

const buildStatusFilter = (status) =>
  status && status !== "all" ? { status } : {};

const buildTransactionHistoryAggregate = ({
  accountIds,
  amountFilter,
  dateFilter,
  limit,
  skip,
  statusFilter,
  type,
}) => {
  const accountCollection = Account.collection.name;
  const withdrawalCollection = Withdrawal.collection.name;
  const transferCollection = Transfer.collection.name;
  const normalizedType = String(type || "all").toLowerCase();
  const includeDeposits =
    normalizedType === "all" || normalizedType === "deposit";
  const includeWithdrawals =
    normalizedType === "all" || normalizedType === "withdrawal";
  const includeTransfers =
    normalizedType === "all" || normalizedType === "transfer";

  const stages = includeDeposits
    ? []
    : [{ $match: { _id: { $exists: false } } }];

  if (includeDeposits) {
    stages.push(
      {
        $match: {
          account: { $in: accountIds },
          ...dateFilter,
          ...amountFilter,
          ...statusFilter,
        },
      },
      {
        $lookup: {
          from: accountCollection,
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
          date: "$createdAt",
          sortDate: "$createdAt",
          type: { $literal: "Deposit" },
          account: "$account.mt5Account",
          amount: "$amount",
          status: "$status",
          reference: "$transactionId",
          details: "$paymentType",
          fromAccount: null,
          toAccount: null,
        },
      },
    );
  }

  if (includeWithdrawals) {
    const withdrawalPipeline = [
      {
        $match: {
          account: { $in: accountIds },
          ...dateFilter,
          ...amountFilter,
          ...statusFilter,
        },
      },
      {
        $lookup: {
          from: accountCollection,
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
          date: "$createdAt",
          sortDate: "$createdAt",
          type: { $literal: "Withdrawal" },
          account: "$account.mt5Account",
          amount: "$amount",
          status: "$status",
          reference: null,
          details: "$paymentMethod",
          fromAccount: null,
          toAccount: null,
        },
      },
    ];

    stages.push({
      $unionWith: {
        coll: withdrawalCollection,
        pipeline: withdrawalPipeline,
      },
    });
  }

  if (includeTransfers) {
    const transferPipeline = [
      {
        $match: {
          $or: [
            { fromAccount: { $in: accountIds } },
            { toAccount: { $in: accountIds } },
          ],
          ...dateFilter,
          ...amountFilter,
          ...statusFilter,
        },
      },
      {
        $lookup: {
          from: accountCollection,
          localField: "fromAccount",
          foreignField: "_id",
          as: "fromAccount",
        },
      },
      {
        $lookup: {
          from: accountCollection,
          localField: "toAccount",
          foreignField: "_id",
          as: "toAccount",
        },
      },
      { $unwind: { path: "$fromAccount", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$toAccount", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          id: "$_id",
          date: "$createdAt",
          sortDate: "$createdAt",
          type: { $literal: "Transfer" },
          account: null,
          amount: "$amount",
          status: "$status",
          reference: null,
          details: null,
          fromAccount: "$fromAccount.mt5Account",
          toAccount: "$toAccount.mt5Account",
        },
      },
    ];

    stages.push({
      $unionWith: {
        coll: transferCollection,
        pipeline: transferPipeline,
      },
    });
  }

  if (!includeDeposits && !includeWithdrawals && !includeTransfers) {
    return null;
  }

  return [
    ...stages,
    { $sort: { sortDate: -1 } },
    {
      $facet: {
        transactions: [{ $skip: skip }, { $limit: limit }],
        totalCount: [{ $count: "count" }],
      },
    },
  ];
};

// Helper to format date key
const formatDateKey = (date) => {
  if (!date) return "null";
  return date.toISOString().split("T")[0];
};
/**
 * Get account statement for a specific period
 * @route GET /api/client/statement/account/:accountId
 */
const getAccountStatement = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { accountId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate accountId
    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID format",
      });
    }

    // Parse dates
    const start = startDate
      ? new Date(startDate)
      : new Date(new Date().setDate(1));
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const cacheKey = CACHE_KEYS.ACCOUNT_STATEMENT(
      userId,
      accountId,
      formatDateKey(start),
      formatDateKey(end),
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

    // Validate account ownership
    const account = await Account.findOne({
      _id: accountId,
      user: userId,
    }).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found or unauthorized",
      });
    }

    // OPTIMIZED: Run all queries in parallel
    const [deposits, withdrawals, transfersOut, transfersIn] =
      await Promise.all([
        Deposit.find({
          account: accountId,
          status: "Approved",
          approvedDate: { $gte: start, $lte: end },
        })
          .select("amount approvedDate paymentType transactionId")
          .sort({ approvedDate: 1 })
          .lean(),

        Withdrawal.find({
          account: accountId,
          status: "Approved",
          approvedDate: { $gte: start, $lte: end },
        })
          .select("amount approvedDate paymentMethod")
          .sort({ approvedDate: 1 })
          .lean(),

        Transfer.find({
          fromAccount: accountId,
          status: "Completed",
          createdAt: { $gte: start, $lte: end },
        })
          .populate("toAccount", "mt5Account")
          .select("amount createdAt")
          .sort({ createdAt: 1 })
          .lean(),

        Transfer.find({
          toAccount: accountId,
          status: "Completed",
          createdAt: { $gte: start, $lte: end },
        })
          .populate("fromAccount", "mt5Account")
          .select("amount createdAt")
          .sort({ createdAt: 1 })
          .lean(),
      ]);

    // Calculate totals efficiently
    let totalDeposits = 0,
      totalWithdrawals = 0,
      totalTransfersOut = 0,
      totalTransfersIn = 0;

    const transactions = [];

    // Process deposits
    for (const d of deposits) {
      totalDeposits += d.amount;
      transactions.push({
        date: d.approvedDate,
        type: "Deposit",
        description: `${d.paymentType} Deposit`,
        reference: d.transactionId || d._id,
        debit: 0,
        credit: d.amount,
      });
    }

    // Process withdrawals
    for (const w of withdrawals) {
      totalWithdrawals += w.amount;
      transactions.push({
        date: w.approvedDate,
        type: "Withdrawal",
        description: `${w.paymentMethod} Withdrawal`,
        reference: w._id,
        debit: w.amount,
        credit: 0,
      });
    }

    // Process transfers out
    for (const t of transfersOut) {
      totalTransfersOut += t.amount;
      transactions.push({
        date: t.createdAt,
        type: "Transfer Out",
        description: `Transfer to ${t.toAccount?.mt5Account || "Account"}`,
        reference: t._id,
        debit: t.amount,
        credit: 0,
      });
    }

    // Process transfers in
    for (const t of transfersIn) {
      totalTransfersIn += t.amount;
      transactions.push({
        date: t.createdAt,
        type: "Transfer In",
        description: `Transfer from ${t.fromAccount?.mt5Account || "Account"}`,
        reference: t._id,
        debit: 0,
        credit: t.amount,
      });
    }

    // Sort transactions by date
    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate running balance
    const openingBalance = account.balance || 0;
    let runningBalance = openingBalance;

    for (const tx of transactions) {
      runningBalance = runningBalance + tx.credit - tx.debit;
      tx.balance = runningBalance;
    }

    const closingBalance =
      openingBalance +
      totalDeposits -
      totalWithdrawals -
      totalTransfersOut +
      totalTransfersIn;

    const result = {
      account: {
        mt5Account: account.mt5Account,
        accountType: account.accountType,
        name: account.name,
        leverage: account.leverage,
        platform: account.platform,
      },
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      summary: {
        openingBalance: openingBalance.toFixed(2),
        closingBalance: closingBalance.toFixed(2),
        totalDeposits: totalDeposits.toFixed(2),
        totalWithdrawals: totalWithdrawals.toFixed(2),
        totalTransfersIn: totalTransfersIn.toFixed(2),
        totalTransfersOut: totalTransfersOut.toFixed(2),
        netChange: (closingBalance - openingBalance).toFixed(2),
        transactionCount: transactions.length,
      },
      transactions: transactions.map((tx) => ({
        ...tx,
        date: tx.date.toISOString(),
        debit: tx.debit.toFixed(2),
        credit: tx.credit.toFixed(2),
        balance: tx.balance.toFixed(2),
      })),
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.ACCOUNT_STATEMENT);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Get consolidated statement for all user accounts
 * @route GET /api/client/statement/consolidated
 */
const getConsolidatedStatement = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    const start = startDate
      ? new Date(startDate)
      : new Date(new Date().setDate(1));
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const cacheKey = CACHE_KEYS.CONSOLIDATED(
      userId,
      formatDateKey(start),
      formatDateKey(end),
    );

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Get all user accounts
    const accounts = await getUserAccountsLite(
      userId,
      "_id mt5Account balance equity accountType",
    );

    const accountIds = accounts.map((acc) => acc._id);

    const [
      depositSummaryResult,
      withdrawalSummaryResult,
      transferCount,
      recentTransactionsResult,
    ] = await Promise.all([
      Deposit.aggregate([
        {
          $match: {
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: "$account",
            totalDeposits: { $sum: "$amount" },
            transactionCount: { $sum: 1 },
          },
        },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: "$account",
            totalWithdrawals: { $sum: "$amount" },
            transactionCount: { $sum: 1 },
          },
        },
      ]),
      Transfer.countDocuments({
        $or: [{ fromAccount: { $in: accountIds } }, { toAccount: { $in: accountIds } }],
        status: "Completed",
        createdAt: { $gte: start, $lte: end },
      }),
      Deposit.aggregate([
        {
          $match: {
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: start, $lte: end },
          },
        },
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
            date: "$approvedDate",
            type: { $literal: "Deposit" },
            account: "$account.mt5Account",
            amount: "$amount",
            sortDate: "$approvedDate",
          },
        },
        {
          $unionWith: {
            coll: Withdrawal.collection.name,
            pipeline: [
              {
                $match: {
                  account: { $in: accountIds },
                  status: "Approved",
                  approvedDate: { $gte: start, $lte: end },
                },
              },
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
                  date: "$approvedDate",
                  type: { $literal: "Withdrawal" },
                  account: "$account.mt5Account",
                  amount: "$amount",
                  sortDate: "$approvedDate",
                },
              },
            ],
          },
        },
        { $sort: { sortDate: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const depositSummaryMap = new Map(
      depositSummaryResult.map((item) => [item._id.toString(), item]),
    );
    const withdrawalSummaryMap = new Map(
      withdrawalSummaryResult.map((item) => [item._id.toString(), item]),
    );

    const totalDeposits = depositSummaryResult.reduce(
      (sum, item) => sum + (item.totalDeposits || 0),
      0,
    );
    const totalWithdrawals = withdrawalSummaryResult.reduce(
      (sum, item) => sum + (item.totalWithdrawals || 0),
      0,
    );

    const currentBalance = accounts.reduce(
      (sum, acc) => sum + (acc.balance || 0),
      0,
    );
    const currentEquity = accounts.reduce(
      (sum, acc) => sum + (acc.equity || 0),
      0,
    );

    const accountBreakdown = accounts.map((acc) => {
      const accountId = acc._id.toString();
      const depositSummary = depositSummaryMap.get(accountId);
      const withdrawalSummary = withdrawalSummaryMap.get(accountId);
      const depositCount = depositSummary?.transactionCount || 0;
      const withdrawalCount = withdrawalSummary?.transactionCount || 0;

      return {
        mt5Account: acc.mt5Account,
        accountType: acc.accountType,
        currentBalance: (acc.balance || 0).toFixed(2),
        currentEquity: (acc.equity || 0).toFixed(2),
        totalDeposits: (depositSummary?.totalDeposits || 0).toFixed(2),
        totalWithdrawals: (withdrawalSummary?.totalWithdrawals || 0).toFixed(2),
        transactionCount: depositCount + withdrawalCount,
      };
    });

    const recentTransactions = recentTransactionsResult.map((item) => ({
      date: item.date,
      type: item.type,
      account: item.account,
      amount: Number(item.amount || 0).toFixed(2),
    }));

    const result = {
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      summary: {
        totalAccounts: accounts.length,
        currentBalance: currentBalance.toFixed(2),
        currentEquity: currentEquity.toFixed(2),
        totalValue: (currentBalance + currentEquity).toFixed(2),
        totalDeposits: totalDeposits.toFixed(2),
        totalWithdrawals: totalWithdrawals.toFixed(2),
        netFlow: (totalDeposits - totalWithdrawals).toFixed(2),
        totalTransactions:
          depositSummaryResult.reduce(
            (sum, item) => sum + (item.transactionCount || 0),
            0,
          ) +
          withdrawalSummaryResult.reduce(
            (sum, item) => sum + (item.transactionCount || 0),
            0,
          ) +
          transferCount,
      },
      accountBreakdown,
      recentTransactions,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.CONSOLIDATED);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Get monthly summary report
 * @route GET /api/client/statement/monthly-summary
 */
const getMonthlySummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { year, month } = req.query;

    const targetYear = year ? parseInt(year) : new Date().getFullYear();
    const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;

    const cacheKey = CACHE_KEYS.MONTHLY_SUMMARY(
      userId,
      targetYear,
      targetMonth,
    );

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59);

    const accounts = await getUserAccountsLite(userId, "_id balance equity");
    const accountIds = accounts.map((acc) => acc._id);

    const [depositsData, withdrawalsData, transfersData, prevMonthData] =
      await Promise.all([
        Deposit.aggregate([
          {
            $match: {
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 },
              avgAmount: { $avg: "$amount" },
            },
          },
        ]),
        Withdrawal.aggregate([
          {
            $match: {
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: { $gte: startDate, $lte: endDate },
            },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 },
              avgAmount: { $avg: "$amount" },
            },
          },
        ]),
        Transfer.aggregate([
          {
            $match: {
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
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Deposit.aggregate([
          {
            $match: {
              account: { $in: accountIds },
              status: "Approved",
              approvedDate: {
                $gte: new Date(targetYear, targetMonth - 2, 1),
                $lte: new Date(targetYear, targetMonth - 1, 0, 23, 59, 59),
              },
            },
          },
          { $group: { _id: null, totalAmount: { $sum: "$amount" } } },
        ]),
      ]);

    const deposits = depositsData[0] || {
      totalAmount: 0,
      count: 0,
      avgAmount: 0,
    };
    const withdrawals = withdrawalsData[0] || {
      totalAmount: 0,
      count: 0,
      avgAmount: 0,
    };
    const transfers = transfersData[0] || {
      totalAmount: 0,
      count: 0,
    };

    const prevMonthDepositTotal = prevMonthData[0]?.totalAmount || 0;
    const depositGrowth =
      prevMonthDepositTotal > 0
        ? (
            ((deposits.totalAmount - prevMonthDepositTotal) /
              prevMonthDepositTotal) *
            100
          ).toFixed(2)
        : 0;

    const result = {
      period: {
        year: targetYear,
        month: targetMonth,
        monthName: new Date(targetYear, targetMonth - 1).toLocaleString(
          "en-US",
          { month: "long" },
        ),
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      deposits: {
        total: deposits.totalAmount.toFixed(2),
        count: deposits.count,
        average: deposits.avgAmount.toFixed(2),
        growth: `${depositGrowth}%`,
      },
      withdrawals: {
        total: withdrawals.totalAmount.toFixed(2),
        count: withdrawals.count,
        average: withdrawals.avgAmount.toFixed(2),
      },
      transfers: {
        total: transfers.totalAmount.toFixed(2),
        count: transfers.count,
      },
      netCashFlow: (deposits.totalAmount - withdrawals.totalAmount).toFixed(2),
      totalTransactions: deposits.count + withdrawals.count + transfers.count,
      accountsSummary: {
        totalAccounts: accounts.length,
        totalBalance: accounts
          .reduce((sum, acc) => sum + (acc.balance || 0), 0)
          .toFixed(2),
        totalEquity: accounts
          .reduce((sum, acc) => sum + (acc.equity || 0), 0)
          .toFixed(2),
      },
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.MONTHLY_SUMMARY);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Get year-to-date summary
 * @route GET /api/client/statement/ytd-summary
 */
const getYTDSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { year } = req.query;

    const targetYear = year ? parseInt(year) : new Date().getFullYear();
    const cacheKey = CACHE_KEYS.YTD_SUMMARY(userId, targetYear);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const startDate = new Date(targetYear, 0, 1);
    const endDate = new Date();

    const accounts = await getUserAccountsLite(userId, "_id balance equity");
    const accountIds = accounts.map((acc) => acc._id);

    // OPTIMIZED: Run aggregations in parallel
    const [monthlyDeposits, withdrawalsByMonth] = await Promise.all([
      Deposit.aggregate([
        {
          $match: {
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: { month: { $month: "$approvedDate" } },
            totalDeposits: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.month": 1 } },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            account: { $in: accountIds },
            status: "Approved",
            approvedDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: { month: { $month: "$approvedDate" } },
            totalWithdrawals: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.month": 1 } },
      ]),
    ]);

    // Create maps for O(1) lookup
    const depositsMap = new Map(monthlyDeposits.map((d) => [d._id.month, d]));
    const withdrawalsMap = new Map(
      withdrawalsByMonth.map((w) => [w._id.month, w]),
    );

    // Build monthly breakdown
    const monthlyBreakdown = [];
    let ytdDeposits = 0,
      ytdWithdrawals = 0;

    for (let i = 1; i <= 12; i++) {
      const depositData = depositsMap.get(i);
      const withdrawalData = withdrawalsMap.get(i);

      const deposits = depositData?.totalDeposits || 0;
      const withdrawals = withdrawalData?.totalWithdrawals || 0;

      ytdDeposits += deposits;
      ytdWithdrawals += withdrawals;

      monthlyBreakdown.push({
        month: i,
        monthName: new Date(targetYear, i - 1).toLocaleString("en-US", {
          month: "short",
        }),
        deposits: deposits.toFixed(2),
        withdrawals: withdrawals.toFixed(2),
        netFlow: (deposits - withdrawals).toFixed(2),
      });
    }

    const result = {
      year: targetYear,
      summary: {
        totalDeposits: ytdDeposits.toFixed(2),
        totalWithdrawals: ytdWithdrawals.toFixed(2),
        netCashFlow: (ytdDeposits - ytdWithdrawals).toFixed(2),
        currentBalance: accounts
          .reduce((sum, acc) => sum + (acc.balance || 0), 0)
          .toFixed(2),
        currentEquity: accounts
          .reduce((sum, acc) => sum + (acc.equity || 0), 0)
          .toFixed(2),
      },
      monthlyBreakdown,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.YTD_SUMMARY);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Get transaction history with advanced filters
 * @route GET /api/client/statement/transaction-history
 */
const getTransactionHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      accountId,
      type,
      status,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      page = 1,
      limit = 50,
    } = req.query;

    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 50, 100); // Max 100 per page
    const skip = (pageNum - 1) * limitNum;

    // Build cache key
    const cacheKey = CACHE_KEYS.TRANSACTION_HISTORY(userId, {
      accountId,
      type,
      status,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      pageNum,
      limitNum,
    });

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Get user accounts
    let accountFilter = { user: userId };
    if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
      accountFilter._id = accountId;
    }

    const accounts = await Account.find(accountFilter).select("_id").lean();
    const accountIds = accounts.map((acc) => acc._id);

    if (accountIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          transactions: [],
          pagination: { page: pageNum, limit: limitNum, total: 0 },
        },
      });
    }

    const dateFilter = buildDateFilter(startDate, endDate);
    const amountFilter = buildAmountFilter(minAmount, maxAmount);
    const statusFilter = buildStatusFilter(status);
    const aggregatePipeline = buildTransactionHistoryAggregate({
      accountIds,
      amountFilter,
      dateFilter,
      limit: limitNum,
      skip,
      statusFilter,
      type,
    });

    if (!aggregatePipeline) {
      return res.status(200).json({
        success: true,
        data: {
          transactions: [],
          pagination: { page: pageNum, limit: limitNum, total: 0, pages: 0 },
        },
      });
    }

    const [aggregateResult] = await Deposit.aggregate(aggregatePipeline);
    const transactions = aggregateResult?.transactions || [];
    const total = aggregateResult?.totalCount?.[0]?.count || 0;

    const result = {
      transactions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.TRANSACTION_HISTORY);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * Invalidate statement caches for a user
 * Call this when deposits/withdrawals/transfers are created or updated
 */
const invalidateStatementCaches = async (userId) => {
  const patterns = [
    `statement:account:${userId}:*`,
    `statement:consolidated:${userId}:*`,
    `statement:monthly:${userId}:*`,
    `statement:ytd:${userId}:*`,
    `statement:history:${userId}:*`,
  ];

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Statement caches invalidated for user: ${userId}`);
};

module.exports = {
  getAccountStatement,
  getConsolidatedStatement,
  getMonthlySummary,
  getYTDSummary,
  getTransactionHistory,
  invalidateStatementCaches,
};

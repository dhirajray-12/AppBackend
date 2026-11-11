const Transfer = require("../../models/client/Transfer");
const Account = require("../../models/client/Account");
const axios = require("axios");
const { metaApi } = require("../../API/metaApi");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const {
  invalidateStatementCaches,
} = require("./statementController");
const { AppError } = require("../../middlewares/errorHandler");
require("dotenv").config();

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
};

// MT5 API Configuration
const MANAGER_INDEX = process.env.MANAGER_INDEX || process.env.Manager_Index || 1;

// Cache keys
const CACHE_KEYS = {
  USER_TRANSFERS: (userId, role, page, limit, status) =>
    `transfers:user:${userId}:${role}:${page}:${limit}:${status}`,
  USER_ACCOUNTS: (userId) => `transfers:accounts:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_TRANSFERS: 30, // 30 seconds
  USER_ACCOUNTS: 60, // 1 minute
};

// API timeout
const API_TIMEOUT = 30000; // 30 seconds

// Helper function to make MT5 withdrawal with timeout
const makeWithdrawal = async (
  mt5Account,
  amount,
  comment = "Transfer withdrawal",
) => {
  try {
    const response = await metaApi.get(`/MakeWithdrawBalance`, {
      params: {
        Manager_Index: MANAGER_INDEX,
        MT5Account: mt5Account,
        Amount: amount,
        Comment: comment,
      },
      timeout: API_TIMEOUT,
    });

    if (response.data.error || !response.data.Result) {
      throw new Error(response.data.message || "Withdrawal failed");
    }

    return response.data;
  } catch (error) {
    throw new Error(`MT5 Withdrawal failed: ${error.message}`);
  }
};

// Helper function to make MT5 deposit with timeout
const makeDeposit = async (
  mt5Account,
  amount,
  comment = "Transfer deposit",
) => {
  try {
    const response = await metaApi.get(`/MakeDepositBalance`, {
      params: {
        Manager_Index: MANAGER_INDEX,
        MT5Account: mt5Account,
        Amount: amount,
        Comment: comment,
      },
      timeout: API_TIMEOUT,
    });

    if (response.data.error || !response.data.Result) {
      throw new Error(response.data.message || "Deposit failed");
    }

    return response.data;
  } catch (error) {
    throw new Error(`MT5 Deposit failed: ${error.message}`);
  }
};
// Get all transfers for a user or all transfers for admin
exports.getTransfers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { page = 1, limit = 20, status } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = CACHE_KEYS.USER_TRANSFERS(
      userId,
      userRole,
      pageNum,
      limitNum,
      status || "all",
    );

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        pagination: cached.pagination,
        fromCache: true,
      });
    }

    // Build query
    let query = {};
    if (userRole !== "admin") {
      query.user = userId;
    }
    if (status && status !== "all") {
      query.status = status;
    }

    // Run queries in parallel
    const [transfers, total] = await Promise.all([
      Transfer.find(query)
        .populate("user", "firstName lastName email")
        .populate("fromAccount", "mt5Account accountType balance equity")
        .populate("toAccount", "mt5Account accountType balance equity")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Transfer.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      data: transfers,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.USER_TRANSFERS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// Create new transfer with MT5 API integration and transaction safety
exports.createTransfer = async (req, res, next) => {
  try {
    const { fromAccountId, toAccountId, amount } = req.body;

    // Validate input
    if (!fromAccountId || !toAccountId || !amount) {
      return res.status(400).json({
        success: false,
        message: "Please provide fromAccountId, toAccountId and amount",
      });
    }

    if (fromAccountId === toAccountId) {
      return res.status(400).json({
        success: false,
        message: "Cannot transfer to the same account",
      });
    }

    if (amount < 10) {
      return res.status(400).json({
        success: false,
        message: "Minimum transfer amount is $10",
      });
    }

    // Check if accounts exist and belong to the user
    const [fromAccount, toAccount] = await Promise.all([
      Account.findOne({
        _id: fromAccountId,
        user: req.user.id,
      }),
      Account.findOne({
        _id: toAccountId,
        user: req.user.id,
      }),
    ]);

    if (!fromAccount || !toAccount) {
      return res.status(404).json({
        success: false,
        message: "One or both accounts not found",
      });
    }

    // Check if fromAccount has sufficient balance
    if (fromAccount.balance < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance in the source account. Available: $${fromAccount.balance.toFixed(2)}`,
      });
    }

    // Validate MT5 accounts
    if (!fromAccount.mt5Account || !toAccount.mt5Account) {
      return res.status(400).json({
        success: false,
        message: "MT5 account information is missing",
      });
    }

    let withdrawalResult = null;
    let depositResult = null;
    let transferRecord = null;

    try {
      // Step 1: Execute withdrawal from source MT5 account
      withdrawalResult = await makeWithdrawal(
        fromAccount.mt5Account,
        amount,
        `Transfer to ${toAccount.mt5Account}`,
      );

      // Step 2: Execute deposit to destination MT5 account
      depositResult = await makeDeposit(
        toAccount.mt5Account,
        amount,
        `Transfer from ${fromAccount.mt5Account}`,
      );

      // Step 3: Update local database balances
      fromAccount.balance = withdrawalResult.Balance;
      fromAccount.equity = withdrawalResult.Equity;
      toAccount.balance = depositResult.Balance;
      toAccount.equity = depositResult.Equity;

      await fromAccount.save();
      await toAccount.save();

      // Step 4: Create transfer record in database
      transferRecord = await Transfer.create({
        user: req.user.id,
        fromAccount: fromAccountId,
        toAccount: toAccountId,
        amount: parseFloat(amount),
        status: "Completed",
        mt5WithdrawalTicket: withdrawalResult.Ticket,
        mt5DepositTicket: depositResult.Ticket,
        mt5WithdrawalData: {
          balance: withdrawalResult.Balance,
          equity: withdrawalResult.Equity,
          freeMargin: withdrawalResult.FreeMargin,
          message: withdrawalResult.Message,
        },
        mt5DepositData: {
          balance: depositResult.Balance,
          equity: depositResult.Equity,
          freeMargin: depositResult.FreeMargin,
          message: depositResult.Message,
        },
      });

      // Invalidate caches
      await invalidateTransferCaches(req.user.id);
      await invalidateStatementCaches(req.user.id);

      // Populate the transfer record for response
      await transferRecord.populate([
        {
          path: "fromAccount",
          select: "mt5Account accountType balance equity",
        },
        { path: "toAccount", select: "mt5Account accountType balance equity" },
        { path: "user", select: "firstName lastName email" },
      ]);

      // Trigger notifications (non-blocking)
      if (req.notificationTriggers) {
        req.notificationTriggers
          .handleTransferSuccess(transferRecord.toObject())
          .catch((err) => console.error("Notification error:", err));
      }

      const io = req.app.get("io");
      if (io) {
        const realtimePayload = {
          id: transferRecord._id,
          data: transferRecord.toObject(),
        };

        if (io.emitAccountUpdate) {
          io.emitAccountUpdate(req.user.id, fromAccount.toObject());
          io.emitAccountUpdate(req.user.id, toAccount.toObject());
        }

        if (io.emitEntityUpdate) {
          io.emitEntityUpdate(
            req.user.id,
            "transfer",
            transferRecord._id,
            "updated",
            transferRecord.toObject(),
          );
        }

        if (io.broadcastToAdmins) {
          io.broadcastToAdmins("transfer_updated", realtimePayload);
        }

        if (io.emitCacheInvalidation) {
          io.emitCacheInvalidation(req.user.id, [
            "transfers",
            "accounts",
            "withdrawalAccounts",
            "availableBalances",
            "transactions",
            "accountTransactions",
            "accountActivity",
            "dashboard",
            "dashboardData",
          ]);
        }

        if (io.broadcastCacheInvalidation) {
          io.broadcastCacheInvalidation(["admin_dashboard"]);
        }
      }

      res.status(201).json({
        success: true,
        data: transferRecord,
        message: "Funds transferred successfully",
        mt5Data: {
          withdrawal: {
            ticket: withdrawalResult.Ticket,
            newBalance: withdrawalResult.Balance,
          },
          deposit: {
            ticket: depositResult.Ticket,
            newBalance: depositResult.Balance,
          },
        },
      });
    } catch (mt5Error) {
      // Handle partial failure (withdrawal succeeded, deposit failed)
      if (withdrawalResult && !depositResult) {
        return next(
          new AppError(
            `Transfer partially completed. Withdrawal successful but deposit failed. Please contact support immediately. Withdrawal ticket: ${withdrawalResult.Ticket}. Error: ${mt5Error.message}`,
            500,
          ),
        );
      }

      return next(new AppError(`Transfer failed: ${mt5Error.message}`, 500));
    }
  } catch (error) {
    next(error);
  }
};
// Get user accounts with balances (for transfer form)
exports.getUserAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.USER_ACCOUNTS(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const accounts = await Account.find({
      user: userId,
      status: true,
    })
      .select("mt5Account accountType platform balance equity")
      .sort({ balance: -1 })
      .lean();

    // Cache the response
    await cacheService.set(cacheKey, accounts, CACHE_TTL.USER_ACCOUNTS);

    res.status(200).json({
      success: true,
      data: accounts,
    });
  } catch (error) {
    next(error);
  }
};
// Get transfer statistics for dashboard
exports.getTransferStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `transfers:stats:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [stats, totalAmount] = await Promise.all([
      Transfer.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
          },
        },
      ]),
      Transfer.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const totalTransfers = stats.reduce((sum, stat) => sum + stat.count, 0);

    const result = {
      totalTransfers,
      totalAmount: totalAmount[0]?.total || 0,
      averageAmount:
        totalTransfers > 0 ? (totalAmount[0]?.total || 0) / totalTransfers : 0,
      byStatus: {
        completed: { count: 0, amount: 0 },
        failed: { count: 0, amount: 0 },
        pending: { count: 0, amount: 0 },
      },
    };

    stats.forEach((stat) => {
      const status = stat._id.toLowerCase();
      if (result.byStatus[status]) {
        result.byStatus[status] = {
          count: stat.count,
          amount: stat.totalAmount,
        };
      }
    });

    await cacheService.set(cacheKey, result, 60); // 1 minute cache

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// Get a specific transfer by ID
exports.getTransferById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid transfer ID format",
      });
    }

    const cacheKey = `transfers:single:${id}`;

    const cached = await cacheService.get(cacheKey);
    if (cached && (cached.user === userId || userRole === "admin")) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    let query = { _id: id };
    if (userRole !== "admin") {
      query.user = userId;
    }

    const transfer = await Transfer.findOne(query)
      .populate("user", "firstName lastName email")
      .populate("fromAccount", "mt5Account accountType balance equity")
      .populate("toAccount", "mt5Account accountType balance equity")
      .lean();

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: "Transfer not found",
      });
    }

    await cacheService.set(cacheKey, transfer, 60);

    res.status(200).json({
      success: true,
      data: transfer,
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate transfer-related caches
const invalidateTransferCaches = async (userId) => {
  const patterns = [
    `transfers:user:${userId}:*`,
    `transfers:accounts:${userId}`,
    `transfers:stats:${userId}`,
  ];

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Transfer caches invalidated for user: ${userId}`);
};

// Export cache invalidation function
exports.invalidateTransferCaches = invalidateTransferCaches;

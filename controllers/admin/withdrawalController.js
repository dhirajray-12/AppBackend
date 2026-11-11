// Backend/controllers/admin/withdrawalController.js - FULLY OPTIMIZED
const Withdrawal = require("../../models/Withdrawal");
const Account = require("../../models/client/Account");
const User = require("../../models/User");
const { invalidateTransactionsCache } = require("./adminTransactionController");
const {
  invalidateStatementCaches,
} = require("../client/statementController");
const { invalidateClientCaches } = require("../client/clientDashboardController");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const { metaApi } = require("../../API/metaApi");
const { AppError } = require("../../middlewares/errorHandler");
const stripeWithdrawals = require("../../services/stripeWithdrawalService");
require("dotenv").config();

// MT5 API Configuration
const MANAGER_INDEX = process.env.Manager_Index;

// Cache keys
const CACHE_KEYS = {
  ALL_WITHDRAWALS: (filters) =>
    `admin:withdrawals:all:${JSON.stringify(filters)}`,
  WITHDRAWAL_DETAILS: (id) => `admin:withdrawal:${id}`,
  WITHDRAWAL_STATS: "admin:withdrawal:stats",
  CLIENT_WITHDRAWALS: (userId) => `withdrawals:user:${userId}:*`,
  CLIENT_LAST_METHOD: (userId) => `withdrawal:lastMethod:${userId}`,
  CLIENT_STATS: (userId) => `withdrawal:stats:${userId}`,
  CLIENT_WITHDRAWAL_BY_ID: (userId) => `withdrawal:${userId}:*`,
  CLIENT_ACCOUNTS: (userId) => `user:accounts:${userId}`,
  CLIENT_COPY_ACCOUNTS: (userId) => `user:copy:accounts:${userId}`,
  CLIENT_SINGLE_ACCOUNT: (accountId) => `account:${accountId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_WITHDRAWALS: 30, // 30 seconds - withdrawals update frequently
  WITHDRAWAL_DETAILS: 60, // 1 minute
  WITHDRAWAL_STATS: 60, // 1 minute
};

const BULK_APPROVAL_CONCURRENCY = 4;

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runner = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const concurrency = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  return results;
};

const calculateWithdrawalStats = (statsResult = []) => {
  const formattedStats = {
    totalRequests: 0,
    totalAmount: 0,
    averageAmount: 0,
    byStatus: {},
    completionRate: 0,
  };

  for (const stat of statsResult) {
    formattedStats.totalRequests += stat.count || 0;
    formattedStats.totalAmount += stat.totalAmount || 0;
    formattedStats.byStatus[stat._id] = {
      count: stat.count || 0,
      amount: stat.totalAmount || 0,
    };
  }

  formattedStats.averageAmount =
    formattedStats.totalRequests > 0
      ? formattedStats.totalAmount / formattedStats.totalRequests
      : 0;

  const completedCount =
    (formattedStats.byStatus.Approved?.count || 0) +
    (formattedStats.byStatus.Rejected?.count || 0);

  formattedStats.completionRate =
    formattedStats.totalRequests > 0
      ? ((completedCount / formattedStats.totalRequests) * 100).toFixed(1)
      : 0;

  return formattedStats;
};

exports.getAllWithdrawals = async (req, res, next) => {
  try {
    const {
      status,
      page = 1,
      limit = 20,
      search = "",
      startDate,
      endDate,
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Generate cache key
    const cacheKey = cacheService.generateKey(CACHE_KEYS.ALL_WITHDRAWALS({}), {
      status,
      page: pageNum,
      limit: limitNum,
      search,
      startDate,
      endDate,
    });

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        withdrawals: cached.withdrawals,
        pagination: cached.pagination,
        fromCache: true,
      });
    }

    // Build query
    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate + "T23:59:59.999Z");
    }

    // Search filter
    let searchUserIds = null;
    if (search) {
      const searchRegex = new RegExp(search, "i");
      const matchingUsers = await User.find({
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
        ],
      })
        .select("_id")
        .lean();
      searchUserIds = matchingUsers.map((u) => u._id);

      if (searchUserIds.length === 0) {
        const response = {
          success: true,
          withdrawals: [],
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: 0,
            pages: 0,
          },
        };

        await cacheService.set(cacheKey, response, CACHE_TTL.ALL_WITHDRAWALS);
        return res.status(200).json(response);
      }

      query.user = { $in: searchUserIds };
    }

    // Run queries in parallel
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(query)
        .populate({
          path: "user",
          select: "firstName lastName email avatar",
        })
        .populate({
          path: "account",
          select: "mt5Account balance accountType equity",
        })
        .sort({ requestedDate: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Withdrawal.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      withdrawals,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: totalPages,
      },
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_WITHDRAWALS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
exports.approveWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    let { remarks = "Congratulations" } = req.body; // card refunds replace it with the refund note

    // Validate ID
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format",
      });
    }

    const withdrawal = await Withdrawal.findById(id)
      .populate("account")
      .populate("user")
      .exec();

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal not found",
      });
    }

    if (withdrawal.status !== "Pending") {
      return res.status(400).json({
        success: false,
        message: "Withdrawal has already been processed",
      });
    }

    // Check if account has sufficient balance
    if (withdrawal.account.balance < withdrawal.amount) {
      withdrawal.status = "Rejected";
      withdrawal.rejectedDate = new Date();
      withdrawal.remarks = "Insufficient balance in account";
      await withdrawal.save();

      await withdrawal.populate("user", "firstName lastName email");

      await invalidateWithdrawalCaches(id);
      await invalidateClientWithdrawalCaches(
        withdrawal.user._id || withdrawal.user,
        withdrawal._id,
      );
      await invalidateClientCaches(withdrawal.user._id || withdrawal.user);

      if (req.notificationTriggers) {
        await req.notificationTriggers.handleWithdrawalStatusChange(
          withdrawal.toObject(),
          "Pending",
        );
      }

      const io = req.app.get("io");
      if (io) {
        const withdrawalUserId = withdrawal.user._id || withdrawal.user;

        if (io.emitWithdrawalUpdate) {
          io.emitWithdrawalUpdate(withdrawal.toObject(), "Pending");
        }

        if (io.emitCacheInvalidation) {
          io.emitCacheInvalidation(withdrawalUserId, [
            "withdrawal",
            "withdrawals",
            "transactions",
            "accountTransactions",
            "accountActivity",
            "dashboard",
            "dashboardData",
          ]);
        }

        if (io.broadcastCacheInvalidation) {
          io.broadcastCacheInvalidation(["admin_withdrawals", "admin_dashboard"]);
        }
      }

      return res.status(400).json({
        success: false,
        message: "Insufficient balance in account",
        rejected: true,
        withdrawal,
      });
    }

    // Card withdrawal: there must be a card payment that can take the refund
    // (checked before touching MT5).
    const isCard = withdrawal.paymentMethod === stripeWithdrawals.METHOD;
    let cardPayment = null;
    if (isCard) {
      cardPayment = await stripeWithdrawals.pickPayment(withdrawal.user._id, withdrawal.amount);
      if (!cardPayment) {
        return res.status(400).json({
          success: false,
          message: "No card payment from this client can take this refund. Reject it and ask for bank or e-wallet.",
        });
      }
    }

    // Call MT5 API to execute withdrawal
    const mt5Response = await callMT5WithdrawAPI(
      withdrawal.account.mt5Account,
      withdrawal.amount,
      `Withdrawal approval for ${withdrawal.user.firstName} ${withdrawal.user.lastName}`,
    );

    if (!mt5Response.success) {
      return res.status(400).json({
        success: false,
        message: "MT5 withdrawal failed",
        error: mt5Response.error,
      });
    }

    // Card withdrawal: refund to the card. If Stripe refuses, put the money back in MT5.
    if (isCard) {
      try {
        const refund = await stripeWithdrawals.refund(withdrawal, cardPayment);
        // Stripe often settles card refunds at once; then this is the final note,
        // and saving it can't overwrite the charge.refunded confirmation.
        remarks = refund.status === "succeeded"
          ? `Refunded to card ••••${cardPayment.last4} (Stripe ${refund.id})`
          : `Refund to card ••••${cardPayment.last4} sent (Stripe ${refund.id}); waiting for Stripe to confirm`;
      } catch (refundErr) {
        console.error("Card refund failed; reversing the MT5 debit", { withdrawal: id, error: refundErr.message });
        try {
          await stripeWithdrawals.reverseMT5Debit(withdrawal.account, withdrawal.amount, id);
        } catch (reverseErr) {
          console.error("MT5 reversal FAILED: fix by hand", { withdrawal: id, error: reverseErr.message });
          return res.status(500).json({
            success: false,
            message: `Card refund failed AND the MT5 debit could not be reversed. Credit $${withdrawal.amount} back to MT5 ${withdrawal.account.mt5Account} by hand.`,
          });
        }
        return res.status(502).json({
          success: false,
          message: `Card refund failed (${refundErr.message}). The MT5 debit was reversed; the withdrawal is still Pending.`,
        });
      }
    }

    // Update account balance in database
    const updatedAccount = await Account.findByIdAndUpdate(
      withdrawal.account._id,
      {
        balance: mt5Response.data.Balance,
        equity: mt5Response.data.Equity,
        freeMargin: mt5Response.data.FreeMargin,
        margin: mt5Response.data.Margin,
        credit: mt5Response.data.Credit,
        lastUpdated: new Date(),
      },
      { new: true },
    );

    // Update withdrawal status
    withdrawal.status = "Approved";
    withdrawal.approvedDate = new Date();
    withdrawal.remarks = remarks;
    withdrawal.mt5Ticket = mt5Response.data.Ticket;
    withdrawal.mt5TransactionId = mt5Response.data.Ticket;
    withdrawal.processedAmount = mt5Response.data.Amount;
    await withdrawal.save();

    // Populate user data for notifications
    await withdrawal.populate("user", "firstName lastName email");

    // Invalidate caches
    await invalidateWithdrawalCaches(id);
    await invalidateClientWithdrawalCaches(
      withdrawal.user._id || withdrawal.user,
      withdrawal._id,
    );
    await invalidateStatementCaches(withdrawal.user._id || withdrawal.user);
    await invalidateClientAccountCaches(
      withdrawal.user._id || withdrawal.user,
      updatedAccount?._id || withdrawal.account._id,
    );
    await invalidateClientCaches(withdrawal.user._id || withdrawal.user);

    // Trigger notifications
    if (req.notificationTriggers) {
      await req.notificationTriggers.handleWithdrawalStatusChange(
        withdrawal.toObject(),
        "Pending",
      );
    }

    const io = req.app.get("io");
    if (io) {
      const withdrawalUserId = withdrawal.user._id || withdrawal.user;

      if (io.emitWithdrawalUpdate) {
        io.emitWithdrawalUpdate(withdrawal.toObject(), "Pending");
      }

      if (updatedAccount && io.emitAccountUpdate) {
        io.emitAccountUpdate(withdrawalUserId, updatedAccount.toObject ? updatedAccount.toObject() : updatedAccount);
      }

      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(withdrawalUserId, [
          "withdrawal",
          "withdrawals",
          "withdrawalAccounts",
          "availableBalances",
          "accounts",
          "transactions",
          "accountTransactions",
          "accountActivity",
          "dashboard",
          "dashboardData",
        ]);
      }

      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation(["admin_withdrawals", "admin_dashboard"]);
      }
    }

    res.status(200).json({
      success: true,
      message: "Withdrawal approved and processed successfully",
      withdrawal: {
        ...withdrawal.toObject(),
        account: {
          ...withdrawal.account.toObject(),
          balance: updatedAccount.balance,
          equity: updatedAccount.equity,
        },
      },
      mt5Response: {
        ticket: mt5Response.data.Ticket,
        newBalance: mt5Response.data.Balance,
        message: mt5Response.data.Message,
      },
    });
  } catch (error) {
    if (error.response && error.response.data) {
      return next(new AppError(
        "MT5 API Error: " + (error.response.data.message || "Unknown error"),
        500,
      ));
    }

    next(error);
  }
};
exports.rejectWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { remarks } = req.body;

    if (!remarks) {
      return res.status(400).json({
        success: false,
        message: "Rejection remarks are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format",
      });
    }

    const withdrawal = await Withdrawal.findById(id);

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal not found",
      });
    }

    if (withdrawal.status !== "Pending") {
      return res.status(400).json({
        success: false,
        message: "Withdrawal has already been processed",
      });
    }

    // Update withdrawal status
    withdrawal.status = "Rejected";
    withdrawal.rejectedDate = new Date();
    withdrawal.remarks = remarks;
    await withdrawal.save();

    // Populate user data for notifications
    await withdrawal.populate("user", "firstName lastName email");

    // Invalidate caches
    await invalidateWithdrawalCaches(id);
    await invalidateClientWithdrawalCaches(
      withdrawal.user._id || withdrawal.user,
      withdrawal._id,
    );
    await invalidateClientCaches(withdrawal.user._id || withdrawal.user);

    // Trigger notifications
    if (req.notificationTriggers) {
      await req.notificationTriggers.handleWithdrawalStatusChange(
        withdrawal.toObject(),
        "Pending",
      );
    }

    const io = req.app.get("io");
    if (io) {
      const withdrawalUserId = withdrawal.user._id || withdrawal.user;

      if (io.emitWithdrawalUpdate) {
        io.emitWithdrawalUpdate(withdrawal.toObject(), "Pending");
      }

      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(withdrawalUserId, [
          "withdrawal",
          "withdrawals",
          "transactions",
          "accountTransactions",
          "accountActivity",
          "dashboard",
          "dashboardData",
        ]);
      }

      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation(["admin_withdrawals", "admin_dashboard"]);
      }
    }

    res.status(200).json({
      success: true,
      message: "Withdrawal rejected successfully",
      withdrawal,
    });
  } catch (error) {
    next(error);
  }
};
exports.getWithdrawalById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format",
      });
    }

    const cacheKey = CACHE_KEYS.WITHDRAWAL_DETAILS(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        withdrawal: cached,
        fromCache: true,
      });
    }

    const withdrawal = await Withdrawal.findById(id)
      .populate("user", "firstName lastName email avatar phone")
      .populate("account", "mt5Account balance equity accountType")
      .lean();

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal not found",
      });
    }

    // Cache the response
    await cacheService.set(cacheKey, withdrawal, CACHE_TTL.WITHDRAWAL_DETAILS);

    res.status(200).json({
      success: true,
      withdrawal,
    });
  } catch (error) {
    next(error);
  }
};
exports.getWithdrawalStats = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.WITHDRAWAL_STATS;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        stats: cached,
        fromCache: true,
      });
    }

    const statsResult = await Withdrawal.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const formattedStats = calculateWithdrawalStats(statsResult);

    // Cache the stats
    await cacheService.set(
      cacheKey,
      formattedStats,
      CACHE_TTL.WITHDRAWAL_STATS,
    );

    res.status(200).json({
      success: true,
      stats: formattedStats,
    });
  } catch (error) {
    next(error);
  }
};
exports.getPendingWithdrawalsCount = async (req, res, next) => {
  try {
    const cacheKey = "admin:withdrawals:pending:count";

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        totalAmount: cached.totalAmount,
        fromCache: true,
      });
    }

    const pendingWithdrawals = await Withdrawal.aggregate([
      { $match: { status: "Pending" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const result = {
      count: pendingWithdrawals[0]?.count || 0,
      totalAmount: pendingWithdrawals[0]?.totalAmount || 0,
    };

    // Short cache - 15 seconds for near real-time
    await cacheService.set(cacheKey, result, 15);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};
exports.bulkApproveWithdrawals = async (req, res, next) => {
  try {
    const { withdrawalIds, remarks } = req.body;

    if (
      !withdrawalIds ||
      !Array.isArray(withdrawalIds) ||
      withdrawalIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal IDs array is required",
      });
    }

    const results = {
      success: [],
      failed: [],
    };

    const normalizedIds = withdrawalIds.map((id) => String(id));
    const uniqueIds = Array.from(new Set(normalizedIds));
    const invalidIds = uniqueIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id),
    );

    for (const id of invalidIds) {
      results.failed.push({ id, reason: "Invalid withdrawal ID format" });
    }

    const validIds = uniqueIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const pendingWithdrawalDocs =
      validIds.length > 0
        ? await Withdrawal.find({ _id: { $in: validIds } })
            .populate("account")
            .populate("user")
        : [];

    const withdrawalById = new Map(
      pendingWithdrawalDocs.map((withdrawal) => [String(withdrawal._id), withdrawal]),
    );
    const successfulWithdrawalIds = new Set();
    const successfulUserIds = new Set();
    const successfulAccountIdsByUser = new Map();
    const io = req.app.get("io");

    await runWithConcurrency(
      validIds,
      BULK_APPROVAL_CONCURRENCY,
      async (id) => {
        try {
          const withdrawal = withdrawalById.get(id);

          if (!withdrawal || withdrawal.status !== "Pending") {
            results.failed.push({ id, reason: "Not found or already processed" });
            return;
          }

          if (!withdrawal.account || !withdrawal.user) {
            results.failed.push({ id, reason: "Withdrawal is missing account or user" });
            return;
          }

          if (withdrawal.account.balance < withdrawal.amount) {
            withdrawal.status = "Rejected";
            withdrawal.rejectedDate = new Date();
            withdrawal.remarks = "Insufficient balance in account";
            await withdrawal.save();

            if (req.notificationTriggers) {
              await req.notificationTriggers.handleWithdrawalStatusChange(
                withdrawal.toObject(),
                "Pending",
              );
            }

            if (io?.emitWithdrawalUpdate) {
              io.emitWithdrawalUpdate(withdrawal.toObject(), "Pending");
            }

            results.failed.push({ id, reason: "Insufficient balance in account" });
            return;
          }

          const mt5Response = await callMT5WithdrawAPI(
            withdrawal.account.mt5Account,
            withdrawal.amount,
            `Bulk withdrawal approval for ${withdrawal.user.firstName} ${withdrawal.user.lastName}`,
          );

          if (!mt5Response.success) {
            results.failed.push({ id, reason: mt5Response.error });
            return;
          }

          const updatedAccount = await Account.findByIdAndUpdate(
            withdrawal.account._id,
            {
              balance: mt5Response.data.Balance,
              equity: mt5Response.data.Equity,
              freeMargin: mt5Response.data.FreeMargin,
              margin: mt5Response.data.Margin,
              credit: mt5Response.data.Credit,
              lastUpdated: new Date(),
            },
            { new: true },
          );

          withdrawal.status = "Approved";
          withdrawal.approvedDate = new Date();
          withdrawal.remarks = remarks || "Bulk approval";
          withdrawal.mt5Ticket = mt5Response.data.Ticket;
          withdrawal.mt5TransactionId = mt5Response.data.Ticket;
          withdrawal.processedAmount = mt5Response.data.Amount;
          await withdrawal.save();

          const withdrawalUserId = String(withdrawal.user._id || withdrawal.user);
          successfulWithdrawalIds.add(String(withdrawal._id));
          successfulUserIds.add(withdrawalUserId);
          if (!successfulAccountIdsByUser.has(withdrawalUserId)) {
            successfulAccountIdsByUser.set(withdrawalUserId, new Set());
          }
          successfulAccountIdsByUser
            .get(withdrawalUserId)
            .add(String(updatedAccount?._id || withdrawal.account._id));

          if (io) {
            if (io.emitWithdrawalUpdate) {
              io.emitWithdrawalUpdate(withdrawal.toObject(), "Pending");
            }

            if (updatedAccount && io.emitAccountUpdate) {
              io.emitAccountUpdate(
                withdrawalUserId,
                updatedAccount.toObject ? updatedAccount.toObject() : updatedAccount,
              );
            }

            if (io.emitCacheInvalidation) {
              io.emitCacheInvalidation(withdrawalUserId, [
                "withdrawal",
                "withdrawals",
                "withdrawalAccounts",
                "availableBalances",
                "accounts",
                "transactions",
                "accountTransactions",
                "accountActivity",
                "dashboard",
                "dashboardData",
              ]);
            }

            if (io.broadcastCacheInvalidation) {
              io.broadcastCacheInvalidation([
                "admin_withdrawals",
                "admin_dashboard",
              ]);
            }
          }

          results.success.push({ id, ticket: mt5Response.data.Ticket });
        } catch (err) {
          results.failed.push({ id, reason: err.message });
        }
      },
    );

    await Promise.all([
      ...Array.from(successfulWithdrawalIds, (id) =>
        cacheService.deletePattern(CACHE_KEYS.WITHDRAWAL_DETAILS(id)),
      ),
      ...Array.from(successfulUserIds, (userId) =>
        invalidateClientWithdrawalCaches(userId),
      ),
      ...Array.from(successfulUserIds, (userId) =>
        invalidateStatementCaches(userId),
      ),
      ...Array.from(successfulUserIds, (userId) => {
        const matchingAccountIds = Array.from(
          successfulAccountIdsByUser.get(userId) || [],
        );
        return Promise.all(
          matchingAccountIds.map((accountId) =>
            invalidateClientAccountCaches(userId, accountId),
          ),
        );
      }),
    ]);

    // Invalidate all caches
    await invalidateAllWithdrawalCaches();

    res.status(200).json({
      success: true,
      message: `Processed ${results.success.length} withdrawals successfully`,
      results,
    });
  } catch (error) {
    next(error);
  }
};
// Helper function to call MT5 API (optimized with timeout)
async function callMT5WithdrawAPI(mt5Account, amount, comment) {
  try {
    const params = {
      Manager_Index: MANAGER_INDEX,
      MT5Account: mt5Account,
      Amount: amount,
      Comment: comment,
    };

    // Add timeout to prevent hanging
    const response = await metaApi.get(`/MakeWithdrawBalance`, {
      params,
      timeout: 30000, // 30 second timeout
    });

    if (
      response.data &&
      response.data.status === "success" &&
      response.data.Result === true
    ) {
      return {
        success: true,
        data: response.data,
      };
    } else {
      return {
        success: false,
        error:
          response.data?.message ||
          response.data?.Message ||
          "Unknown MT5 API error",
        data: response.data,
      };
    }
  } catch (error) {
    console.error("MT5 API Error:", error.response?.data || error.message);
    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.message ||
        "MT5 API connection failed",
      data: null,
    };
  }
}

// Invalidate withdrawal-related caches
async function invalidateWithdrawalCaches(withdrawalId = null) {
  const promises = [
    cacheService.deletePattern("admin:withdrawals:all:*"),
    cacheService.deletePattern(CACHE_KEYS.WITHDRAWAL_STATS),
    cacheService.deletePattern("admin:withdrawals:pending:count"),
    invalidateTransactionsCache(),
  ];

  if (withdrawalId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.WITHDRAWAL_DETAILS(withdrawalId)),
    );
  }

  await Promise.all(promises);
  console.log(
    `🗑️ Withdrawal caches invalidated${withdrawalId ? ` for ID: ${withdrawalId}` : ""}`,
  );
}

async function invalidateClientWithdrawalCaches(userId, withdrawalId = null) {
  if (!userId) return;

  const normalizedUserId = String(userId);
  const patterns = [
    CACHE_KEYS.CLIENT_WITHDRAWALS(normalizedUserId),
    CACHE_KEYS.CLIENT_LAST_METHOD(normalizedUserId),
    CACHE_KEYS.CLIENT_STATS(normalizedUserId),
  ];

  if (withdrawalId) {
    patterns.push(CACHE_KEYS.WITHDRAWAL_DETAILS(String(withdrawalId)));
    patterns.push(`withdrawal:${String(withdrawalId)}`);
  } else {
    patterns.push(CACHE_KEYS.CLIENT_WITHDRAWAL_BY_ID(normalizedUserId));
  }

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Client withdrawal caches invalidated for user: ${normalizedUserId}`);
}

async function invalidateClientAccountCaches(userId, accountId = null) {
  if (!userId) return;

  const normalizedUserId = String(userId);
  const patterns = [
    CACHE_KEYS.CLIENT_ACCOUNTS(normalizedUserId),
    CACHE_KEYS.CLIENT_COPY_ACCOUNTS(normalizedUserId),
  ];

  if (accountId) {
    patterns.push(CACHE_KEYS.CLIENT_SINGLE_ACCOUNT(String(accountId)));
  }

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Client account caches invalidated for user: ${normalizedUserId}`);
}

async function invalidateAllWithdrawalCaches() {
  await Promise.all([
    cacheService.deletePattern("admin:withdrawals:*"),
    invalidateTransactionsCache(),
  ]);
  console.log("🗑️ All withdrawal caches invalidated");
}

// Export cache invalidation functions
exports.invalidateWithdrawalCaches = invalidateWithdrawalCaches;
exports.invalidateAllWithdrawalCaches = invalidateAllWithdrawalCaches;

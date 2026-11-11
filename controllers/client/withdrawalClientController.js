// Backend/controllers/client/withdrawalClientController.js - FULLY OPTIMIZED
const Withdrawal = require("../../models/Withdrawal");
const Account = require("../../models/client/Account");
const Profile = require("../../models/client/Profile");
const { metaApi } = require("../../API/metaApi");
const cacheService = require("../../services/cacheService");
const stripeWithdrawals = require("../../services/stripeWithdrawalService");
const mongoose = require("mongoose");
require("dotenv").config();

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
};

// Cache keys
const CACHE_KEYS = {
  USER_WITHDRAWALS: (userId, page, limit, status) =>
    `withdrawals:user:${userId}:${page}:${limit}:${status}`,
  WITHDRAWAL_BY_ID: (id) => `withdrawal:${id}`,
  LAST_WITHDRAWAL_METHOD: (userId) => `withdrawal:lastMethod:${userId}`,
  WITHDRAWAL_STATS: (userId) => `withdrawal:stats:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_WITHDRAWALS: 30, // 30 seconds
  WITHDRAWAL_BY_ID: 60, // 1 minute
  LAST_WITHDRAWAL_METHOD: 300, // 5 minutes
  WITHDRAWAL_STATS: 60, // 1 minute
};

// API timeout
const API_TIMEOUT = 15000; // 15 seconds

// Valid e-wallet types
const EWALLET_TYPES = [
  "usdt",
  "ethereum",
  "bitcoin",
  "tron",
  "skrill",
  "neteller",
];
// Create new withdrawal request
exports.createWithdrawal = async (req, res, next) => {
  try {
    const {
      accountId,
      accountNumber,
      accountType,
      amount,
      paymentMethod,
      bankDetails,
      eWalletDetails,
    } = req.body;

    // Validate required fields
    if (!accountId || !amount || !paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Account ID, amount, and payment method are required",
      });
    }

    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    // Verify account exists and belongs to user
    const account = await Account.findOne({
      _id: accountId,
      user: req.user.id,
    }).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found or does not belong to you",
      });
    }

    // Check if amount is less than or equal to account balance
    if (amount > account.balance) {
      return res.status(400).json({
        success: false,
        message: `Withdrawal amount exceeds available balance. Available: $${account.balance.toFixed(2)}`,
      });
    }

    // Check for open trades (with timeout)
    try {
      const tradesResponse = await metaApi.get(`/GetOpenTradeByAccount`, {
        params: {
          Manager_Index: process.env.Manager_Index,
          MT5Accont: account.mt5Account,
        },
        timeout: API_TIMEOUT,
      });

      // If trades are found (not error status), prevent withdrawal
      if (
        tradesResponse.data &&
        tradesResponse.data.status !== "error" &&
        Array.isArray(tradesResponse.data) &&
        tradesResponse.data.length > 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Cannot process withdrawal. You have open trades on this account. Please close all trades before withdrawing funds.",
          hasOpenTrades: true,
        });
      }
    } catch (apiError) {
      console.error("Error checking open trades:", apiError.message);
      // Continue with withdrawal if API check fails (don't block user)
    }

    // Card withdrawals are refunds: they can't exceed a card payment the client made.
    if (paymentMethod === stripeWithdrawals.METHOD) {
      const max = await stripeWithdrawals.maxCardWithdrawal(req.user.id);
      if (Number(amount) > max) {
        return res.status(400).json({
          success: false,
          message: max > 0
            ? `You can withdraw up to $${max.toFixed(2)} to your card (the most one card payment can be refunded). Use bank or e-wallet for more.`
            : "Card withdrawals go back to a card you deposited with, and you have no card deposit to refund. Use bank or e-wallet.",
        });
      }
    }

    // Create withdrawal request
    const withdrawal = await Withdrawal.create({
      user: req.user.id,
      account: accountId,
      accountNumber: accountNumber || account.mt5Account,
      accountType: accountType || account.accountType,
      amount,
      paymentMethod,
      bankDetails: paymentMethod === "bank" ? bankDetails : undefined,
      eWalletDetails: EWALLET_TYPES.includes(paymentMethod)
        ? eWalletDetails
        : undefined,
      status: "Pending",
    });

    // Invalidate caches
    await invalidateWithdrawalCaches(req.user.id, withdrawal._id);

    // Populate required fields for notifications
    await withdrawal.populate([
      { path: "user", select: "firstName lastName email" },
      { path: "account", select: "mt5Account" },
    ]);

    // Trigger notifications (non-blocking)
    if (req.notificationTriggers) {
      req.notificationTriggers
        .handleWithdrawalStatusChange(withdrawal.toObject(), null)
        .catch((err) => console.error("Notification error:", err));
    }

    const io = req.app.get("io");
    if (io) {
      if (io.emitWithdrawalUpdate) {
        io.emitWithdrawalUpdate(withdrawal.toObject(), null);
      }

      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(req.user.id, [
          "withdrawals",
          "withdrawalAccounts",
          "dashboard",
          "transactions",
          "dashboardData",
          "accounts",
          "availableBalances",
          "accountActivity",
        ]);
      }

      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation([
          "admin_withdrawals",
          "admin_dashboard",
        ]);
      }
    }

    res.status(201).json({
      success: true,
      data: withdrawal,
    });
  } catch (error) {
    console.error("Error creating withdrawal:", error);
    next(error);
  }
};
// Get all withdrawals (admin)
exports.getWithdrawals = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    // Search by user name or email
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

      const userIds = matchingUsers.map((u) => u._id);
      if (userIds.length > 0) {
        query.user = { $in: userIds };
      }
    }

    // Run queries in parallel
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(query)
        .populate("user", "firstName lastName email")
        .populate("account", "mt5Account accountType balance")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Withdrawal.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: withdrawals,
    });
  } catch (error) {
    console.error("Get withdrawals error:", error);
    next(error);
  }
};
// Get withdrawals by user
exports.getWithdrawalsByUser = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = CACHE_KEYS.USER_WITHDRAWALS(
      userId,
      pageNum,
      limitNum,
      status || "all",
    );

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        total: cached.total,
        page: cached.page,
        pages: cached.pages,
        data: cached.data,
        fromCache: true,
      });
    }

    // Build query
    const query = { user: userId };
    if (status && status !== "all") {
      query.status = status;
    }

    // Run queries in parallel
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(query)
        .populate("account", "mt5Account accountType balance")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Withdrawal.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      count: withdrawals.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: withdrawals,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.USER_WITHDRAWALS);

    res.status(200).json(response);
  } catch (error) {
    console.error("Get withdrawals by user error:", error);
    next(error);
  }
};
// Get withdrawals by account
exports.getWithdrawalsByAccount = async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID format",
      });
    }

    const query = {
      user: req.user.id,
      account: accountId,
    };

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Withdrawal.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: withdrawals,
    });
  } catch (error) {
    console.error("Get withdrawals by account error:", error);
    next(error);
  }
};
// Get withdrawal by ID
exports.getWithdrawalById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format",
      });
    }

    const cacheKey = CACHE_KEYS.WITHDRAWAL_BY_ID(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (
      cached &&
      (cached.userId === req.user.id || req.user.role === "admin")
    ) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const withdrawal = await Withdrawal.findById(id)
      .populate("user", "firstName lastName email")
      .populate("account", "mt5Account accountType balance")
      .lean();

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal not found",
      });
    }

    // Check if user is authorized
    if (
      withdrawal.user._id.toString() !== req.user.id &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to access this withdrawal",
      });
    }

    // Cache the result
    await cacheService.set(cacheKey, withdrawal, CACHE_TTL.WITHDRAWAL_BY_ID);

    res.status(200).json({
      success: true,
      data: withdrawal,
    });
  } catch (error) {
    console.error("Get withdrawal by ID error:", error);
    next(error);
  }
};
// Get last used withdrawal method for a user
exports.getLastWithdrawalMethod = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.LAST_WITHDRAWAL_METHOD(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // Get profile and last withdrawal in parallel
    const [profile, lastWithdrawal] = await Promise.all([
      Profile.findOne({ user: userId }).lean(),
      Withdrawal.findOne({ user: userId }).sort({ createdAt: -1 }).lean(),
    ]);

    let result = null;

    // Check profile first for saved payment methods
    if (profile && (profile.bankDetails || profile.walletDetails)) {
      const paymentMethods = [];

      // Add bank details if available
      if (profile.bankDetails?.bankName) {
        paymentMethods.push({
          type: "bank",
          details: {
            bankName: profile.bankDetails.bankName,
            accountHolderName: profile.bankDetails.accountHolderName,
            accountNumber: profile.bankDetails.accountNumber,
            ifscCode: profile.bankDetails.ifscSwiftCode,
          },
        });
      }

      // Add wallet details if available
      if (profile.walletDetails) {
        const wallets = [];
        if (profile.walletDetails.tetherWalletAddress) {
          wallets.push({
            type: "usdt",
            name: "USDT",
            address: profile.walletDetails.tetherWalletAddress,
          });
        }
        if (profile.walletDetails.ethWalletAddress) {
          wallets.push({
            type: "ethereum",
            name: "Ethereum",
            address: profile.walletDetails.ethWalletAddress,
          });
        }
        if (profile.walletDetails.trxWalletAddress) {
          wallets.push({
            type: "tron",
            name: "TRON",
            address: profile.walletDetails.trxWalletAddress,
          });
        }
        if (wallets.length > 0) {
          paymentMethods.push({ type: "ewallet", wallets });
        }
      }

      if (paymentMethods.length > 0) {
        result = {
          source: "profile",
          paymentMethods,
        };
      }
    }

    // Fall back to last withdrawal if no profile methods
    if (!result && lastWithdrawal) {
      let paymentDetails = {};
      if (lastWithdrawal.paymentMethod === "bank") {
        paymentDetails = lastWithdrawal.bankDetails;
      } else if (EWALLET_TYPES.includes(lastWithdrawal.paymentMethod)) {
        paymentDetails = lastWithdrawal.eWalletDetails;
      }

      result = {
        source: "withdrawal",
        paymentMethod: lastWithdrawal.paymentMethod,
        paymentDetails,
      };
    }

    // Cache the result
    if (result) {
      await cacheService.set(
        cacheKey,
        result,
        CACHE_TTL.LAST_WITHDRAWAL_METHOD,
      );
    }

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get last withdrawal method error:", error);
    next(error);
  }
};
// Get withdrawal statistics for user dashboard
exports.getWithdrawalStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.WITHDRAWAL_STATS(userId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [statsResult, totalAmountResult, totalRequests, pendingRequests] = await Promise.all([
      Withdrawal.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
          },
        },
      ]),
      Withdrawal.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(userId),
            status: "Approved",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Withdrawal.countDocuments({ user: userId }),
      Withdrawal.countDocuments({
        user: userId,
        status: "Pending",
      }),
    ]);

    const stats = {
      totalRequests,
      pendingRequests,
      approvedAmount: totalAmountResult[0]?.total || 0,
      byStatus: {
        pending: { count: 0, amount: 0 },
        approved: { count: 0, amount: 0 },
        rejected: { count: 0, amount: 0 },
      },
    };

    statsResult.forEach((stat) => {
      const status = stat._id.toLowerCase();
      if (stats.byStatus[status]) {
        stats.byStatus[status] = {
          count: stat.count,
          amount: stat.totalAmount,
        };
      }
    });

    await cacheService.set(cacheKey, stats, CACHE_TTL.WITHDRAWAL_STATS);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Get withdrawal stats error:", error);
    next(error);
  }
};
// Cancel a pending withdrawal request
exports.cancelWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format",
      });
    }

    const withdrawal = await Withdrawal.findOne({
      _id: id,
      user: userId,
      status: "Pending",
    });

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found or cannot be cancelled",
      });
    }

    await Withdrawal.findByIdAndDelete(id);

    // Invalidate caches
    await invalidateWithdrawalCaches(userId, id);

    const io = req.app.get("io");
    if (io) {
      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(userId, [
          "withdrawals",
          "withdrawalAccounts",
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

    res.status(200).json({
      success: true,
      message: "Withdrawal request cancelled successfully",
    });
  } catch (error) {
    console.error("Cancel withdrawal error:", error);
    next(error);
  }
};
// Invalidate withdrawal-related caches
const invalidateWithdrawalCaches = async (userId, withdrawalId = null) => {
  const patterns = [
    CACHE_KEYS.USER_WITHDRAWALS(userId, "*", "*", "*"),
    CACHE_KEYS.LAST_WITHDRAWAL_METHOD(userId),
    CACHE_KEYS.WITHDRAWAL_STATS(userId),
  ];

  if (withdrawalId) {
    patterns.push(CACHE_KEYS.WITHDRAWAL_BY_ID(String(withdrawalId)));
  } else {
    patterns.push(`withdrawal:${userId}:*`);
  }

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Withdrawal caches invalidated for user: ${userId}`);
};

// Export cache invalidation function
exports.invalidateWithdrawalCaches = invalidateWithdrawalCaches;

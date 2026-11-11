// Backend/controllers/client/ibWithdrawalController.js - FULLY OPTIMIZED
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const IBWithdrawal = require("../../models/IBWithdrawal");
const Profile = require("../../models/client/Profile");
const User = require("../../models/User");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");

const WALLET_TYPE_MAP = {
  usdt: "tether",
  tether: "tether",
  eth: "eth",
  ethereum: "eth",
  trx: "trx",
  tron: "trx",
};

function normalizeWalletType(walletType) {
  if (typeof walletType !== "string") {
    return "";
  }

  const normalized = walletType.trim().toLowerCase();
  const compact = normalized.replace(/[^a-z]/g, "");

  return WALLET_TYPE_MAP[normalized] || WALLET_TYPE_MAP[compact] || "";
}

function normalizeBankDetails(bankDetails = {}) {
  return {
    bankName: bankDetails.bankName?.trim() || "",
    accountHolderName: bankDetails.accountHolderName?.trim() || "",
    accountNumber: bankDetails.accountNumber?.trim() || "",
    ifscSwiftCode:
      bankDetails.ifscSwiftCode?.trim() || bankDetails.ifscCode?.trim() || "",
  };
}

function normalizeWalletDetails(walletDetails = {}) {
  return {
    walletType: normalizeWalletType(walletDetails.walletType),
    walletAddress: walletDetails.walletAddress?.trim() || "",
  };
}

// Cache keys
const CACHE_KEYS = {
  PROFILE_DETAILS: (userId) => `ib:withdrawal:profile:${userId}`,
  WITHDRAWAL_HISTORY: (userId, page, limit) =>
    `ib:withdrawal:history:${userId}:${page}:${limit}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  PROFILE_DETAILS: 300, // 5 minutes - profile doesn't change often
  WITHDRAWAL_HISTORY: 30, // 30 seconds - withdrawals update frequently
};

function getAuthenticatedUserId(req) {
  return req.user?._id || req.user?.id;
}
// @desc    Get user profile details for withdrawal
// @route   GET /api/ibclients/withdrawals/profile-details
// @access  Private (Client)
exports.getProfileDetails = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const cacheKey = CACHE_KEYS.PROFILE_DETAILS(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        profile: cached,
        fromCache: true,
      });
    }

    // OPTIMIZED: Run queries in parallel
    const [profile, user, ibConfig] = await Promise.all([
      Profile.findOne({ user: userId }).lean(),
      User.findById(userId, "firstName lastName email").lean(),
      IBClientConfiguration.findOne({ userId }).lean(),
    ]);

    if (!ibConfig) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found.",
      });
    }

    const profileData = {
      user: {
        firstname: user?.firstName || "",
        lastname: user?.lastName || "",
        email: user?.email || "",
      },
      bankDetails: profile?.bankDetails || {},
      walletDetails: profile?.walletDetails || {},
      availableBalance: ibConfig.IBbalance || 0,
    };

    // Cache the result
    await cacheService.set(cacheKey, profileData, CACHE_TTL.PROFILE_DETAILS);

    res.status(200).json({
      success: true,
      profile: profileData,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Request IB commission withdrawal
// @route   POST /api/ibclients/withdrawals/request
// @access  Private (Client)
exports.requestWithdrawal = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { amount, withdrawalMethod, bankDetails, walletDetails } = req.body;

    // Validation
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid withdrawal amount",
      });
    }

    if (!withdrawalMethod || !["bank", "wallet"].includes(withdrawalMethod)) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid withdrawal method",
      });
    }

    // Get IB configuration with lean for better performance
    const ibConfig = await IBClientConfiguration.findOne({ userId }).lean();

    if (!ibConfig) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found.",
      });
    }

    // Check available balance
    if (amount > ibConfig.IBbalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: $${ibConfig.IBbalance.toFixed(2)}`,
      });
    }

    // Validate withdrawal details based on method
    let normalizedBankDetails;
    let normalizedWalletDetails;

    if (withdrawalMethod === "bank") {
      normalizedBankDetails = normalizeBankDetails(bankDetails);
      if (
        !normalizedBankDetails.bankName ||
        !normalizedBankDetails.accountHolderName ||
        !normalizedBankDetails.accountNumber
      ) {
        return res.status(400).json({
          success: false,
          message: "Please provide complete bank details",
        });
      }
    } else if (withdrawalMethod === "wallet") {
      normalizedWalletDetails = normalizeWalletDetails(walletDetails);

      if (!normalizedWalletDetails.walletType) {
        return res.status(400).json({
          success: false,
          message: "Please select a valid wallet type",
        });
      }

      if (!normalizedWalletDetails.walletAddress) {
        return res.status(400).json({
          success: false,
          message: "Please provide complete wallet details",
        });
      }
    }

    // Create withdrawal request
    const withdrawalData = {
      userId,
      ibConfigurationId: ibConfig._id,
      amount,
      withdrawalMethod,
      status: "pending",
    };

    if (withdrawalMethod === "bank") {
      withdrawalData.bankDetails = normalizedBankDetails;
    } else {
      withdrawalData.walletDetails = normalizedWalletDetails;
    }

    const withdrawal = await IBWithdrawal.create(withdrawalData);

    // Invalidate caches
    await invalidateWithdrawalCaches(userId);

    res.status(201).json({
      success: true,
      message: "Withdrawal request submitted successfully",
      withdrawal: {
        _id: withdrawal._id,
        amount: withdrawal.amount,
        withdrawalMethod: withdrawal.withdrawalMethod,
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
        bankDetails: withdrawal.bankDetails,
        walletDetails: withdrawal.walletDetails,
      },
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get user's withdrawal history with pagination
// @route   GET /api/ibclients/withdrawals/history
// @access  Private (Client)
exports.getWithdrawalHistory = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { page = 1, limit = 20, status } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = CACHE_KEYS.WITHDRAWAL_HISTORY(userId, pageNum, limitNum);

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
    const query = { userId };
    if (status && status !== "all") {
      query.status = status;
    }

    // Run queries in parallel
    const [withdrawals, total] = await Promise.all([
      IBWithdrawal.find(query)
        .sort({ createdAt: -1 })
        .select("-approvedBy -adminNotes")
        .skip(skip)
        .limit(limitNum)
        .lean(),
      IBWithdrawal.countDocuments(query),
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
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.WITHDRAWAL_HISTORY);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Cancel pending withdrawal request
// @route   DELETE /api/ibclients/withdrawals/:withdrawalId
// @access  Private (Client)
exports.cancelWithdrawal = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { withdrawalId } = req.params;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format.",
      });
    }

    const withdrawal = await IBWithdrawal.findOne({
      _id: withdrawalId,
      userId,
      status: "pending",
    });

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found or cannot be cancelled.",
      });
    }

    await IBWithdrawal.findByIdAndDelete(withdrawalId);

    // Invalidate caches
    await invalidateWithdrawalCaches(userId);

    res.status(200).json({
      success: true,
      message: "Withdrawal request cancelled successfully",
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get withdrawal statistics for dashboard
// @route   GET /api/ibclients/withdrawals/stats
// @access  Private (Client)
exports.getWithdrawalStats = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const cacheKey = `ib:withdrawal:stats:${userId}`;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        stats: cached,
        fromCache: true,
      });
    }

    const [statsResult, totalAmountResult] = await Promise.all([
      IBWithdrawal.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
          },
        },
      ]),
      IBWithdrawal.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const totalRequests = await IBWithdrawal.countDocuments({ userId });

    const formattedStats = {
      totalRequests,
      totalAmount: totalAmountResult[0]?.total || 0,
      averageAmount:
        totalRequests > 0
          ? (totalAmountResult[0]?.total || 0) / totalRequests
          : 0,
      byStatus: {
        pending: { count: 0, amount: 0 },
        approved: { count: 0, amount: 0 },
        rejected: { count: 0, amount: 0 },
      },
    };

    statsResult.forEach((stat) => {
      if (formattedStats.byStatus[stat._id]) {
        formattedStats.byStatus[stat._id] = {
          count: stat.count,
          amount: stat.totalAmount,
        };
      }
    });

    // Calculate completion rate
    const completedCount =
      (formattedStats.byStatus.approved?.count || 0) +
      (formattedStats.byStatus.rejected?.count || 0);
    formattedStats.completionRate =
      totalRequests > 0
        ? ((completedCount / totalRequests) * 100).toFixed(1)
        : 0;

    await cacheService.set(cacheKey, formattedStats, 60); // 1 minute cache

    res.status(200).json({
      success: true,
      stats: formattedStats,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get a specific withdrawal by ID
// @route   GET /api/ibclients/withdrawals/:withdrawalId
// @access  Private (Client)
exports.getWithdrawalById = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { withdrawalId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format.",
      });
    }

    const cacheKey = `ib:withdrawal:single:${withdrawalId}`;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached && cached.userId === userId) {
      return res.status(200).json({
        success: true,
        withdrawal: cached,
        fromCache: true,
      });
    }

    const withdrawal = await IBWithdrawal.findOne({
      _id: withdrawalId,
      userId,
    }).lean();

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found.",
      });
    }

    // Cache the result
    await cacheService.set(cacheKey, withdrawal, 60);

    res.status(200).json({
      success: true,
      withdrawal,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Check eligible withdrawal amount (after pending withdrawals)
// @route   GET /api/ibclients/withdrawals/eligible-amount
// @access  Private (Client)
exports.getEligibleWithdrawalAmount = async (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const cacheKey = `ib:withdrawal:eligible:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        ...cached,
        fromCache: true,
      });
    }

    const [ibConfig, pendingWithdrawals] = await Promise.all([
      IBClientConfiguration.findOne({ userId }).lean(),
      IBWithdrawal.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            status: "pending",
          },
        },
        { $group: { _id: null, totalPending: { $sum: "$amount" } } },
      ]),
    ]);

    if (!ibConfig) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found.",
      });
    }

    const totalPending = pendingWithdrawals[0]?.totalPending || 0;
    const availableBalance = ibConfig.IBbalance || 0;
    const eligibleAmount = Math.max(0, availableBalance - totalPending);

    const result = {
      availableBalance,
      totalPending,
      eligibleAmount,
      currency: "USD",
    };

    await cacheService.set(cacheKey, result, 15); // 15 seconds cache

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate withdrawal-related caches for a user
async function invalidateWithdrawalCaches(userId) {
  const patterns = [
    CACHE_KEYS.PROFILE_DETAILS(userId),
    CACHE_KEYS.WITHDRAWAL_HISTORY(userId, "*", "*"),
    `ib:withdrawal:stats:${userId}`,
    `ib:withdrawal:eligible:${userId}`,
  ];

  for (const pattern of patterns) {
    await cacheService.deletePattern(pattern);
  }
  console.log(`🗑️ IB withdrawal caches invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateWithdrawalCaches = invalidateWithdrawalCaches;

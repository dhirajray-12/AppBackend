const IBWithdrawal = require("../../models/IBWithdrawal");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const User = require("../../models/User");
const mongoose = require("mongoose");
const cacheService = require("../../services/cacheService");
const {
  invalidateWithdrawalCaches: invalidateClientWithdrawalCaches,
} = require("../ibWithdrawalController");
const {
  invalidateIBConfigCaches,
} = require("../client/ibClientConfigurationController");

// Cache keys
const CACHE_KEYS = {
  ALL_WITHDRAWALS: (filters) =>
    `admin:ib:withdrawals:all:${JSON.stringify(filters)}`,
  WITHDRAWAL_DETAILS: (id) => `admin:ib:withdrawal:${id}`,
  WITHDRAWAL_STATS: "admin:ib:withdrawal:stats",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_WITHDRAWALS: 30, // 30 seconds - withdrawals update frequently
  WITHDRAWAL_DETAILS: 60, // 1 minute
  WITHDRAWAL_STATS: 60, // 1 minute
};

// The User schema stores firstName/lastName (camelCase), but this feature's
// frontend (IBWithdrawalManagement.tsx) reads the lowercase firstname/
// lastname keys on populated userId/approvedBy fields. .populate()'s select
// string can't rename fields the way an aggregation $project can, so alias
// them onto the plain (lean) object after the query instead of changing the
// response contract.
const withLowercaseNameAliases = (populatedDoc) => {
  if (populatedDoc && typeof populatedDoc === "object") {
    populatedDoc.firstname = populatedDoc.firstName;
    populatedDoc.lastname = populatedDoc.lastName;
  }
  return populatedDoc;
};

const formatIBWithdrawalStats = (statsResult = []) => {
  const formattedStats = {
    totalRequests: 0,
    totalAmount: 0,
    byStatus: {},
    pendingAmount: 0,
    approvedAmount: 0,
    rejectedAmount: 0,
    averageAmount: 0,
    completionRate: 0,
  };

  for (const stat of statsResult) {
    formattedStats.totalRequests += stat.count || 0;
    formattedStats.totalAmount += stat.totalAmount || 0;
    formattedStats.byStatus[stat._id] = {
      count: stat.count || 0,
      amount: stat.totalAmount || 0,
    };

    if (stat._id === "pending") formattedStats.pendingAmount = stat.totalAmount || 0;
    if (stat._id === "approved") formattedStats.approvedAmount = stat.totalAmount || 0;
    if (stat._id === "rejected") formattedStats.rejectedAmount = stat.totalAmount || 0;
  }

  formattedStats.averageAmount =
    formattedStats.totalRequests > 0
      ? formattedStats.totalAmount / formattedStats.totalRequests
      : 0;

  const completedCount =
    (formattedStats.byStatus.approved?.count || 0) +
    (formattedStats.byStatus.rejected?.count || 0);
  formattedStats.completionRate =
    formattedStats.totalRequests > 0
      ? ((completedCount / formattedStats.totalRequests) * 100).toFixed(1)
      : 0;

  return formattedStats;
};

// @desc    Get all withdrawal requests for admin
// @route   GET /api/admin/ib-withdrawals
// @access  Private (Admin)
exports.getAllWithdrawals = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10, startDate, endDate } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate + "T23:59:59.999Z");
    }

    // Generate cache key
    const cacheKey = cacheService.generateKey(CACHE_KEYS.ALL_WITHDRAWALS({}), {
      status,
      page: pageNum,
      limit: limitNum,
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

    const listPipeline = [
      { $match: query },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userId",
          pipeline: [
            { $project: { firstName: 1, lastName: 1, email: 1, country: 1 } },
          ],
        },
      },
      { $unwind: { path: "$userId", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "ibclientconfigurations",
          localField: "ibConfigurationId",
          foreignField: "_id",
          as: "ibConfigurationId",
          pipeline: [{ $project: { IBbalance: 1, referralCode: 1, level: 1 } }],
        },
      },
      {
        $unwind: {
          path: "$ibConfigurationId",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          amount: 1,
          withdrawalMethod: 1,
          bankDetails: 1,
          walletDetails: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          approvedAt: 1,
          processedAt: 1,
          transactionId: 1,
          adminNotes: 1,
          rejectedReason: 1,
          userId: {
            _id: "$userId._id",
            // Response key stays lowercase "firstname"/"lastname" to match
            // the existing frontend contract (IBWithdrawalManagement.tsx) -
            // only the source field being read was wrong.
            firstname: "$userId.firstName",
            lastname: "$userId.lastName",
            email: "$userId.email",
            country: "$userId.country",
          },
          ibConfigurationId: {
            IBbalance: "$ibConfigurationId.IBbalance",
            referralCode: "$ibConfigurationId.referralCode",
            level: "$ibConfigurationId.level",
          },
        },
      },
    ];

    const [result] = await IBWithdrawal.aggregate([
      ...listPipeline,
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $skip: skip },
            { $limit: limitNum },
          ],
        },
      },
    ]);
    const withdrawals = result?.data || [];
    const total = result?.metadata?.[0]?.total || 0;

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

// @desc    Get withdrawal details by ID
// @route   GET /api/admin/ib-withdrawals/:withdrawalId
// @access  Private (Admin)
exports.getWithdrawalDetails = async (req, res, next) => {
  try {
    const { withdrawalId } = req.params;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format.",
      });
    }

    const cacheKey = CACHE_KEYS.WITHDRAWAL_DETAILS(withdrawalId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        withdrawal: cached,
        fromCache: true,
      });
    }

    // OPTIMIZED: Single aggregation pipeline
    const [withdrawal] = await IBWithdrawal.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(withdrawalId) } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userId",
          pipeline: [
            {
              // Renamed inline: schema field is firstName/lastName, but the
              // frontend (IBWithdrawalManagement.tsx) reads the lowercase
              // "firstname"/"lastname" keys, so keep that response shape.
              $project: {
                firstname: "$firstName",
                lastname: "$lastName",
                email: 1,
                country: 1,
                phone: 1,
              },
            },
          ],
        },
      },
      { $unwind: { path: "$userId", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "ibclientconfigurations",
          localField: "ibConfigurationId",
          foreignField: "_id",
          as: "ibConfigurationId",
          pipeline: [{ $project: { IBbalance: 1, referralCode: 1, level: 1 } }],
        },
      },
      {
        $unwind: {
          path: "$ibConfigurationId",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "approvedBy",
          foreignField: "_id",
          as: "approvedBy",
          pipeline: [
            { $project: { firstname: "$firstName", lastname: "$lastName", email: 1 } },
          ],
        },
      },
      { $unwind: { path: "$approvedBy", preserveNullAndEmptyArrays: true } },
    ]);

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found.",
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

// @desc    Approve withdrawal request
// @route   PUT /api/admin/ib-withdrawals/:withdrawalId/approve
// @access  Private (Admin)
exports.approveWithdrawal = async (req, res, next) => {
  try {
    const { withdrawalId } = req.params;
    const { adminNotes, transactionId } = req.body;
    const adminId = req.user.id;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format.",
      });
    }

    // Find withdrawal with lock using session
    const withdrawal = await IBWithdrawal.findById(withdrawalId)
      .populate("ibConfigurationId");

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found.",
      });
    }

    if (withdrawal.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending withdrawals can be approved.",
      });
    }

    const ibConfig = withdrawal.ibConfigurationId;
    if (!ibConfig) {
      return res.status(400).json({
        success: false,
        message: "IB configuration not found.",
      });
    }

    if (withdrawal.amount > ibConfig.IBbalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient IB balance. Available: ${ibConfig.IBbalance.toFixed(2)}, Requested: ${withdrawal.amount.toFixed(2)}`,
      });
    }

    // Update withdrawal status
    const updatedWithdrawal = await IBWithdrawal.findByIdAndUpdate(
      withdrawalId,
      {
        status: "approved",
        approvedBy: adminId,
        approvedAt: new Date(),
        adminNotes: adminNotes || "",
        transactionId: transactionId || "",
        processedAt: new Date(),
      },
      { new: true },
    );

    if (!updatedWithdrawal) {
      return res.status(404).json({
        success: false,
        message: "Failed to update withdrawal status.",
      });
    }

    // Deduct amount from IB balance
    const updatedIBConfig = await IBClientConfiguration.findByIdAndUpdate(
      ibConfig._id,
      { $inc: { IBbalance: -withdrawal.amount } },
      { new: true },
    );

    if (!updatedIBConfig) {
      return res.status(500).json({
        success: false,
        message: "Failed to update IB balance.",
      });
    }

    // Invalidate caches
    await invalidateWithdrawalCaches(withdrawalId);
    await invalidateClientWithdrawalCaches(withdrawal.userId);
    await invalidateIBConfigCaches(withdrawal.userId);

    // Get populated response
    const finalWithdrawal = await IBWithdrawal.findById(withdrawalId)
      .populate("userId", "firstName lastName email")
      .populate("approvedBy", "firstName lastName")
      .lean();
    withLowercaseNameAliases(finalWithdrawal?.userId);
    withLowercaseNameAliases(finalWithdrawal?.approvedBy);

    const io = req.app.get("io");
    if (io) {
      const eventPayload = {
        id: withdrawalId,
        data: finalWithdrawal,
        action: "approved",
      };

      io.to(`user_${withdrawal.userId}`).emit("withdrawal_updated", eventPayload);
      io.broadcastToAdmins("withdrawal_updated", eventPayload);
      io.emitCacheInvalidation(withdrawal.userId.toString(), [
        "withdrawal",
        "withdrawals",
        "dashboard",
        "partner",
      ]);
      io.broadcastCacheInvalidation(["admin_ib_withdrawals"]);
    }

    res.status(200).json({
      success: true,
      message: "Withdrawal approved successfully",
      withdrawal: finalWithdrawal,
      updatedBalance: updatedIBConfig.IBbalance,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject withdrawal request
// @route   PUT /api/admin/ib-withdrawals/:withdrawalId/reject
// @access  Private (Admin)
exports.rejectWithdrawal = async (req, res, next) => {
  try {
    const { withdrawalId } = req.params;
    const { rejectedReason, adminNotes } = req.body;
    const adminId = req.user.id;

    if (!rejectedReason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal ID format.",
      });
    }

    const withdrawal = await IBWithdrawal.findById(withdrawalId);

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found.",
      });
    }

    if (withdrawal.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending withdrawals can be rejected.",
      });
    }

    // Update withdrawal status
    const updatedWithdrawal = await IBWithdrawal.findByIdAndUpdate(
      withdrawalId,
      {
        status: "rejected",
        rejectedReason,
        adminNotes: adminNotes || "",
        approvedBy: adminId,
        processedAt: new Date(),
      },
      { new: true },
    )
      .populate("userId", "firstName lastName email")
      .populate("approvedBy", "firstName lastName")
      .lean();
    withLowercaseNameAliases(updatedWithdrawal?.userId);
    withLowercaseNameAliases(updatedWithdrawal?.approvedBy);

    // Invalidate caches
    await invalidateWithdrawalCaches(withdrawalId);
    await invalidateClientWithdrawalCaches(withdrawal.userId);
    await invalidateIBConfigCaches(withdrawal.userId);

    const io = req.app.get("io");
    if (io) {
      const eventPayload = {
        id: withdrawalId,
        data: updatedWithdrawal,
        action: "rejected",
      };

      io.to(`user_${withdrawal.userId}`).emit("withdrawal_updated", eventPayload);
      io.broadcastToAdmins("withdrawal_updated", eventPayload);
      io.emitCacheInvalidation(withdrawal.userId.toString(), [
        "withdrawal",
        "withdrawals",
        "dashboard",
        "partner",
      ]);
      io.broadcastCacheInvalidation(["admin_ib_withdrawals"]);
    }

    res.status(200).json({
      success: true,
      message: "Withdrawal rejected successfully",
      withdrawal: updatedWithdrawal,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get withdrawal statistics
// @route   GET /api/admin/ib-withdrawals/stats
// @access  Private (Admin)
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

    const statsResult = await IBWithdrawal.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const formattedStats = formatIBWithdrawalStats(statsResult);

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

// @desc    Get withdrawals for a specific user
// @route   GET /api/admin/ib-withdrawals/user/:userId
// @access  Private (Admin)
exports.getWithdrawalsByUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format.",
      });
    }

    const cacheKey = cacheService.generateKey(
      `admin:ib:withdrawals:user:${userId}`,
      {
        page: pageNum,
        limit: limitNum,
      },
    );

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        ...cached,
        fromCache: true,
      });
    }

    const [withdrawals, total] = await Promise.all([
      IBWithdrawal.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("approvedBy", "firstName lastName email")
        .lean(),
      IBWithdrawal.countDocuments({ userId }),
    ]);
    withdrawals.forEach((w) => withLowercaseNameAliases(w.approvedBy));

    const response = {
      success: true,
      withdrawals,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };

    await cacheService.set(cacheKey, response, 60);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

// Invalidate all caches related to withdrawals
async function invalidateWithdrawalCaches(withdrawalId = null) {
  const promises = [
    cacheService.deletePattern("admin:ib:withdrawals:all:*"),
    cacheService.deletePattern(CACHE_KEYS.WITHDRAWAL_STATS),
    cacheService.deletePattern("admin:ib:withdrawals:user:*"),
  ];

  if (withdrawalId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.WITHDRAWAL_DETAILS(withdrawalId)),
    );
  }

  await Promise.all(promises);
  console.log(
    `🗑️ IB withdrawal caches invalidated${withdrawalId ? ` for ID: ${withdrawalId}` : ""}`,
  );
}

// Export cache invalidation function for use in other controllers
exports.invalidateWithdrawalCaches = invalidateWithdrawalCaches;

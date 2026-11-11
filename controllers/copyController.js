const Copy = require("../models/Copy");
const Account = require("../models/client/Account");
const User = require("../models/User");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");

// Cache keys
const CACHE_KEYS = {
  USER_COPY_REQUESTS: (userId, page, limit) =>
    `copy:user:${userId}:${page}:${limit}`,
  ALL_COPY_REQUESTS: (status, search, page, limit) =>
    `copy:admin:all:${status}:${search || "none"}:${page}:${limit}`,
  COPY_REQUEST_DETAILS: (id) => `copy:request:${id}`,
  COPY_REQUEST_STATS: "copy:admin:stats",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_COPY_REQUESTS: 60, // 1 minute
  ALL_COPY_REQUESTS: 30, // 30 seconds
  COPY_REQUEST_DETAILS: 300, // 5 minutes
  COPY_REQUEST_STATS: 60, // 1 minute
};
// @desc    Create a new copy request with multiple accounts
// @route   POST /api/copy/request
// @access  Private (Client)
exports.createCopyRequest = async (req, res, next) => {
  try {
    const { accountIds, copyType } = req.body;
    const userId = req.user._id;

    // Validate input
    if (
      !accountIds ||
      !Array.isArray(accountIds) ||
      accountIds.length === 0 ||
      !copyType
    ) {
      return res.status(400).json({
        success: false,
        message: "At least one account and copy type are required",
      });
    }

    // Validate copyType
    if (!["Master", "Copier"].includes(copyType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid copy type. Must be 'Master' or 'Copier'",
      });
    }

    // OPTIMIZED: Verify all accounts belong to user in one query
    const accounts = await Account.find({
      _id: { $in: accountIds },
      user: userId,
    })
      .select("_id")
      .lean();

    if (accounts.length !== accountIds.length) {
      return res.status(404).json({
        success: false,
        message: "One or more accounts not found or not authorized",
      });
    }

    // Check for existing pending request
    const existingRequest = await Copy.findOne({
      user: userId,
      accounts: { $in: accountIds },
      status: "pending",
    })
      .select("_id")
      .lean();

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message:
          "You already have a pending request for one or more of these accounts",
      });
    }

    // Create copy request
    const copyRequest = await Copy.create({
      user: userId,
      accounts: accountIds,
      copyType,
    });

    // Populate the response efficiently
    const populatedRequest = await Copy.findById(copyRequest._id)
      .populate("user", "firstName lastName email")
      .populate("accounts", "mt5Account accountType")
      .lean();

    // Invalidate user's copy requests cache
    await invalidateUserCopyCache(userId);
    emitCopyRequestUpdate(req, userId);

    res.status(201).json({
      success: true,
      message: "Copy request created successfully",
      data: populatedRequest,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get user's copy requests history
// @route   GET /api/copy/my-requests
// @access  Private (Client)
exports.getUserCopyRequests = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const cacheKey = CACHE_KEYS.USER_COPY_REQUESTS(userId, page, limit);

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

    // Run queries in parallel
    const [copyRequests, total] = await Promise.all([
      Copy.find({ user: userId })
        .populate("accounts", "mt5Account accountType")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Copy.countDocuments({ user: userId }),
    ]);

    const totalPages = Math.ceil(total / limit);

    const response = {
      success: true,
      data: copyRequests,
      pagination: {
        page,
        pages: totalPages,
        total,
        limit,
      },
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.USER_COPY_REQUESTS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Get all copy requests (Admin)
// @route   GET /api/copy/admin/requests
// @access  Private (Admin)
exports.getAllCopyRequests = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { status, search } = req.query;

    const cacheKey = CACHE_KEYS.ALL_COPY_REQUESTS(
      status || "all",
      search || "",
      page,
      limit,
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
    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    // OPTIMIZED: Search using aggregation for better performance
    let finalQuery = query;

    if (search) {
      const searchRegex = new RegExp(search, "i");

      // Find matching users and accounts in parallel
      const [matchingUsers, matchingAccounts] = await Promise.all([
        User.find({
          $or: [
            { firstName: searchRegex },
            { lastName: searchRegex },
            { email: searchRegex },
          ],
        })
          .select("_id")
          .lean(),
        Account.find({ mt5Account: searchRegex }).select("_id").lean(),
      ]);

      const userIds = matchingUsers.map((u) => u._id);
      const accountIds = matchingAccounts.map((a) => a._id);

      if (userIds.length > 0 || accountIds.length > 0) {
        finalQuery = {
          ...query,
          $or: [
            ...(userIds.length > 0 ? [{ user: { $in: userIds } }] : []),
            ...(accountIds.length > 0
              ? [{ accounts: { $in: accountIds } }]
              : []),
          ],
        };
      } else {
        // No matches found
        return res.status(200).json({
          success: true,
          data: [],
          pagination: { page, pages: 0, total: 0, limit },
        });
      }
    }

    // Run queries in parallel
    const [copyRequests, total] = await Promise.all([
      Copy.find(finalQuery)
        .populate("user", "firstName lastName email phone country dateofbirth")
        .populate("accounts", "mt5Account accountType leverage balance equity")
        .populate("processedBy", "firstName lastName email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Copy.countDocuments(finalQuery),
    ]);

    const totalPages = Math.ceil(total / limit);

    const response = {
      success: true,
      data: copyRequests,
      pagination: {
        page,
        pages: totalPages,
        total,
        limit,
      },
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_COPY_REQUESTS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Accept copy request
// @route   PUT /api/copy/admin/accept/:id
// @access  Private (Admin)
exports.acceptCopyRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const adminId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid copy request ID",
      });
    }

    const copyRequest = await Copy.findById(id);

    if (!copyRequest) {
      return res.status(404).json({
        success: false,
        message: "Copy request not found",
      });
    }

    if (copyRequest.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be accepted",
      });
    }

    // Update copy request
    copyRequest.status = "accepted";
    copyRequest.processedBy = adminId;
    copyRequest.processedAt = new Date();
    await copyRequest.save();

    // Get populated response
    const populatedRequest = await Copy.findById(id)
      .populate("user", "firstName lastName email")
      .populate("accounts", "mt5Account accountType")
      .populate("processedBy", "firstName lastName email")
      .lean();

    // Invalidate caches
    await invalidateCopyCaches(copyRequest.user, id);
    emitCopyRequestUpdate(req, copyRequest.user);

    res.status(200).json({
      success: true,
      message: "Copy request accepted successfully",
      data: populatedRequest,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Reject copy request
// @route   PUT /api/copy/admin/reject/:id
// @access  Private (Admin)
exports.rejectCopyRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user._id;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid copy request ID",
      });
    }

    const copyRequest = await Copy.findById(id);

    if (!copyRequest) {
      return res.status(404).json({
        success: false,
        message: "Copy request not found",
      });
    }

    if (copyRequest.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be rejected",
      });
    }

    // Update copy request
    copyRequest.status = "rejected";
    copyRequest.reason = reason.trim();
    copyRequest.processedBy = adminId;
    copyRequest.processedAt = new Date();
    await copyRequest.save();

    // Get populated response
    const populatedRequest = await Copy.findById(id)
      .populate("user", "firstName lastName email")
      .populate("accounts", "mt5Account accountType")
      .populate("processedBy", "firstName lastName email")
      .lean();

    // Invalidate caches
    await invalidateCopyCaches(copyRequest.user, id);
    emitCopyRequestUpdate(req, copyRequest.user);

    res.status(200).json({
      success: true,
      message: "Copy request rejected successfully",
      data: populatedRequest,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get copy request details
// @route   GET /api/copy/admin/request/:id
// @access  Private (Admin)
exports.getCopyRequestDetails = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid copy request ID",
      });
    }

    const cacheKey = CACHE_KEYS.COPY_REQUEST_DETAILS(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const copyRequest = await Copy.findById(id)
      .populate("user", "firstName lastName email phone country dateofbirth")
      .populate("accounts", "mt5Account accountType leverage balance equity")
      .populate("processedBy", "firstName lastName email")
      .lean();

    if (!copyRequest) {
      return res.status(404).json({
        success: false,
        message: "Copy request not found",
      });
    }

    await cacheService.set(
      cacheKey,
      copyRequest,
      CACHE_TTL.COPY_REQUEST_DETAILS,
    );

    res.status(200).json({
      success: true,
      data: copyRequest,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get copy request statistics for admin dashboard
// @route   GET /api/copy/admin/stats
// @access  Private (Admin)
exports.getCopyRequestStats = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.COPY_REQUEST_STATS;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [stats, totalRequests] = await Promise.all([
      Copy.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]),
      Copy.countDocuments(),
    ]);

    const result = {
      total: totalRequests,
      pending: 0,
      accepted: 0,
      rejected: 0,
    };

    for (const stat of stats) {
      if (stat._id === "pending") result.pending = stat.count;
      if (stat._id === "accepted") result.accepted = stat.count;
      if (stat._id === "rejected") result.rejected = stat.count;
    }

    const completed = result.accepted + result.rejected;
    result.completionRate =
      totalRequests > 0 ? ((completed / totalRequests) * 100).toFixed(1) : 0;

    await cacheService.set(cacheKey, result, CACHE_TTL.COPY_REQUEST_STATS);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Delete a copy request (admin only)
// @route   DELETE /api/copy/admin/:id
// @access  Private (Admin)
exports.deleteCopyRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid copy request ID",
      });
    }

    const copyRequest = await Copy.findById(id);

    if (!copyRequest) {
      return res.status(404).json({
        success: false,
        message: "Copy request not found",
      });
    }

    const userId = copyRequest.user;
    await Copy.findByIdAndDelete(id);

    // Invalidate caches
    await invalidateCopyCaches(userId, id);
    emitCopyRequestUpdate(req, userId);

    res.status(200).json({
      success: true,
      message: "Copy request deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};
// Notify the requesting user + admins that a copy-trading request changed
const emitCopyRequestUpdate = (req, userId) => {
  const io = req.app.get("io");
  if (!io) return;

  if (userId && io.emitCacheInvalidation) {
    io.emitCacheInvalidation(userId, [
      "copyRequests",
      "mastersAndCopiers",
      "copyTradingStats",
    ]);
  }

  if (io.broadcastCacheInvalidation) {
    io.broadcastCacheInvalidation(["adminCopyRequests", "copyRequestStats"]);
  }
};

// Invalidate user's copy request cache
const invalidateUserCopyCache = async (userId) => {
  await cacheService.deletePattern(`copy:user:${userId}:*`);
};

// Invalidate all copy-related caches
const invalidateCopyCaches = async (userId, requestId = null) => {
  const promises = [
    cacheService.deletePattern(`copy:user:${userId}:*`),
    cacheService.deletePattern("copy:admin:all:*"),
    cacheService.deletePattern(CACHE_KEYS.COPY_REQUEST_STATS),
  ];

  if (requestId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.COPY_REQUEST_DETAILS(requestId)),
    );
  }

  await Promise.all(promises);
};

// Export cache invalidation functions
exports.invalidateUserCopyCache = invalidateUserCopyCache;
exports.invalidateCopyCaches = invalidateCopyCaches;

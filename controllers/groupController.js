const Group = require("../models/Group");
const { metaApi } = require("../API/metaApi");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");
const { AppError } = require("../middlewares/errorHandler");
const {
  invalidateIBConfigCaches: invalidateAdminIBConfigCaches,
} = require("./admin/ibAdminConfigurationController");
const {
  invalidatePartnerCaches,
} = require("./admin/adminPartnerController");
require("dotenv").config();

// Cache keys
const CACHE_KEYS = {
  ALL_GROUPS: "groups:all",
  SINGLE_GROUP: (id) => `groups:single:${id}`,
  MT5_GROUPS: "groups:mt5:all",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_GROUPS: 300, // 5 minutes
  SINGLE_GROUP: 600, // 10 minutes
  MT5_GROUPS: 3600, // 1 hour - MT5 groups don't change often
};

// API timeout for MT5 calls
const API_TIMEOUT = 10000; // 10 seconds
// @desc    Get all groups
// @route   GET /api/groups
// @access  Public
exports.getGroups = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_GROUPS;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.length,
        data: cached,
        fromCache: true,
      });
    }

    // Use lean() for better performance
    const groups = await Group.find().populate("leverages").lean();

    // Cache the result
    await cacheService.set(cacheKey, groups, CACHE_TTL.ALL_GROUPS);

    res.status(200).json({
      success: true,
      count: groups.length,
      data: groups,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Create new group
// @route   POST /api/groups
// @access  Private/Admin
exports.createGroup = async (req, res, next) => {
  try {
    const group = await Group.create(req.body);

    // Invalidate groups cache
    await invalidateGroupCaches();

    res.status(201).json({
      success: true,
      data: group,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Update group
// @route   PUT /api/groups/:id
// @access  Private/Admin
exports.updateGroup = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    let group = await Group.findById(id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: `Group not found with id of ${id}`,
      });
    }

    group = await Group.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    // Invalidate caches
    await invalidateGroupCaches(id);

    if (req.body.commissionMode !== undefined) {
      const io = req.app.get("io");
      if (io && io.broadcastGroupCommissionModeUpdate) {
        io.broadcastGroupCommissionModeUpdate(id, group.commissionMode);
      }
    }

    res.status(200).json({
      success: true,
      data: group,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Delete group
// @route   DELETE /api/groups/:id
// @access  Private/Admin
exports.deleteGroup = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    const group = await Group.findById(id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: `Group not found with id of ${id}`,
      });
    }

    await group.deleteOne();

    // Invalidate caches
    await invalidateGroupCaches(id);

    res.status(200).json({
      success: true,
      data: {},
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get MT5 groups from external API
// @route   GET /api/groups/mt5-groups
// @access  Private/Admin
exports.getMt5Groups = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.MT5_GROUPS;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        status: "success",
        message: cached.message,
        totalGroup: cached.totalGroup,
        lstGroups: cached.lstGroups,
        fromCache: true,
      });
    }

    const managerIndex = process.env.Manager_Index;

    if (!managerIndex) {
      return res.status(500).json({
        status: "error",
        message: "Manager Index not configured",
      });
    }

    console.log("🔑 Using Manager Index:", managerIndex);

    const response = await metaApi.get(
      `/GetGroups?Manager_Index=${managerIndex}`,
      {
        timeout: API_TIMEOUT,
      },
    );

    console.log("📦 MT5 RAW RESPONSE received");

    const groups = response.data?.lstGroups || [];

    const result = {
      status: "success",
      message: `Total No of groups is: ${groups.length}`,
      totalGroup: groups.length,
      lstGroups: groups,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.MT5_GROUPS);

    return res.status(200).json(result);
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      return next(new AppError("MT5 API timeout. Please try again.", 504));
    }

    next(new AppError("Failed to fetch MT5 groups", 500));
  }
};
// @desc    Force refresh MT5 groups cache
// @route   POST /api/groups/mt5-groups/refresh
// @access  Private/Admin
exports.refreshMt5Groups = async (req, res, next) => {
  try {
    // Invalidate MT5 groups cache
    await cacheService.deletePattern(CACHE_KEYS.MT5_GROUPS);

    // Fetch fresh data
    const managerIndex = process.env.Manager_Index;

    const response = await metaApi.get(
      `/GetGroups?Manager_Index=${managerIndex}`,
      {
        timeout: API_TIMEOUT,
      },
    );

    const groups = response.data?.lstGroups || [];

    const result = {
      status: "success",
      message: `Total No of groups is: ${groups.length}`,
      totalGroup: groups.length,
      lstGroups: groups,
    };

    await cacheService.set(CACHE_KEYS.MT5_GROUPS, result, CACHE_TTL.MT5_GROUPS);

    return res.status(200).json({
      success: true,
      message: "MT5 groups cache refreshed successfully",
      data: result,
    });
  } catch (error) {
    next(new AppError("Failed to refresh MT5 groups", 500));
  }
};
// @desc    Get single group by ID
// @route   GET /api/groups/:id
// @access  Public
exports.getGroupById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_GROUP(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const group = await Group.findById(id).populate("leverages").lean();

    if (!group) {
      return res.status(404).json({
        success: false,
        message: `Group not found with id of ${id}`,
      });
    }

    await cacheService.set(cacheKey, group, CACHE_TTL.SINGLE_GROUP);

    res.status(200).json({
      success: true,
      data: group,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Bulk create groups
// @route   POST /api/groups/bulk
// @access  Private/Admin
exports.bulkCreateGroups = async (req, res, next) => {
  try {
    const { groups } = req.body;

    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Groups array is required",
      });
    }

    const createdGroups = await Group.insertMany(groups, { ordered: false });

    // Invalidate groups cache
    await invalidateGroupCaches();

    res.status(201).json({
      success: true,
      message: `Created ${createdGroups.length} groups`,
      data: createdGroups,
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(new AppError("Duplicate group name detected", 400));
    }
    next(error);
  }
};
// Invalidate group-related caches, including the admin IB-configuration and
// partner caches that are keyed off group data (e.g. commissionMode) but
// live in other controllers and don't otherwise get cleared on group writes.
const invalidateGroupCaches = async (groupId = null) => {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.ALL_GROUPS),
    invalidateAdminIBConfigCaches(groupId),
    invalidatePartnerCaches(),
  ];

  if (groupId) {
    promises.push(cacheService.deletePattern(CACHE_KEYS.SINGLE_GROUP(groupId)));
  }

  await Promise.all(promises);
  console.log(
    `🗑️ Group caches invalidated${groupId ? ` for ID: ${groupId}` : ""}`,
  );
};

// Export cache invalidation function
exports.invalidateGroupCaches = invalidateGroupCaches;

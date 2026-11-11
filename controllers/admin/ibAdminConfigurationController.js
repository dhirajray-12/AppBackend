// backend/controllers/admin/ibAdminConfigurationController.js - FULLY OPTIMIZED
const IBConfiguration = require("../../models/admin/IBAdminConfiguration");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const Group = require("../../models/Group");
const User = require("../../models/User");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const { invalidateIBConfigCaches: invalidateClientIBConfigCaches } = require("../client/ibClientConfigurationController");
const { AppError } = require("../../middlewares/errorHandler");

// Cache keys
const CACHE_KEYS = {
  IB_CONFIGS_BY_GROUP: (groupId) => `admin:ib:configs:group:${groupId}`,
  ALL_GROUPS_WITH_CONFIGS: "admin:ib:all:groups:with:configs",
  SINGLE_CONFIG: (id) => `admin:ib:config:${id}`,
  ROOT_IBS: "admin:ib:root:list",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  IB_CONFIGS: 300, // 5 minutes - IB configs don't change often
  ALL_GROUPS: 300, // 5 minutes
  SINGLE_CONFIG: 600, // 10 minutes
  ROOT_IBS: 60, // 1 minute
};
// Get the IB configuration (ceiling) for a specific group
exports.getIBConfigurationsByGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    // Validate groupId format
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    const cacheKey = CACHE_KEYS.IB_CONFIGS_BY_GROUP(groupId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        fromCache: true,
      });
    }

    // OPTIMIZED: Single aggregation pipeline
    const [groupExists, configuration] = await Promise.all([
      Group.findById(groupId).select("_id").lean(),
      IBConfiguration.findOne({ groupId, maximumCommission: { $exists: true } })
        .populate("groupId", "name value")
        .lean(),
    ]);

    if (!groupExists) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    const response = {
      success: true,
      data: configuration,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.IB_CONFIGS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// Get all groups with their IB commission ceiling configuration
exports.getAllGroupsWithConfigurations = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_GROUPS_WITH_CONFIGS;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        data: cached.data,
        fromCache: true,
      });
    }

    // OPTIMIZED: Single aggregation pipeline instead of N+1 queries
    const groupsWithConfigs = await Group.aggregate([
      {
        $lookup: {
          from: "ibadminconfigurations",
          let: { groupId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$groupId", "$$groupId"] },
                // Legacy per-level docs (pre-migration) don't have this field —
                // treat them as "no configuration yet" rather than crash consumers.
                maximumCommission: { $exists: true },
              },
            },
            {
              $project: {
                _id: 1,
                maximumCommission: 1,
                defaultTimeInSeconds: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          as: "configuration",
        },
      },
      {
        $addFields: {
          configuration: { $arrayElemAt: ["$configuration", 0] },
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          value: 1,
          description: 1,
          active: 1,
          platforms: 1,
          leverages: 1,
          createdAt: 1,
          updatedAt: 1,
          configuration: 1,
          commissionMode: 1,
        },
      },
      { $sort: { name: 1 } },
    ]);

    const response = {
      success: true,
      count: groupsWithConfigs.length,
      data: groupsWithConfigs,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_GROUPS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// Create new IB configuration (ceiling) for a group
exports.createIBConfiguration = async (req, res, next) => {
  try {
    const { groupId, maximumCommission, defaultTimeInSeconds } = req.body;

    // Validate required fields
    if (!groupId || maximumCommission === undefined) {
      return res.status(400).json({
        success: false,
        message: "Group ID and maximum commission are required",
      });
    }

    // Validate groupId format
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    // Validate maximumCommission
    if (maximumCommission < 0) {
      return res.status(400).json({
        success: false,
        message: "Maximum commission cannot be negative",
      });
    }

    // Run validations in parallel
    const [groupExists, existingConfig] = await Promise.all([
      Group.findById(groupId).select("_id").lean(),
      IBConfiguration.findOne({ groupId, maximumCommission: { $exists: true } }).lean(),
    ]);

    if (!groupExists) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    if (existingConfig) {
      return res.status(400).json({
        success: false,
        message: "This group already has a commission ceiling configured. Use update instead.",
      });
    }

    // Create new configuration
    const newConfig = await IBConfiguration.create({
      groupId,
      maximumCommission,
      defaultTimeInSeconds: defaultTimeInSeconds || 0,
    });

    // Invalidate relevant caches
    await invalidateIBConfigCaches(groupId);

    res.status(201).json({
      success: true,
      data: newConfig,
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(new AppError("This group already has a commission ceiling configured.", 400));
    }

    next(error);
  }
};
// Update IB configuration (ceiling)
exports.updateIBConfiguration = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { maximumCommission, defaultTimeInSeconds } = req.body;

    // Validate id format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid configuration ID format",
      });
    }

    // Validate maximumCommission
    if (maximumCommission !== undefined && maximumCommission < 0) {
      return res.status(400).json({
        success: false,
        message: "Maximum commission cannot be negative",
      });
    }

    // Build update object dynamically
    const updateData = {};
    if (maximumCommission !== undefined) updateData.maximumCommission = maximumCommission;
    if (defaultTimeInSeconds !== undefined)
      updateData.defaultTimeInSeconds = defaultTimeInSeconds;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update",
      });
    }

    // Get the config first to know groupId for cache invalidation
    const oldConfig = await IBConfiguration.findById(id).lean();

    const updatedConfig = await IBConfiguration.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true },
    ).populate("groupId", "name value");

    if (!updatedConfig) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found",
      });
    }

    // Invalidate caches
    await invalidateIBConfigCaches(oldConfig?.groupId);
    await cacheService.deletePattern(CACHE_KEYS.SINGLE_CONFIG(id));

    res.status(200).json({
      success: true,
      data: updatedConfig,
    });
  } catch (error) {
    next(error);
  }
};
// Update default time for the configuration in a group
exports.updateGroupDefaultTime = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { defaultTimeInSeconds } = req.body;

    // Validate groupId format
    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    // Validate defaultTimeInSeconds
    if (defaultTimeInSeconds === undefined) {
      return res.status(400).json({
        success: false,
        message: "Default time in seconds is required",
      });
    }

    if (defaultTimeInSeconds < 0) {
      return res.status(400).json({
        success: false,
        message: "Default time cannot be negative",
      });
    }

    // Check if group exists first
    const groupExists = await Group.findById(groupId).select("_id").lean();
    if (!groupExists) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Update the configuration for this group
    const updatedConfig = await IBConfiguration.findOneAndUpdate(
      { groupId },
      { defaultTimeInSeconds },
      { runValidators: true },
    );

    // Invalidate caches
    await invalidateIBConfigCaches(groupId);

    res.status(200).json({
      success: true,
      message: updatedConfig
        ? "Default time updated"
        : "No configuration exists yet for this group",
      data: {
        modifiedCount: updatedConfig ? 1 : 0,
      },
    });
  } catch (error) {
    next(error);
  }
};
// Delete IB configuration
exports.deleteIBConfiguration = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Validate id format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid configuration ID format",
      });
    }

    // Get the config first to know groupId for cache invalidation
    const configToDelete = await IBConfiguration.findById(id).lean();

    if (!configToDelete) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found",
      });
    }

    const deletedConfig = await IBConfiguration.findByIdAndDelete(id);

    if (!deletedConfig) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found",
      });
    }

    // Invalidate caches
    await invalidateIBConfigCaches(configToDelete.groupId);
    await cacheService.deletePattern(CACHE_KEYS.SINGLE_CONFIG(id));

    res.status(200).json({
      success: true,
      message: "IB configuration deleted successfully",
      data: {},
    });
  } catch (error) {
    next(error);
  }
};
// Get single IB configuration by ID (additional utility function)
exports.getIBConfigurationById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid configuration ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_CONFIG(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const config = await IBConfiguration.findById(id)
      .populate("groupId", "name value description")
      .lean();

    if (!config) {
      return res.status(404).json({
        success: false,
        message: "IB configuration not found",
      });
    }

    // Cache the response
    await cacheService.set(cacheKey, config, CACHE_TTL.SINGLE_CONFIG);

    res.status(200).json({
      success: true,
      data: config,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List all root-level IBs (no parent) for admin assignment
// @route   GET /api/ib-configurations/root-ibs
// @access  Private (Admin)
exports.getRootIBs = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ROOT_IBS;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const rootConfigs = await IBClientConfiguration.find({ parent: null })
      .populate("userId", "firstName lastName email")
      .populate("groupId", "name value")
      .sort({ createdAt: -1 })
      .lean();

    const data = rootConfigs
      .filter((config) => config.userId)
      .map((config) => ({
        ...config,
        maximumCommission: config.maximumCommission ?? null,
      }));

    await cacheService.set(cacheKey, data, CACHE_TTL.ROOT_IBS);

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Admin assigns/updates the maximum commission for a root IB
// @route   POST /api/ib-configurations/root/assign
// @access  Private (Admin)
exports.assignRootIBCommission = async (req, res, next) => {
  try {
    const { userId, groupId, maximumCommission } = req.body;

    if (!userId || !groupId || maximumCommission === undefined) {
      return res.status(400).json({
        success: false,
        message: "userId, groupId, and maximumCommission are required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(userId) ||
      !mongoose.Types.ObjectId.isValid(groupId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid userId or groupId format",
      });
    }

    if (maximumCommission < 0) {
      return res.status(400).json({
        success: false,
        message: "Maximum commission cannot be negative",
      });
    }

    const [user, groupConfig] = await Promise.all([
      User.findById(userId).select("_id firstName lastName email").lean(),
      IBConfiguration.findOne({ groupId, maximumCommission: { $exists: true } }).lean(),
    ]);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!groupConfig) {
      return res.status(400).json({
        success: false,
        message: "This group has no commission ceiling configured yet",
      });
    }

    if (maximumCommission > groupConfig.maximumCommission) {
      return res.status(400).json({
        success: false,
        message: `Maximum commission cannot exceed the group ceiling of ${groupConfig.maximumCommission}`,
      });
    }

    let ibConfig = await IBClientConfiguration.findOne({ userId });

    if (ibConfig && ibConfig.parent) {
      return res.status(400).json({
        success: false,
        message: "This user already has a referring IB and cannot be assigned as a root IB",
      });
    }

    if (!ibConfig) {
      ibConfig = new IBClientConfiguration({
        userId,
        parent: null,
        level: 0,
        status: "active",
      });
    }

    ibConfig.maximumCommission = maximumCommission;
    ibConfig.groupId = groupId;
    if (ibConfig.status === "pending") {
      ibConfig.status = "active";
    }

    await ibConfig.save();

    await Promise.all([
      cacheService.deletePattern(CACHE_KEYS.ROOT_IBS),
      invalidateClientIBConfigCaches(userId),
    ]);

    res.status(200).json({
      success: true,
      message: "Root IB commission assigned successfully",
      data: ibConfig,
    });
  } catch (error) {
    next(error);
  }
};

// Invalidate caches for a specific group
async function invalidateIBConfigCaches(groupId) {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.IB_CONFIGS_BY_GROUP(groupId)),
    cacheService.deletePattern(CACHE_KEYS.ALL_GROUPS_WITH_CONFIGS),
  ];

  if (groupId) {
    promises.push(
      cacheService.deletePattern(`admin:ib:configs:group:${groupId}`),
    );
  }

  await Promise.all(promises);
  console.log(
    `🗑️ IB configuration cache invalidated for group: ${groupId || "all"}`,
  );
}

// Invalidate all IB configuration caches
async function invalidateAllIBConfigCaches() {
  await Promise.all([
    cacheService.deletePattern("admin:ib:configs:group:*"),
    cacheService.deletePattern(CACHE_KEYS.ALL_GROUPS_WITH_CONFIGS),
    cacheService.deletePattern("admin:ib:config:*"),
    cacheService.deletePattern(CACHE_KEYS.ROOT_IBS),
  ]);
  console.log("🗑️ All IB configuration caches invalidated");
}

// Export cache invalidation functions for use in other controllers
exports.invalidateIBConfigCaches = invalidateIBConfigCaches;
exports.invalidateAllIBConfigCaches = invalidateAllIBConfigCaches;

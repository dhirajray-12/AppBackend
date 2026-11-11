// backend/controllers/admin/ibFlatCommissionController.js
// Admin CRUD for the "Normal" (flat per-level) commission mode: a fixed
// bonus-per-lot per upline level (1-10) in a group. Kept fully separate
// from ibAdminConfigurationController (the ceiling/waterfall model) and its
// IBAdminConfiguration collection so the two shapes are never mixed.
const IBFlatCommissionConfiguration = require("../../models/admin/IBFlatCommissionConfiguration");
const Group = require("../../models/Group");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const { AppError } = require("../../middlewares/errorHandler");

// Cache keys
const CACHE_KEYS = {
  FLAT_CONFIGS_BY_GROUP: (groupId) => `admin:ib:flat:configs:group:${groupId}`,
  ALL_GROUPS_WITH_FLAT_CONFIGS: "admin:ib:flat:all:groups:with:configs",
  SINGLE_CONFIG: (id) => `admin:ib:flat:config:${id}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  FLAT_CONFIGS: 300,
  ALL_GROUPS: 300,
  SINGLE_CONFIG: 600,
};

// Get all flat commission level configurations for a specific group
exports.getFlatConfigurationsByGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    const cacheKey = CACHE_KEYS.FLAT_CONFIGS_BY_GROUP(groupId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        data: cached.data,
        fromCache: true,
      });
    }

    const [groupExists, configurations] = await Promise.all([
      Group.findById(groupId).select("_id").lean(),
      IBFlatCommissionConfiguration.find({ groupId })
        .sort({ level: 1 })
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
      count: configurations.length,
      data: configurations,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.FLAT_CONFIGS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

// Get all groups with their flat commission level configurations
exports.getAllGroupsWithFlatConfigurations = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_GROUPS_WITH_FLAT_CONFIGS;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        data: cached.data,
        fromCache: true,
      });
    }

    const groupsWithConfigs = await Group.aggregate([
      {
        $lookup: {
          from: "ibflatcommissionconfigurations",
          let: { groupId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$groupId", "$$groupId"] },
              },
            },
            { $sort: { level: 1 } },
            {
              $project: {
                _id: 1,
                level: 1,
                bonusPerLot: 1,
                defaultTimeInSeconds: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          as: "configurations",
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          value: 1,
          description: 1,
          active: 1,
          commissionMode: 1,
          configurations: 1,
        },
      },
      { $sort: { name: 1 } },
    ]);

    const response = {
      success: true,
      count: groupsWithConfigs.length,
      data: groupsWithConfigs,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_GROUPS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

// Create a new flat commission level configuration
exports.createFlatConfiguration = async (req, res, next) => {
  try {
    const { groupId, level, bonusPerLot, defaultTimeInSeconds } = req.body;

    if (!groupId || !level || bonusPerLot === undefined) {
      return res.status(400).json({
        success: false,
        message: "Group ID, level, and bonus per lot are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    if (level < 1 || level > 10) {
      return res.status(400).json({
        success: false,
        message: "Level must be between 1 and 10",
      });
    }

    if (bonusPerLot < 0) {
      return res.status(400).json({
        success: false,
        message: "Bonus per lot cannot be negative",
      });
    }

    const [groupExists, existingConfig] = await Promise.all([
      Group.findById(groupId).select("_id").lean(),
      IBFlatCommissionConfiguration.findOne({ groupId, level }).lean(),
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
        message: `Level ${level} already exists for this group`,
      });
    }

    const newConfig = await IBFlatCommissionConfiguration.create({
      groupId,
      level,
      bonusPerLot,
      defaultTimeInSeconds: defaultTimeInSeconds || 0,
    });

    await invalidateFlatConfigCaches(groupId);

    res.status(201).json({
      success: true,
      data: newConfig,
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(new AppError("Configuration with this group and level already exists", 400));
    }

    next(error);
  }
};

// Update a flat commission level configuration
exports.updateFlatConfiguration = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { bonusPerLot, defaultTimeInSeconds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid configuration ID format",
      });
    }

    if (bonusPerLot !== undefined && bonusPerLot < 0) {
      return res.status(400).json({
        success: false,
        message: "Bonus per lot cannot be negative",
      });
    }

    const updateData = {};
    if (bonusPerLot !== undefined) updateData.bonusPerLot = bonusPerLot;
    if (defaultTimeInSeconds !== undefined)
      updateData.defaultTimeInSeconds = defaultTimeInSeconds;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update",
      });
    }

    const oldConfig = await IBFlatCommissionConfiguration.findById(id).lean();

    const updatedConfig = await IBFlatCommissionConfiguration.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true },
    ).populate("groupId", "name value");

    if (!updatedConfig) {
      return res.status(404).json({
        success: false,
        message: "Flat commission configuration not found",
      });
    }

    await invalidateFlatConfigCaches(oldConfig?.groupId);
    await cacheService.deletePattern(CACHE_KEYS.SINGLE_CONFIG(id));

    res.status(200).json({
      success: true,
      data: updatedConfig,
    });
  } catch (error) {
    next(error);
  }
};

// Update default hold time for all levels in a group
exports.updateGroupDefaultTime = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { defaultTimeInSeconds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid group ID format",
      });
    }

    if (defaultTimeInSeconds === undefined || defaultTimeInSeconds < 0) {
      return res.status(400).json({
        success: false,
        message: "A valid, non-negative default time in seconds is required",
      });
    }

    const groupExists = await Group.findById(groupId).select("_id").lean();
    if (!groupExists) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    const updatedConfigs = await IBFlatCommissionConfiguration.updateMany(
      { groupId },
      { defaultTimeInSeconds },
      { runValidators: true },
    );

    await invalidateFlatConfigCaches(groupId);

    res.status(200).json({
      success: true,
      message: `Updated ${updatedConfigs.modifiedCount} configurations`,
      data: {
        modifiedCount: updatedConfigs.modifiedCount,
        matchedCount: updatedConfigs.matchedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Delete a flat commission level configuration
exports.deleteFlatConfiguration = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid configuration ID format",
      });
    }

    const configToDelete = await IBFlatCommissionConfiguration.findById(id).lean();

    if (!configToDelete) {
      return res.status(404).json({
        success: false,
        message: "Flat commission configuration not found",
      });
    }

    await IBFlatCommissionConfiguration.findByIdAndDelete(id);

    await invalidateFlatConfigCaches(configToDelete.groupId);
    await cacheService.deletePattern(CACHE_KEYS.SINGLE_CONFIG(id));

    res.status(200).json({
      success: true,
      message: "Flat commission configuration deleted successfully",
      data: {},
    });
  } catch (error) {
    next(error);
  }
};

// Invalidate caches for a specific group
async function invalidateFlatConfigCaches(groupId) {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.FLAT_CONFIGS_BY_GROUP(groupId)),
    cacheService.deletePattern(CACHE_KEYS.ALL_GROUPS_WITH_FLAT_CONFIGS),
  ];

  if (groupId) {
    promises.push(
      cacheService.deletePattern(`admin:ib:flat:configs:group:${groupId}`),
    );
  }

  await Promise.all(promises);
  console.log(
    `🗑️ Flat commission configuration cache invalidated for group: ${groupId || "all"}`,
  );
}

exports.invalidateFlatConfigCaches = invalidateFlatConfigCaches;

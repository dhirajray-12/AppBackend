const Leverage = require("../models/Leverage");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");
const { AppError } = require("../middlewares/errorHandler");

// Cache keys
const CACHE_KEYS = {
  ALL_LEVERAGES: "leverages:all",
  SINGLE_LEVERAGE: (id) => `leverages:single:${id}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_LEVERAGES: 3600, // 1 hour - leverages don't change often
  SINGLE_LEVERAGE: 3600, // 1 hour
};

// @desc    Get all leverages
// @route   GET /api/leverages
// @access  Public
exports.getLeverages = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_LEVERAGES;

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
    const leverages = await Leverage.find().sort({ value: 1 }).lean();

    // Cache the result
    await cacheService.set(cacheKey, leverages, CACHE_TTL.ALL_LEVERAGES);

    res.status(200).json({
      success: true,
      count: leverages.length,
      data: leverages,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new leverage
// @route   POST /api/leverages
// @access  Private/Admin
exports.createLeverage = async (req, res, next) => {
  try {
    const { name, value, active } = req.body;

    // Validation
    if (!name || !value) {
      return res.status(400).json({
        success: false,
        message: "Name and value are required",
      });
    }

    // Check for duplicate name or value (optimized with lean)
    const existingLeverage = await Leverage.findOne({
      $or: [{ name }, { value }],
    }).lean();

    if (existingLeverage) {
      return res.status(400).json({
        success: false,
        message: "Leverage with this name or value already exists",
      });
    }

    // Create leverage
    const leverage = await Leverage.create({
      name,
      value: Number(value),
      active: active !== undefined ? active : true,
    });

    // Invalidate cache
    await invalidateLeverageCaches();

    res.status(201).json({
      success: true,
      message: "Leverage created successfully",
      data: leverage,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(
        new AppError(
          Object.values(error.errors)
            .map((e) => e.message)
            .join(", "),
          400,
        ),
      );
    }

    if (error.code === 11000) {
      return next(new AppError("Leverage already exists", 400));
    }

    next(error);
  }
};

// @desc    Update leverage
// @route   PUT /api/leverages/:id
// @access  Private/Admin
exports.updateLeverage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, value, active } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid leverage ID format",
      });
    }

    let leverage = await Leverage.findById(id).lean();

    if (!leverage) {
      return res.status(404).json({
        success: false,
        message: `Leverage not found with id of ${id}`,
      });
    }

    // Prepare update data
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (value !== undefined) updateData.value = Number(value);
    if (active !== undefined) updateData.active = active;

    // Update leverage
    leverage = await Leverage.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    // Invalidate caches
    await invalidateLeverageCaches(id);

    res.status(200).json({
      success: true,
      message: "Leverage updated successfully",
      data: leverage,
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(
        new AppError(
          Object.values(error.errors)
            .map((e) => e.message)
            .join(", "),
          400,
        ),
      );
    }

    if (error.code === 11000) {
      return next(new AppError("Leverage name or value already exists", 400));
    }

    next(error);
  }
};

// @desc    Delete leverage
// @route   DELETE /api/leverages/:id
// @access  Private/Admin
exports.deleteLeverage = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid leverage ID format",
      });
    }

    const leverage = await Leverage.findById(id);

    if (!leverage) {
      return res.status(404).json({
        success: false,
        message: `Leverage not found with id of ${id}`,
      });
    }

    await leverage.deleteOne();

    // Invalidate caches
    await invalidateLeverageCaches(id);

    res.status(200).json({
      success: true,
      message: "Leverage deleted successfully",
      data: {},
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single leverage by ID
// @route   GET /api/leverages/:id
// @access  Public
exports.getLeverageById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid leverage ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_LEVERAGE(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const leverage = await Leverage.findById(id).lean();

    if (!leverage) {
      return res.status(404).json({
        success: false,
        message: `Leverage not found with id of ${id}`,
      });
    }

    await cacheService.set(cacheKey, leverage, CACHE_TTL.SINGLE_LEVERAGE);

    res.status(200).json({
      success: true,
      data: leverage,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create leverages
// @route   POST /api/leverages/bulk
// @access  Private/Admin
exports.bulkCreateLeverages = async (req, res, next) => {
  try {
    const { leverages } = req.body;

    if (!leverages || !Array.isArray(leverages) || leverages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Leverages array is required",
      });
    }

    // Validate all leverages
    for (const lev of leverages) {
      if (!lev.name || !lev.value) {
        return res.status(400).json({
          success: false,
          message: "Each leverage must have name and value",
        });
      }
    }

    // Check for duplicates in the request
    const names = leverages.map((l) => l.name);
    const values = leverages.map((l) => l.value);
    if (
      new Set(names).size !== names.length ||
      new Set(values).size !== values.length
    ) {
      return res.status(400).json({
        success: false,
        message: "Duplicate name or value found in request",
      });
    }

    // Check for existing leverages
    const existing = await Leverage.find({
      $or: [{ name: { $in: names } }, { value: { $in: values } }],
    })
      .select("name value")
      .lean();

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some leverages already exist",
        existing: existing.map((e) => ({ name: e.name, value: e.value })),
      });
    }

    // Prepare data for bulk insert
    const leveragesToCreate = leverages.map((lev) => ({
      name: lev.name,
      value: Number(lev.value),
      active: lev.active !== undefined ? lev.active : true,
    }));

    const createdLeverages = await Leverage.insertMany(leveragesToCreate, {
      ordered: false,
    });

    // Invalidate cache
    await invalidateLeverageCaches();

    res.status(201).json({
      success: true,
      message: `Created ${createdLeverages.length} leverages successfully`,
      data: createdLeverages,
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(new AppError("Duplicate leverage detected", 400));
    }

    next(error);
  }
};

// @desc    Get only active leverages
// @route   GET /api/leverages/active
// @access  Public
exports.getActiveLeverages = async (req, res, next) => {
  try {
    const cacheKey = "leverages:active";

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.length,
        data: cached,
        fromCache: true,
      });
    }

    const leverages = await Leverage.find({ active: true })
      .sort({ value: 1 })
      .lean();

    await cacheService.set(cacheKey, leverages, CACHE_TTL.ALL_LEVERAGES);

    res.status(200).json({
      success: true,
      count: leverages.length,
      data: leverages,
    });
  } catch (error) {
    next(error);
  }
};

// Invalidate leverage-related caches
const invalidateLeverageCaches = async (leverageId = null) => {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.ALL_LEVERAGES),
    cacheService.deletePattern("leverages:active"),
  ];

  if (leverageId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_LEVERAGE(leverageId)),
    );
  }

  await Promise.all(promises);
  console.log(
    `🗑️ Leverage caches invalidated${leverageId ? ` for ID: ${leverageId}` : ""}`,
  );
};

// Export cache invalidation function
exports.invalidateLeverageCaches = invalidateLeverageCaches;

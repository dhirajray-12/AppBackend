
const PaymentMethod = require("../models/PaymentMethod");
const path = require("path");
const multer = require("multer");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");
const {
  normalizePaymentMethodAssetFields,
} = require("../utils/assetPaths");
const {
  invalidateDepositPaymentMethodCache,
} = require("./client/depositController");
const {
  uploadBufferToCloudinary,
  deleteFromCloudinary,
} = require("../utils/cloudinary");
const { AppError } = require("../middlewares/errorHandler");

// Cache keys
const CACHE_KEYS = {
  ADMIN_PAYMENT_METHODS: "payment:methods:admin:all",
  SINGLE_PAYMENT_METHOD: (id) => `payment:method:${id}`,
  ALL_ACTIVE_METHODS: "payment:methods:active",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ADMIN_PAYMENT_METHODS: 300, // 5 minutes
  SINGLE_PAYMENT_METHOD: 600, // 10 minutes
  ALL_ACTIVE_METHODS: 3600, // 1 hour
};

// Multer configuration for file upload (buffer kept in memory, then pushed to Cloudinary)
const storage = multer.memoryStorage();

// File filter for image uploads
const fileFilter = (req, file, cb) => {
  const allowedFileTypes = /\.(jpg|jpeg|png|gif|webp)$/i;
  const extname = allowedFileTypes.test(path.extname(file.originalname));
  const mimetype = file.mimetype.startsWith("image/");

  if (extname && mimetype) {
    return cb(null, true);
  }

  cb(new Error("Error: Images only (jpeg, jpg, png, gif, webp)!"), false);
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1,
  },
});

// Upload a QR code image buffer to Cloudinary
const uploadQrCode = (buffer) =>
  uploadBufferToCloudinary(buffer, {
    folder: "payment-qr-codes",
    resourceType: "image",
  });

// Broadcast a realtime payment-method change to everyone (admin list + client deposit form)
const emitPaymentMethodUpdate = (req) => {
  const io = req.app.get("io");
  if (!io) return;

  if (io.invalidateAllUsersCache) {
    io.invalidateAllUsersCache([
      "adminPaymentMethods",
      "clientPaymentMethods",
      "paymentMethod",
    ]);
  }
};
exports.getPaymentMethods = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ADMIN_PAYMENT_METHODS;

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

    const paymentMethods = await PaymentMethod.find({})
      .sort({ createdAt: -1 })
      .lean();
    const normalizedPaymentMethods = paymentMethods.map(
      normalizePaymentMethodAssetFields,
    );

    await cacheService.set(
      cacheKey,
      normalizedPaymentMethods,
      CACHE_TTL.ADMIN_PAYMENT_METHODS,
    );

    res.status(200).json({
      success: true,
      count: normalizedPaymentMethods.length,
      data: normalizedPaymentMethods,
    });
  } catch (error) {
    next(error);
  }
};
exports.createPaymentMethod = async (req, res, next) => {
  upload.single("qrCode")(req, res, async (err) => {
    // Handle multer errors
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message:
          err.code === "LIMIT_FILE_SIZE"
            ? "File size limit exceeded. Maximum 5MB allowed."
            : err.message,
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "File upload error",
      });
    }

    try {
      const paymentMethodData = {
        ...req.body,
        user: req.user._id,
      };

      if (req.file) {
        const uploaded = await uploadQrCode(req.file.buffer);
        paymentMethodData.qrCode = uploaded.secure_url;
        paymentMethodData.qrCodePublicId = uploaded.public_id;
        paymentMethodData.paymentLink = req.body.paymentLink || "";
      }

      const paymentMethod = await PaymentMethod.create(paymentMethodData);
      const normalizedPaymentMethod = normalizePaymentMethodAssetFields(
        paymentMethod.toObject(),
      );

      // Invalidate caches
      await invalidatePaymentMethodCaches(paymentMethod._id);
      await invalidateDepositPaymentMethodCache();
      emitPaymentMethodUpdate(req);

      res.status(201).json({
        success: true,
        data: normalizedPaymentMethod,
      });
    } catch (error) {
      next(new AppError(`Error creating payment method: ${error.message}`, 400));
    }
  });
};
exports.updatePaymentMethod = async (req, res, next) => {
  upload.single("qrCode")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message:
          err.code === "LIMIT_FILE_SIZE"
            ? "File size limit exceeded. Maximum 5MB allowed."
            : err.message,
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "File upload error",
      });
    }

    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment method ID format",
        });
      }

      const updateData = { ...req.body };

      if (req.file) {
        const existingMethod = await PaymentMethod.findById(id).lean();
        const uploaded = await uploadQrCode(req.file.buffer);
        updateData.qrCode = uploaded.secure_url;
        updateData.qrCodePublicId = uploaded.public_id;
        if (existingMethod?.qrCodePublicId) {
          await deleteFromCloudinary(existingMethod.qrCodePublicId);
        }
      }

      const paymentMethod = await PaymentMethod.findOneAndUpdate(
        { _id: id },
        updateData,
        { new: true, runValidators: true },
      );

      if (!paymentMethod) {
        return res.status(404).json({
          success: false,
          message: "Payment method not found",
        });
      }

      const normalizedPaymentMethod = normalizePaymentMethodAssetFields(
        paymentMethod.toObject(),
      );

      // Invalidate caches
      await invalidatePaymentMethodCaches(id);
      await invalidateDepositPaymentMethodCache();
      emitPaymentMethodUpdate(req);

      res.status(200).json({
        success: true,
        data: normalizedPaymentMethod,
      });
    } catch (error) {
      next(new AppError(`Error updating payment method: ${error.message}`, 400));
    }
  });
};
exports.deletePaymentMethod = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method ID format",
      });
    }

    const paymentMethod = await PaymentMethod.findById(id);

    if (!paymentMethod) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    if (paymentMethod.qrCodePublicId) {
      await deleteFromCloudinary(paymentMethod.qrCodePublicId);
    }

    await PaymentMethod.findByIdAndDelete(id);

    // Invalidate caches
    await invalidatePaymentMethodCaches(id);
    await invalidateDepositPaymentMethodCache();
    emitPaymentMethodUpdate(req);

    res.status(200).json({
      success: true,
      data: {},
    });
  } catch (error) {
    next(new AppError(`Error deleting payment method: ${error.message}`, 400));
  }
};
exports.uploadPaymentMethodQR = async (req, res, next) => {
  upload.single("qrCode")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message:
          err.code === "LIMIT_FILE_SIZE"
            ? "File size limit exceeded. Maximum 5MB allowed."
            : err.message,
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || "File upload error",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment method ID format",
        });
      }

      // Delete old QR code if exists
      const existingMethod = await PaymentMethod.findById(id).lean();
      const uploaded = await uploadQrCode(req.file.buffer);
      if (existingMethod?.qrCodePublicId) {
        await deleteFromCloudinary(existingMethod.qrCodePublicId);
      }

      const paymentMethod = await PaymentMethod.findOneAndUpdate(
        { _id: id },
        {
          qrCode: uploaded.secure_url,
          qrCodePublicId: uploaded.public_id,
          paymentLink: req.body.paymentLink || "",
        },
        { new: true },
      );

      if (!paymentMethod) {
        return res.status(404).json({
          success: false,
          message: "Payment method not found",
        });
      }

      const normalizedPaymentMethod = normalizePaymentMethodAssetFields(
        paymentMethod.toObject(),
      );

      // Invalidate caches
      await invalidatePaymentMethodCaches(id);
      await invalidateDepositPaymentMethodCache();
      emitPaymentMethodUpdate(req);

      res.status(200).json({
        success: true,
        data: normalizedPaymentMethod,
      });
    } catch (error) {
      next(new AppError(`Error uploading QR code: ${error.message}`, 400));
    }
  });
};
exports.getPaymentMethodDetails = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_PAYMENT_METHOD(id);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const paymentMethod = await PaymentMethod.findById(id).lean();

    if (!paymentMethod) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    const normalizedPaymentMethod =
      normalizePaymentMethodAssetFields(paymentMethod);

    await cacheService.set(
      cacheKey,
      normalizedPaymentMethod,
      CACHE_TTL.SINGLE_PAYMENT_METHOD,
    );

    res.status(200).json({
      success: true,
      data: normalizedPaymentMethod,
    });
  } catch (error) {
    next(new AppError(`Error fetching payment method details: ${error.message}`, 400));
  }
};
// Get all active payment methods (for client deposit form)
exports.getActivePaymentMethods = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.ALL_ACTIVE_METHODS;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const paymentMethods = await PaymentMethod.find({ active: true }).lean();
    const normalizedPaymentMethods = paymentMethods.map(
      normalizePaymentMethodAssetFields,
    );

    // Group by type
    const groupedMethods = normalizedPaymentMethods.reduce((acc, method) => {
      if (!acc[method.type]) {
        acc[method.type] = [];
      }
      acc[method.type].push(method);
      return acc;
    }, {});

    await cacheService.set(
      cacheKey,
      groupedMethods,
      CACHE_TTL.ALL_ACTIVE_METHODS,
    );

    res.status(200).json({
      success: true,
      data: groupedMethods,
    });
  } catch (error) {
    next(error);
  }
};
// Toggle payment method active status
exports.togglePaymentMethodStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method ID format",
      });
    }

    const paymentMethod = await PaymentMethod.findById(id);

    if (!paymentMethod) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    paymentMethod.active = !paymentMethod.active;
    await paymentMethod.save();
    const normalizedPaymentMethod = normalizePaymentMethodAssetFields(
      paymentMethod.toObject(),
    );

    // Invalidate caches
    await invalidatePaymentMethodCaches(id);
    await cacheService.deletePattern(CACHE_KEYS.ALL_ACTIVE_METHODS);
    await invalidateDepositPaymentMethodCache();
    emitPaymentMethodUpdate(req);

    res.status(200).json({
      success: true,
      message: `Payment method ${paymentMethod.active ? "activated" : "deactivated"} successfully`,
      data: normalizedPaymentMethod,
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate payment method caches
const invalidatePaymentMethodCaches = async (methodId = null) => {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.ADMIN_PAYMENT_METHODS),
    cacheService.deletePattern(CACHE_KEYS.ALL_ACTIVE_METHODS),
  ];

  if (methodId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_PAYMENT_METHOD(methodId)),
    );
  }

  await Promise.all(promises);
  console.log("🗑️ Payment method caches invalidated");
};

// Export cache invalidation function
exports.invalidatePaymentMethodCaches = invalidatePaymentMethodCaches;

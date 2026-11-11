// Backend/controllers/client/depositController.js - FULLY OPTIMIZED
const path = require("path");
const Deposit = require("../../models/Deposit");
const Account = require("../../models/client/Account");
const PaymentMethod = require("../../models/PaymentMethod");
const multer = require("multer");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const {
  normalizeDepositAssetFields,
  normalizePaymentMethodAssetFields,
} = require("../../utils/assetPaths");
const {
  uploadBufferToCloudinary,
  deleteFromCloudinary,
} = require("../../utils/cloudinary");

// Cache keys
const CACHE_KEYS = {
  USER_DEPOSITS: (userId, page, limit) =>
    `client:deposits:${userId}:${page}:${limit}`,
  SINGLE_DEPOSIT: (depositId) => `client:deposit:${depositId}`,
  ACTIVE_PAYMENT_METHODS: "client:payment:methods:active",
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_DEPOSITS: 30, // 30 seconds
  SINGLE_DEPOSIT: 60, // 1 minute
  ACTIVE_PAYMENT_METHODS: 300, // 5 minutes
};

// Configure storage for proof of payment uploads (kept in memory, then pushed to Cloudinary)
const storage = multer.memoryStorage();

// Configure file filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = [".pdf", ".jpg", ".jpeg", ".png"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only PDF, PNG, JPG, and JPEG files are allowed.",
      ),
      false,
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Middleware for handling file uploads
exports.uploadProofOfPayment = upload.single("proofOfPayment");
// Create a new deposit
exports.createDeposit = async (req, res, next) => {
  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Proof of payment is required",
      });
    }

    const { accountId, amount, paymentMethodId, paymentType, transactionId } =
      req.body;

    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit amount. Amount must be greater than 0",
      });
    }

    // OPTIMIZED: Run validations in parallel
    const [account, paymentMethod] = await Promise.all([
      Account.findById(accountId).lean(),
      PaymentMethod.findById(paymentMethodId).lean(),
    ]);

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    if (account.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized access to this account",
      });
    }

    if (!paymentMethod) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    if (!paymentMethod.active) {
      return res.status(400).json({
        success: false,
        message: "Selected payment method is not active",
      });
    }

    const uploadedProof = await uploadBufferToCloudinary(req.file.buffer, {
      folder: "deposit-proofs",
      resourceType: "auto",
    });

    // Create deposit record
    const deposit = await Deposit.create({
      user: req.user.id,
      account: accountId,
      amount: parseFloat(amount),
      paymentMethod: paymentMethodId,
      paymentType,
      proofOfPayment: uploadedProof.secure_url,
      proofOfPaymentPublicId: uploadedProof.public_id,
      transactionId,
    });

    // Invalidate user deposits cache
    await invalidateDepositCaches(req.user.id);

    // Populate required fields for notifications
    await deposit.populate([
      { path: "account", select: "mt5Account accountType balance equity" },
      { path: "user", select: "firstName lastName email" },
      { path: "paymentMethod", select: "type bankName walletName" },
    ]);

    // Trigger notifications
    if (req.notificationTriggers) {
      await req.notificationTriggers.handleDepositStatusChange(
        deposit.toObject(),
        null,
      );
    }

    const io = req.app.get("io");
    if (io) {
      const realtimeDeposit = normalizeDepositAssetFields(deposit.toObject());

      if (io.emitDepositUpdate) {
        io.emitDepositUpdate(realtimeDeposit, null);
      }

      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(req.user.id, [
          "deposits",
          "dashboard",
          "transactions",
          "dashboardData",
          "accounts",
          "availableBalances",
          "withdrawalAccounts",
          "accountActivity",
        ]);
      }

      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation(["admin_deposits", "admin_dashboard"]);
      }
    }

    res.status(201).json({
      success: true,
      message: "Deposit request submitted successfully",
      data: normalizeDepositAssetFields(deposit.toObject()),
    });
  } catch (error) {
    next(error);
  }
};
// Get all deposits for the logged-in user with pagination
exports.getMyDeposits = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = CACHE_KEYS.USER_DEPOSITS(req.user.id, pageNum, limitNum);

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
    const query = { user: req.user.id };
    if (status && status !== "all") {
      query.status = status;
    }

    // Run queries in parallel
    const [deposits, total] = await Promise.all([
      Deposit.find(query)
        .populate("account", "mt5Account accountType")
        .populate("paymentMethod", "type bankName walletName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Deposit.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    const normalizedDeposits = deposits.map(normalizeDepositAssetFields);

    const response = {
      success: true,
      count: normalizedDeposits.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: normalizedDeposits,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.USER_DEPOSITS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// Get a single deposit by ID
exports.getDepositById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_DEPOSIT(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached && cached.user === req.user.id) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const deposit = await Deposit.findById(id)
      .populate("account", "mt5Account accountType")
      .populate(
        "paymentMethod",
        "type bankName walletName accountHolderName accountNumber ifsc_swift walletAddress",
      )
      .lean();

    if (!deposit) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found",
      });
    }

    // Check if deposit belongs to user
    if (deposit.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized access to this deposit",
      });
    }

    // Cache the deposit
    const normalizedDeposit = normalizeDepositAssetFields(deposit);

    await cacheService.set(
      cacheKey,
      normalizedDeposit,
      CACHE_TTL.SINGLE_DEPOSIT,
    );

    res.status(200).json({
      success: true,
      data: normalizedDeposit,
    });
  } catch (error) {
    next(error);
  }
};
// Get active payment methods
exports.getActivePaymentMethods = async (req, res, next) => {
  try {
    // Try to get from cache
    const cached = await cacheService.get(CACHE_KEYS.ACTIVE_PAYMENT_METHODS);
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

    // Group payment methods by type
    const groupedMethods = normalizedPaymentMethods.reduce((acc, method) => {
      if (!acc[method.type]) {
        acc[method.type] = [];
      }
      acc[method.type].push(method);
      return acc;
    }, {});

    // Cache the grouped methods
    await cacheService.set(
      CACHE_KEYS.ACTIVE_PAYMENT_METHODS,
      groupedMethods,
      CACHE_TTL.ACTIVE_PAYMENT_METHODS,
    );

    res.status(200).json({
      success: true,
      data: groupedMethods,
    });
  } catch (error) {
    next(error);
  }
};

async function invalidateDepositPaymentMethodCache() {
  await cacheService.deletePattern(CACHE_KEYS.ACTIVE_PAYMENT_METHODS);
  console.log("🗑️ Active client payment-method cache invalidated");
}
// Get deposit summary statistics for user dashboard
exports.getDepositSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `client:deposit:summary:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [totalDeposits, pendingDeposits, approvedDeposits, rejectedDeposits] =
      await Promise.all([
        Deposit.aggregate([
          {
            $match: {
              user: new mongoose.Types.ObjectId(userId),
              status: "Approved",
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Deposit.countDocuments({ user: userId, status: "Pending" }),
        Deposit.countDocuments({ user: userId, status: "Approved" }),
        Deposit.countDocuments({ user: userId, status: "Rejected" }),
      ]);

    const result = {
      totalAmount: totalDeposits[0]?.total || 0,
      totalCount: totalDeposits[0]?.count || 0,
      pending: pendingDeposits,
      approved: approvedDeposits,
      rejected: rejectedDeposits,
    };

    await cacheService.set(cacheKey, result, 60); // 1 minute cache

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// Cancel a pending deposit request
exports.cancelDeposit = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit ID format",
      });
    }

    const deposit = await Deposit.findOne({
      _id: id,
      user: req.user.id,
      status: "Pending",
    });

    if (!deposit) {
      return res.status(404).json({
        success: false,
        message: "Pending deposit not found or cannot be cancelled",
      });
    }

    // Delete the deposit
    await Deposit.findByIdAndDelete(id);

    // Invalidate caches
    await invalidateDepositCaches(req.user.id, id);

    // Delete proof of payment from Cloudinary if it exists
    if (deposit.proofOfPaymentPublicId) {
      await deleteFromCloudinary(deposit.proofOfPaymentPublicId);
    }

    res.status(200).json({
      success: true,
      message: "Deposit request cancelled successfully",
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate deposit-related caches
async function invalidateDepositCaches(userId, depositId = null) {
  const promises = [
    cacheService.deletePattern(`client:deposits:${userId}:*`),
    cacheService.deletePattern(`client:deposit:summary:${userId}`),
  ];

  if (depositId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_DEPOSIT(depositId)),
    );
  }

  await Promise.all(promises);
  console.log(`🗑️ Deposit caches invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateDepositCaches = invalidateDepositCaches;
exports.invalidateDepositPaymentMethodCache = invalidateDepositPaymentMethodCache;

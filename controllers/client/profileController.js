// Backend/controllers/client/profileController.js - FULLY OPTIMIZED
const Profile = require("../../models/client/Profile");
const User = require("../../models/User");
const path = require("path");
const multer = require("multer");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const {
  uploadBufferToCloudinary,
  deleteFromCloudinary,
} = require("../../utils/cloudinary");

// Cache keys
const CACHE_KEYS = {
  USER_PROFILE: (userId) => `profile:user:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_PROFILE: 300, // 5 minutes
};

// File type configurations (unchanged)
const ALLOWED_FILE_TYPES = {
  "application/pdf": {
    extensions: [".pdf"],
    magicNumbers: [0x25, 0x50, 0x44, 0x46],
  },
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    magicNumbers: [0xff, 0xd8, 0xff],
  },
  "image/png": {
    extensions: [".png"],
    magicNumbers: [0x89, 0x50, 0x4e, 0x47],
  },
  "image/gif": {
    extensions: [".gif"],
    magicNumbers: [0x47, 0x49, 0x46],
  },
  "image/webp": {
    extensions: [".webp"],
    magicNumbers: [0x52, 0x49, 0x46, 0x46],
  },
  "image/bmp": {
    extensions: [".bmp"],
    magicNumbers: [0x42, 0x4d],
  },
};

const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
];

// Extensions that indicate a genuine double-extension spoofing attempt
// (e.g. "invoice.pdf.exe" or "photo.jpg.php") when they show up as an
// inner segment of the filename, ahead of the real extension.
const DANGEROUS_EXTENSIONS = [
  "exe", "php", "phtml", "js", "mjs", "sh", "bat", "cmd", "html", "htm",
  "jsp", "asp", "aspx", "dll", "msi", "vbs", "ps1", "svg", "jar", "com",
];

// Configure multer for file uploads (kept in memory, then pushed to Cloudinary)
const storage = multer.memoryStorage();

// Upload a KYC document buffer to Cloudinary
const uploadKycDocument = (buffer) =>
  uploadBufferToCloudinary(buffer, {
    folder: "kyc-documents",
    resourceType: "auto",
  });

// File filter for document uploads
const fileFilter = (req, file, cb) => {
  if (!file) {
    return cb(new Error("No file uploaded"), false);
  }

  const fileExt = path.extname(file.originalname).toLowerCase();
  const isMimeAllowed = Object.keys(ALLOWED_FILE_TYPES).includes(file.mimetype);
  const isExtAllowed = ALLOWED_EXTENSIONS.includes(fileExt);

  let isMimeExtMatch = false;
  if (isMimeAllowed) {
    const allowedExts = ALLOWED_FILE_TYPES[file.mimetype].extensions;
    isMimeExtMatch = allowedExts.includes(fileExt);
  }

  // Only flag genuine double-extension spoofing (e.g. "invoice.pdf.exe" or
  // "photo.jpg.php") - i.e. a dangerous/allowed extension sitting *before*
  // the real one. Ordinary filenames with extra dots (phone-camera
  // timestamps, version numbers like "Photo 2026.09.07.jpg") are common
  // and legitimate, and were previously rejected outright by just
  // counting dots in the filename.
  const nameSegments = file.originalname.split(".");
  if (nameSegments.length > 2) {
    const innerExtensions = nameSegments.slice(1, -1).map((seg) => seg.toLowerCase());
    const hasSpoofedExtension = innerExtensions.some(
      (ext) =>
        DANGEROUS_EXTENSIONS.includes(ext) ||
        ALLOWED_EXTENSIONS.includes(`.${ext}`),
    );
    if (hasSpoofedExtension) {
      return cb(
        new Error("Invalid file name: Double extensions are not allowed"),
        false,
      );
    }
  }

  const maliciousPatterns = /[<>:"|?*\\/]/g;
  if (maliciousPatterns.test(file.originalname)) {
    return cb(
      new Error("Invalid file name: Contains special characters"),
      false,
    );
  }

  if (isMimeAllowed && isExtAllowed && isMimeExtMatch) {
    cb(null, true);
  } else {
    let errorMessage = "Invalid file type. Only ";
    const allowedTypes = [];
    for (const [mime, config] of Object.entries(ALLOWED_FILE_TYPES)) {
      allowedTypes.push(config.extensions.join(", "));
    }
    errorMessage += `${allowedTypes.join(" and ")} files are allowed.`;
    cb(new Error(errorMessage), false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10,
    fieldSize: 10 * 1024 * 1024,
  },
  fileFilter,
});

// Middleware for handling document uploads
exports.uploadDocuments = upload.fields([
  { name: "idDocument", maxCount: 1 },
  { name: "address1Document", maxCount: 1 },
  { name: "address2Document", maxCount: 1 },
]);
// Get user profile
exports.getProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.USER_PROFILE(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // OPTIMIZED: Run queries in parallel with lean()
    const [profile, user] = await Promise.all([
      Profile.findOne({ user: userId }).lean(),
      User.findById(userId)
        .select("firstName lastName dateofbirth phone email")
        .lean(),
    ]);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    let responseData;

    if (!profile) {
      responseData = {
        personalInfo: {
          firstName: user.firstName,
          lastName: user.lastName,
          dateofbirth: user.dateofbirth,
          phone: user.phone,
          email: user.email,
        },
      };
    } else {
      responseData = {
        ...profile,
        personalInfo: {
          firstName: user.firstName,
          lastName: user.lastName,
          dateofbirth: user.dateofbirth,
          phone: user.phone,
          email: user.email,
        },
      };
    }

    // Cache the response
    await cacheService.set(cacheKey, responseData, CACHE_TTL.USER_PROFILE);

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};
// Update personal information
exports.updatePersonalInfo = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { educationLevel, otherEducation, isEmployed } = req.body;
    const io = req.app.get("io");
    let hasUploadedDocuments = false;

    // Prepare update data
    const updateData = {
      educationLevel,
      otherEducation,
      isEmployed: isEmployed === "yes",
      updatedAt: Date.now(),
    };

    // Add file paths if files were uploaded
    if (req.files) {
      hasUploadedDocuments =
        req.files.idDocument ||
        req.files.address1Document ||
        req.files.address2Document;

      // Delete old Cloudinary assets if they exist and new ones are uploaded
      const existingProfile = await Profile.findOne({ user: userId }).lean();

      if (req.files.idDocument) {
        const uploaded = await uploadKycDocument(req.files.idDocument[0].buffer);
        if (existingProfile?.idDocumentPublicId) {
          await deleteFromCloudinary(existingProfile.idDocumentPublicId);
        }
        updateData.idDocument = uploaded.secure_url;
        updateData.idDocumentPublicId = uploaded.public_id;
      }
      if (req.files.address1Document) {
        const uploaded = await uploadKycDocument(
          req.files.address1Document[0].buffer,
        );
        if (existingProfile?.address1DocumentPublicId) {
          await deleteFromCloudinary(existingProfile.address1DocumentPublicId);
        }
        updateData.address1Document = uploaded.secure_url;
        updateData.address1DocumentPublicId = uploaded.public_id;
      }
      if (req.files.address2Document) {
        const uploaded = await uploadKycDocument(
          req.files.address2Document[0].buffer,
        );
        if (existingProfile?.address2DocumentPublicId) {
          await deleteFromCloudinary(existingProfile.address2DocumentPublicId);
        }
        updateData.address2Document = uploaded.secure_url;
        updateData.address2DocumentPublicId = uploaded.public_id;
      }

      if (hasUploadedDocuments) {
        updateData.kycStatus = "unverified";
        updateData.kycVerified = false;
        updateData.kycRejectReason = null;
      }
    }

    // Find and update profile or create if it doesn't exist
    let profile = await Profile.findOne({ user: userId });

    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: userId },
        { $set: updateData },
        { new: true },
      );
    } else {
      updateData.user = userId;
      profile = await Profile.create(updateData);
    }

    // Populate user data for notifications
    await profile.populate("user", "firstName lastName email");

    // Invalidate cache
    await invalidateProfileCache(userId);

    if (io) {
      io.emitCacheInvalidation(userId, ["profile"]);
      io.broadcastCacheInvalidation(["clients", "profile", "kyc"]);
    }

    // Trigger notifications (non-blocking)
    if (req.notificationTriggers) {
      const notificationPromise = hasUploadedDocuments
        ? req.notificationTriggers.handleKycSubmitted(profile.toObject(), userId)
        : req.notificationTriggers.handleProfileUpdate(profile.toObject(), userId);

      notificationPromise.catch((err) =>
        console.error("Notification error:", err),
      );
    }

    res.status(200).json({
      success: true,
      message: "Personal information updated successfully",
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};

// Reset KYC submission and remove uploaded documents
exports.reverifyKyc = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const io = req.app.get("io");
    const profile = await Profile.findOne({ user: userId });

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found",
      });
    }

    const uploadedFields = ["idDocument", "address1Document", "address2Document"];
    const hasUploadedDocuments = uploadedFields.some((field) => !!profile[field]);

    if (!hasUploadedDocuments) {
      return res.status(400).json({
        success: false,
        message: "No uploaded KYC documents found",
      });
    }

    await Promise.all(
      uploadedFields.map(async (field) => {
        if (profile[field]) {
          await deleteFromCloudinary(profile[`${field}PublicId`]);
          profile[field] = null;
          profile[`${field}PublicId`] = null;
        }
      }),
    );

    profile.kycStatus = "unverified";
    profile.kycVerified = false;
    profile.kycRejectReason = null;
    profile.updatedAt = Date.now();
    await profile.save();
    await profile.populate("user", "firstName lastName email");

    await invalidateProfileCache(userId);

    if (io) {
      io.emitCacheInvalidation(userId, ["profile"]);
      io.broadcastCacheInvalidation(["clients", "profile", "kyc"]);
    }

    if (req.notificationTriggers) {
      req.notificationTriggers
        .handleProfileUpdate(profile.toObject(), userId)
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(200).json({
      success: true,
      message: "KYC documents cleared successfully",
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};
// Update account details
exports.updateAccountDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { bankName, accountHolderName, accountNumber, ifscSwiftCode } =
      req.body;

    // Validate required fields
    if (!bankName || !accountHolderName || !accountNumber) {
      return res.status(400).json({
        success: false,
        message:
          "Bank name, account holder name, and account number are required",
      });
    }

    const bankDetails = {
      bankName,
      accountHolderName,
      accountNumber,
      ifscSwiftCode: ifscSwiftCode || "",
    };

    // Find and update profile
    let profile = await Profile.findOne({ user: userId });

    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: userId },
        {
          $set: {
            bankDetails,
            updatedAt: Date.now(),
          },
        },
        { new: true },
      );
    } else {
      profile = await Profile.create({
        user: userId,
        bankDetails,
      });
    }

    // Populate user data for notifications
    await profile.populate("user", "firstName lastName email");

    // Invalidate cache
    await invalidateProfileCache(userId);

    // Trigger notifications (non-blocking)
    if (req.notificationTriggers) {
      req.notificationTriggers
        .handleProfileUpdate(profile.toObject(), userId)
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(200).json({
      success: true,
      message: "Account details updated successfully",
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};
// Update wallet details
exports.updateWalletDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      tetherWalletAddress,
      ethWalletAddress,
      accountNumber,
      trxWalletAddress,
    } = req.body;

    // At least one wallet address is required
    if (
      !tetherWalletAddress &&
      !ethWalletAddress &&
      !trxWalletAddress &&
      !accountNumber
    ) {
      return res.status(400).json({
        success: false,
        message: "At least one wallet address is required",
      });
    }

    const walletDetails = {
      tetherWalletAddress: tetherWalletAddress || "",
      ethWalletAddress: ethWalletAddress || "",
      accountNumber: accountNumber || "",
      trxWalletAddress: trxWalletAddress || "",
    };

    // Find and update profile
    let profile = await Profile.findOne({ user: userId });

    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: userId },
        {
          $set: {
            walletDetails,
            updatedAt: Date.now(),
          },
        },
        { new: true },
      );
    } else {
      profile = await Profile.create({
        user: userId,
        walletDetails,
      });
    }

    // Populate user data for notifications
    await profile.populate("user", "firstName lastName email");

    // Invalidate cache
    await invalidateProfileCache(userId);

    // Trigger notifications (non-blocking)
    if (req.notificationTriggers) {
      req.notificationTriggers
        .handleProfileUpdate(profile.toObject(), userId)
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(200).json({
      success: true,
      message: "Wallet details updated successfully",
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};
// Get profile summary for dashboard (lightweight)
exports.getProfileSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = `profile:summary:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [user, profile] = await Promise.all([
      User.findById(userId)
        .select("firstName lastName email isEmailVerified status")
        .lean(),
      Profile.findOne({ user: userId })
        .select("kycStatus kycVerified bankDetails walletDetails")
        .lean(),
    ]);

    const summary = {
      name: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
      email: user?.email || "",
      isEmailVerified: user?.isEmailVerified || false,
      accountStatus: user?.status || "activated",
      kycStatus: profile?.kycStatus || "unverified",
      kycVerified: profile?.kycVerified || false,
      hasBankDetails: !!profile?.bankDetails?.bankName,
      hasWalletDetails: !!(
        profile?.walletDetails?.tetherWalletAddress ||
        profile?.walletDetails?.ethWalletAddress
      ),
    };

    await cacheService.set(cacheKey, summary, 60); // 1 minute cache

    res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};
// Delete a specific document from profile
exports.deleteDocument = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { documentType } = req.params; // idDocument, address1Document, address2Document
    const io = req.app.get("io");

    const validTypes = ["idDocument", "address1Document", "address2Document"];
    if (!validTypes.includes(documentType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid document type",
      });
    }

    const profile = await Profile.findOne({ user: userId });

    if (!profile || !profile[documentType]) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    // Delete the Cloudinary asset
    await deleteFromCloudinary(profile[`${documentType}PublicId`]);

    // Update profile
    profile[documentType] = null;
    profile[`${documentType}PublicId`] = null;
    profile.updatedAt = Date.now();
    await profile.save();

    // Invalidate cache
    await invalidateProfileCache(userId);

    if (io) {
      io.emitCacheInvalidation(userId, ["profile"]);
      io.broadcastCacheInvalidation(["clients", "profile", "kyc"]);
    }

    res.status(200).json({
      success: true,
      message: "Document deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate profile cache
async function invalidateProfileCache(userId) {
  await Promise.all([
    cacheService.deletePattern(CACHE_KEYS.USER_PROFILE(userId)),
    cacheService.deletePattern(`profile:summary:${userId}`),
  ]);
  console.log(`🗑️ Profile cache invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateProfileCache = invalidateProfileCache;

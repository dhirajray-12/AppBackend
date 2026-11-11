// Backend/controllers/client/otpController.js - FULLY OPTIMIZED
const crypto = require("crypto");
const User = require("../../models/User");
const Account = require("../../models/client/Account");
const emailService = require("../../services/notificationEmailService");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const { withdrawalOtpTemplate } = require("../../utils/emailTemplates");

// OTP configuration
const OTP_CONFIG = {
  LENGTH: 6,
  EXPIRY_SECONDS: 300, // 5 minutes
  MAX_ATTEMPTS: 3,
};

// OTP keys prefix
const OTP_KEY_PREFIX = "otp:withdrawal:";

// Generate OTP
const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

// Generate unique OTP key
const generateOTPKey = (userId) => {
  return `${OTP_KEY_PREFIX}${userId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
};
// Send withdrawal OTP
exports.sendWithdrawalOTP = async (req, res, next) => {
  try {
    const { accountId, amount, paymentMethod, bankDetails, eWalletDetails } =
      req.body;

    // Validate required fields
    if (!accountId || !amount || !paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Account ID, amount, and payment method are required",
      });
    }

    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    // Get account details with lean for better performance
    const account = await Account.findOne({
      _id: accountId,
      user: req.user.id,
    }).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // Check if account has sufficient balance
    if (amount > (account.balance || 0)) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: $${(account.balance || 0).toFixed(2)}`,
      });
    }

    // Get user details
    const user = await User.findById(req.user.id).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpKey = generateOTPKey(req.user.id);

    // Prepare withdrawal data (exclude sensitive bank details from OTP storage)
    const withdrawalData = {
      accountId,
      amount: parseFloat(amount),
      paymentMethod,
      accountNumber: account.mt5Account,
      timestamp: Date.now(),
    };

    // Add bank/wallet details if provided (minimal validation)
    if (paymentMethod === "bank" && bankDetails) {
      withdrawalData.bankDetails = {
        bankName: bankDetails.bankName,
        accountNumber: bankDetails.accountNumber,
        accountHolderName: bankDetails.accountHolderName,
      };
    } else if (eWalletDetails) {
      withdrawalData.walletDetails = {
        type: eWalletDetails.type,
        walletId: eWalletDetails.walletId,
      };
    }

    // Store OTP in the in-process OTP store with expiry
    const otpData = {
      otp,
      userId: req.user.id,
      withdrawalData,
      expiresAt: Date.now() + OTP_CONFIG.EXPIRY_SECONDS * 1000,
      attempts: 0,
      createdAt: Date.now(),
    };

    const otpStored = await cacheService.set(
      otpKey,
      otpData,
      OTP_CONFIG.EXPIRY_SECONDS,
    );

    if (!otpStored) {
      return res.status(503).json({
        success: false,
        message:
          "OTP service is temporarily unavailable. Please try again in a moment.",
      });
    }

    // Send OTP email (non-blocking - don't await)
    const emailTemplate = withdrawalOtpTemplate({
      userName: user.firstName || user.firstname || "User",
      otp,
      account: account.mt5Account,
      amount,
      paymentMethod,
      isResend: false,
    });

    emailService
      .sendEmail({
        to: user.email,
        subject: "Withdrawal OTP Verification",
        html: emailTemplate,
      })
      .catch((err) => console.error("Error sending OTP email:", err));

    res.status(200).json({
      success: true,
      message: "OTP sent to your email address",
      otpKey,
      expiresIn: OTP_CONFIG.EXPIRY_SECONDS,
    });
  } catch (error) {
    console.error("Error sending withdrawal OTP:", error);
    next(error);
  }
};
// Verify withdrawal OTP
exports.verifyWithdrawalOTP = async (req, res, next) => {
  try {
    const { otpKey, otp } = req.body;

    if (!otpKey || !otp) {
      return res.status(400).json({
        success: false,
        message: "OTP key and OTP code are required",
      });
    }

    // Get OTP data from the in-process OTP store
    const otpData = await cacheService.get(otpKey);

    if (!otpData) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP session",
      });
    }

    // Check if OTP belongs to the requesting user
    if (String(otpData.userId) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized access to this OTP session",
      });
    }

    // Check expiry
    if (Date.now() > otpData.expiresAt) {
      await cacheService.deletePattern(otpKey);
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new OTP.",
      });
    }

    // Check attempts
    if (otpData.attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
      await cacheService.deletePattern(otpKey);
      return res.status(400).json({
        success: false,
        message: "Too many failed attempts. Please request a new OTP.",
      });
    }

    // Verify OTP
    if (otpData.otp !== otp) {
      // Increment attempts
      otpData.attempts++;
      await cacheService.set(
        otpKey,
        otpData,
        Math.max(0, (otpData.expiresAt - Date.now()) / 1000),
      );

      const remainingAttempts = OTP_CONFIG.MAX_ATTEMPTS - otpData.attempts;
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${remainingAttempts} attempt${remainingAttempts !== 1 ? "s" : ""} remaining.`,
        remainingAttempts,
      });
    }

    // OTP verified successfully - delete the OTP
    await cacheService.deletePattern(otpKey);

    // Return withdrawal data for the next step
    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      withdrawalData: otpData.withdrawalData,
    });
  } catch (error) {
    console.error("Error verifying withdrawal OTP:", error);
    next(error);
  }
};
// Resend withdrawal OTP
exports.resendWithdrawalOTP = async (req, res, next) => {
  try {
    const { otpKey } = req.body;

    if (!otpKey) {
      return res.status(400).json({
        success: false,
        message: "OTP key is required",
      });
    }

    // Get existing OTP data
    const otpData = await cacheService.get(otpKey);

    if (!otpData) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP session",
      });
    }

    // Check if OTP belongs to the requesting user
    if (String(otpData.userId) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized access to this OTP session",
      });
    }

    // Rate limiting for resend (prevent spam)
    const timeSinceCreation = Date.now() - (otpData.createdAt || 0);
    if (timeSinceCreation < 30000) {
      // 30 seconds cooldown
      return res.status(429).json({
        success: false,
        message: "Please wait 30 seconds before requesting a new OTP",
        retryAfter: Math.ceil((30000 - timeSinceCreation) / 1000),
      });
    }

    // Generate new OTP
    const newOtp = generateOTP();

    // Update OTP data
    otpData.otp = newOtp;
    otpData.expiresAt = Date.now() + OTP_CONFIG.EXPIRY_SECONDS * 1000;
    otpData.attempts = 0;
    otpData.createdAt = Date.now();

    // Save updated OTP
    const otpStored = await cacheService.set(
      otpKey,
      otpData,
      OTP_CONFIG.EXPIRY_SECONDS,
    );

    if (!otpStored) {
      return res.status(503).json({
        success: false,
        message:
          "OTP service is temporarily unavailable. Please try again in a moment.",
      });
    }

    // Get user and account details
    const [user, account] = await Promise.all([
      User.findById(req.user.id).lean(),
      Account.findById(otpData.withdrawalData.accountId).lean(),
    ]);

    if (!user || !account) {
      return res.status(404).json({
        success: false,
        message: "User or account not found",
      });
    }

    // Send new OTP email
    const emailTemplate = withdrawalOtpTemplate({
      userName: user.firstName || user.firstname || "User",
      otp: newOtp,
      account: account.mt5Account,
      amount: otpData.withdrawalData.amount,
      paymentMethod: otpData.withdrawalData.paymentMethod,
      isResend: true,
    });

    emailService
      .sendEmail({
        to: user.email,
        subject: "Withdrawal OTP Verification (Resent)",
        html: emailTemplate,
      })
      .catch((err) => console.error("Error resending OTP email:", err));

    res.status(200).json({
      success: true,
      message: "New OTP sent to your email address",
      expiresIn: OTP_CONFIG.EXPIRY_SECONDS,
    });
  } catch (error) {
    console.error("Error resending withdrawal OTP:", error);
    next(error);
  }
};
// Check if OTP is valid without consuming it
exports.checkOTPStatus = async (req, res, next) => {
  try {
    const { otpKey } = req.params;

    if (!otpKey) {
      return res.status(400).json({
        success: false,
        message: "OTP key is required",
      });
    }

    const otpData = await cacheService.get(otpKey);

    if (!otpData) {
      return res.status(200).json({
        success: true,
        isValid: false,
        message: "OTP session not found or expired",
      });
    }

    // Check if OTP belongs to the requesting user
    if (String(otpData.userId) !== String(req.user.id)) {
      return res.status(200).json({
        success: true,
        isValid: false,
        message: "Unauthorized access to this OTP session",
      });
    }

    const isExpired = Date.now() > otpData.expiresAt;
    const remainingSeconds = isExpired
      ? 0
      : Math.ceil((otpData.expiresAt - Date.now()) / 1000);
    const remainingAttempts = OTP_CONFIG.MAX_ATTEMPTS - (otpData.attempts || 0);

    res.status(200).json({
      success: true,
      isValid: !isExpired && remainingAttempts > 0,
      isExpired,
      remainingSeconds,
      remainingAttempts,
      maxAttempts: OTP_CONFIG.MAX_ATTEMPTS,
    });
  } catch (error) {
    console.error("Error checking OTP status:", error);
    next(error);
  }
};
// Invalidate OTP (call after successful withdrawal)
exports.invalidateOTP = async (req, res, next) => {
  try {
    const { otpKey } = req.body;

    if (!otpKey) {
      return res.status(400).json({
        success: false,
        message: "OTP key is required",
      });
    }

    const otpData = await cacheService.get(otpKey);

    if (otpData && String(otpData.userId) === String(req.user.id)) {
      await cacheService.deletePattern(otpKey);
    }

    res.status(200).json({
      success: true,
      message: "OTP invalidated successfully",
    });
  } catch (error) {
    console.error("Error invalidating OTP:", error);
    next(error);
  }
};

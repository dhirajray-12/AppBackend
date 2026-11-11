// backend/middlewares/validationMiddleware.js
const { ValidationError } = require("./errorHandler");
const Joi = require("joi");

const walletTypeSchema = Joi.string()
  .trim()
  .custom((value, helpers) => {
    const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
    const supportedWalletTypes = [
      "tether",
      "usdt",
      "eth",
      "ethereum",
      "trx",
      "tron",
    ];

    if (!supportedWalletTypes.includes(normalized)) {
      return helpers.error("any.invalid");
    }

    return value;
  }, "wallet type normalization")
  .messages({
    "any.invalid": "walletType must be one of USDT, ETH, TRX, Tether, Ethereum, or Tron",
  });

// Generic validation middleware
const validate = (schema, property = "body") => {
  return (req, res, next) => {
    const data = req[property];
    const { error, value } = schema.validate(data, { abortEarly: false });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
      }));

      throw new ValidationError("Validation failed", errors);
    }

    req[property] = value; // Replace with validated data
    next();
  };
};

// Common validation schemas
const schemas = {
  // Auth schemas
  signup: Joi.object({
    firstName: Joi.string().min(2).max(50).required(),
    lastName: Joi.string().min(2).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    phone: Joi.string()
      .pattern(/^\d+$/)
      .min(5)
      .max(18)
      .required()
      .messages({
        "string.pattern.base":
          "Phone number must contain digits only (no '+' sign)",
      }),
    dateofbirth: Joi.date().iso().required(),
    country: Joi.string().required(),
    zipCode: Joi.string().required(),
    state: Joi.string().required(),
    referralCode: Joi.string().optional(),
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
    loginType: Joi.string()
      .valid("client", "admin", "superadmin", "agent")
      .required(),
    locationContext: Joi.object({
      permission: Joi.string()
        .valid("granted", "denied", "prompt", "unavailable", "timeout", "error")
        .required(),
      source: Joi.string().valid("gps", "ip").required(),
      latitude: Joi.number().min(-90).max(90).optional(),
      longitude: Joi.number().min(-180).max(180).optional(),
      accuracy: Joi.number().min(0).optional(),
      capturedAt: Joi.date().iso().optional(),
    }).optional(),
  }),

  agentSignup: Joi.object({
    firstname: Joi.string().min(2).max(50).required(),
    lastname: Joi.string().min(2).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    phone: Joi.string().min(10).max(15).required(),
    dateofbirth: Joi.date().iso().required(),
    country: Joi.string().required(),
  }),

  // Deposit schemas
  createDeposit: Joi.object({
    accountId: Joi.string().required(),
    amount: Joi.number().positive().min(10).required(),
    paymentMethodId: Joi.string().required(),
    paymentType: Joi.string().valid("bank", "crypto").required(),
    transactionId: Joi.string().required(),
  }),

  approveDeposit: Joi.object({
    bonus: Joi.number().min(0).default(0),
    remarks: Joi.string().max(500).optional(),
  }),

  rejectDeposit: Joi.object({
    remarks: Joi.string().max(500).required(),
  }),

  // Withdrawal schemas
  createWithdrawal: Joi.object({
    accountId: Joi.string().required(),
    accountNumber: Joi.string().required(),
    accountType: Joi.string().required(),
    amount: Joi.number().positive().min(1).required(),
    paymentMethod: Joi.string()
      .valid("bank", "usdt", "ethereum", "tron", "skrill", "neteller")
      .required(),
    bankDetails: Joi.when("paymentMethod", {
      is: "bank",
      then: Joi.object({
        bankName: Joi.string().required(),
        accountHolderName: Joi.string().required(),
        accountNumber: Joi.string().required(),
        ifscCode: Joi.string().required(),
      }).required(),
      otherwise: Joi.optional(),
    }),
    eWalletDetails: Joi.when("paymentMethod", {
      is: Joi.string().valid("usdt", "ethereum", "tron", "skrill", "neteller"),
      then: Joi.object({
        type: Joi.string().required(),
        walletId: Joi.string().required(),
      }).required(),
      otherwise: Joi.optional(),
    }),
    otpVerified: Joi.boolean().default(false),
  }),

  // Transfer schemas
  createTransfer: Joi.object({
    fromAccountId: Joi.string().required(),
    toAccountId: Joi.string().required(),
    amount: Joi.number().positive().min(10).required(),
  }),

  // IB Configuration schemas
  createIBConfig: Joi.object({
    referralCode: Joi.string().optional(),
  }),

  verifyReferral: Joi.object({
    referralCode: Joi.string().required(),
  }),

  // IB Withdrawal schemas
  requestIBWithdrawal: Joi.object({
    amount: Joi.number().positive().required(),
    withdrawalMethod: Joi.string().valid("bank", "wallet").required(),
    bankDetails: Joi.when("withdrawalMethod", {
      is: "bank",
      then: Joi.object({
        bankName: Joi.string().required(),
        accountHolderName: Joi.string().required(),
        accountNumber: Joi.string().required(),
        ifscCode: Joi.string().required(),
      }).required(),
      otherwise: Joi.optional(),
    }),
    walletDetails: Joi.when("withdrawalMethod", {
      is: "wallet",
      then: Joi.object({
        walletType: walletTypeSchema.required(),
        walletAddress: Joi.string().required(),
      }).required(),
      otherwise: Joi.optional(),
    }),
  }),

  // Admin schemas
  updateClient: Joi.object({
    firstname: Joi.string().min(2).max(50).optional(),
    lastname: Joi.string().min(2).max(50).optional(),
    email: Joi.string().email().optional(),
    isEmailVerified: Joi.boolean().optional(),
    phone: Joi.string().min(10).max(15).optional(),
    dateofbirth: Joi.date().iso().optional(),
    kycStatus: Joi.string()
      .valid("verified", "unverified", "rejected")
      .optional(),
    kycVerified: Joi.boolean().optional(),
    kycRejectReason: Joi.string().max(500).optional(),
    ibPartner: Joi.string().valid("active", "inactive", "None").optional(),
    educationLevel: Joi.string().optional(),
    otherEducation: Joi.string().optional(),
    bankDetails: Joi.object({
      bankName: Joi.string(),
      accountHolderName: Joi.string(),
      accountNumber: Joi.string(),
      ifscSwiftCode: Joi.string(),
    }).optional(),
    walletDetails: Joi.object({
      tetherWalletAddress: Joi.string(),
      ethWalletAddress: Joi.string(),
      trxWalletAddress: Joi.string(),
      accountNumber: Joi.string(),
    }).optional(),
  }),

  updateClientPassword: Joi.object({
    password: Joi.string().min(6).required(),
  }),

  getUserByPhone: Joi.object({
    phone: Joi.string().min(10).max(15).required(),
    details: Joi.object().optional(),
  }),
};

module.exports = {
  validate,
  schemas,
};

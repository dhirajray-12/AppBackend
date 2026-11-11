// Backend/controllers/client/accountController.js - FULLY OPTIMIZED
const Account = require("../../models/client/Account");
const { metaApi } = require("../../API/metaApi");
const User = require("../../models/User");
const Group = require("../../models/Group");
const AppSetting = require("../../models/AppSetting");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
const axios = require("axios");
const { AppError } = require("../../middlewares/errorHandler");
require("dotenv").config();
const COPY_API_URL = process.env.COPY_API_URL || "https://copyapi.infoapi.biz";
const COPY_API_TIMEOUT = 15000;
const DEFAULT_SERVER_NAME = "Aon ltd.";

// Cache keys
const CACHE_KEYS = {
  USER_ACCOUNTS: (userId) => `user:accounts:${userId}`,
  SINGLE_ACCOUNT: (accountId) => `account:${accountId}`,
  COPY_ACCOUNTS: (userId) => `user:copy:accounts:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_ACCOUNTS: 30, // 30 seconds - balances change frequently
  SINGLE_ACCOUNT: 60, // 1 minute
  COPY_ACCOUNTS: 300, // 5 minutes - copy accounts don't change often
};

// Helper function to generate a random MT5 account with format YYMMDD + 3 random digits
const generateRandomMT5Account = () => {
  const today = new Date();
  const formattedDate =
    today.getFullYear().toString().slice(-2) +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0");

  const randomDigits = String(Math.floor(Math.random() * 900) + 100);
  return formattedDate + randomDigits;
};

// Helper function to check if account number is unique (cached)
const isUniqueAccountNumber = async (mt5Account) => {
  const existingAccount = await Account.findOne({ mt5Account })
    .select("_id")
    .lean();
  return !existingAccount;
};
// @desc    Create a new trading account
// @route   POST /api/accounts/create
// @access  Private
exports.createAccount = async (req, res, next) => {
  try {
    const {
      leverage,
      accountType,
      platform,
      customMT5Account,
      masterPassword,
      investorPassword,
    } = req.body;

    // Get user details with lean for better performance
    const user = await User.findById(req.user.id).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Create account name
    const name = `${user.firstName} ${user.lastName}`;

    // Get Group details
    const group = await Group.findOne({ value: accountType }).lean();
    if (!group) {
      console.error(`Group not found for value: ${accountType}`);
      return res.status(404).json({
        success: false,
        message: `Account Type not found for: ${accountType}`,
      });
    }

    const accountName = group.name;
    const mt5GroupPath = group.value;

    // Generate or use custom MT5 account number
    let mt5Account = customMT5Account || generateRandomMT5Account();
    let isUnique = await isUniqueAccountNumber(mt5Account);

    // If not unique and not custom, try up to 3 times
    if (!customMT5Account) {
      let attempts = 0;
      while (!isUnique && attempts < 3) {
        mt5Account = generateRandomMT5Account();
        isUnique = await isUniqueAccountNumber(mt5Account);
        attempts++;
      }
    }

    if (!isUnique) {
      return res.status(409).json({
        success: false,
        message: "Account number already exists. Please try again.",
      });
    }

    // Prepare external API payload
    let countryName = user.country;
    if (typeof user.country === "object" && user.country !== null) {
      countryName = user.country.name || user.country.state || "Unknown";
    }

    const externalAPIPayload = {
      Manager_Index: Number(process.env.Manager_Index || 1),
      MT5Account: String(mt5Account),
      Name: name,
      Group_Name: mt5GroupPath,
      Leverage: String(leverage),
    };

    console.log(
      "📤 Sending Payload to MT5:",
      JSON.stringify(externalAPIPayload, null, 2),
    );

    // Call external API to create account
    let externalAPIResponse;
    try {
      externalAPIResponse = await metaApi.post(`/Adduser`, externalAPIPayload, {
        timeout: 30000, // 30 second timeout
      });

      const isSuccess =
        externalAPIResponse.data.success === true ||
        externalAPIResponse.data.status === "success" ||
        externalAPIResponse.data.status === "Success";

      if (!isSuccess) {
        console.error(
          "MT5 API returned non-success status:",
          externalAPIResponse.data,
        );
        return res.status(400).json({
          success: false,
          message:
            externalAPIResponse.data.Message ||
            externalAPIResponse.data.message ||
            "Failed to create account in external system",
          details: externalAPIResponse.data,
        });
      }
    } catch (apiError) {
      const errorMessage =
        apiError.response?.data?.ERR_Message ||
        apiError.response?.data?.message ||
        "";

      if (errorMessage.includes("User with the same login already exists")) {
        return next(
          new AppError(
            "Account number already exists in external system. Please try again.",
            409,
          ),
        );
      }

      if (
        errorMessage.includes("Not enough permissions") ||
        errorMessage.includes("ERR_PERMISSIONS")
      ) {
        return next(
          new AppError(
            `MT5 API Permission Error: Please check Manager_Index credentials: ${errorMessage}`,
            500,
          ),
        );
      }

      return next(
        new AppError(`Error contacting external API: ${apiError.message}`, 500),
      );
    }

    const externalAPIResult = {
      master_pwd: masterPassword || externalAPIResponse.data.Master_Pwd,
      investor_pwd: investorPassword || externalAPIResponse.data.Investor_Pwd,
    };

    // Create account in database
    const account = await Account.create({
      user: req.user.id,
      mt5Account,
      name,
      leverage,
      groupName: accountType,
      accountType: accountName,
      investor_pwd: externalAPIResult.investor_pwd,
      master_pwd: externalAPIResult.master_pwd,
      platform: platform || "MetaTrader 5",
      balance: 0,
      equity: 0,
      status: true,
      managerIndex: process.env.Manager_Index || "1",
    });

    // Invalidate user account caches
    await invalidateAccountCaches(req.user.id);

    // Populate user data for notifications
    await account.populate("user", "firstName lastName email");

    const appSettings = await AppSetting.findOne().lean();
    const serverName = appSettings?.serverName || DEFAULT_SERVER_NAME;

    // Trigger notifications
    if (req.notificationTriggers) {
      await req.notificationTriggers.handleAccountCreated({
        ...account.toObject(),
        user: req.user.id,
        investorPassword: externalAPIResult.investor_pwd,
        masterPassword: externalAPIResult.master_pwd,
        serverName,
      });
    }

    const io = req.app.get("io");
    if (io) {
      if (io.emitAccountUpdate) {
        io.emitAccountUpdate(req.user.id, account.toObject(), "created");
      }
      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(req.user.id, [
          "accounts",
          "availableBalances",
          "userAccounts",
          "withdrawalAccounts",
          "dashboardData",
        ]);
      }
      if (io.broadcastCacheInvalidation) {
        io.broadcastCacheInvalidation(["clients", "admin_dashboard"]);
      }
    }

    res.status(201).json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get all user accounts
// @route   GET /api/accounts
// @access  Private
exports.getAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.USER_ACCOUNTS(userId);

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

    const accounts = await Account.find({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    const response = {
      success: true,
      count: accounts.length,
      data: accounts,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.USER_ACCOUNTS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Get single account
// @route   GET /api/accounts/:id
// @access  Private
exports.getAccount = async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.SINGLE_ACCOUNT(accountId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached && cached.user === userId) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const account = await Account.findOne({
      _id: accountId,
      user: userId,
    }).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // Cache the account
    await cacheService.set(cacheKey, account, CACHE_TTL.SINGLE_ACCOUNT);

    res.status(200).json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Update account passwords
// @route   PUT /api/accounts/:accountId/passwords
// @access  Private
exports.updateAccountPasswords = async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const { investor_pwd, master_pwd } = req.body;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID",
      });
    }

    if (!investor_pwd && !master_pwd) {
      return res.status(400).json({
        success: false,
        message: "At least one password is required",
      });
    }

    const account = await Account.findOne({
      _id: accountId,
      user: req.user.id,
    });

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const updateData = {};
    const changedPasswords = [];
    const errors = [];

    // Update investor password if provided
    if (investor_pwd) {
      try {
        const investorResponse = await metaApi.get(`/ChangeInvesterPassword`, {
          params: {
            Manager_Index: process.env.Manager_Index || "1",
            Account: account.mt5Account,
            password: investor_pwd,
          },
          timeout: 15000,
        });

        const isInvestorSuccess =
          investorResponse.data.success === true ||
          investorResponse.data.status === "success" ||
          investorResponse.data.status === "Success";

        if (isInvestorSuccess) {
          updateData.investor_pwd = investor_pwd;
          changedPasswords.push("investor_pwd");
        } else {
          errors.push({
            type: "investor",
            message:
              investorResponse.data.Message ||
              investorResponse.data.message ||
              "Unknown error",
          });
        }
      } catch (apiError) {
        errors.push({
          type: "investor",
          message: apiError.response?.data?.message || apiError.message,
        });
      }
    }

    // Update master password if provided
    if (master_pwd) {
      try {
        const masterResponse = await metaApi.get(`/ChangeMasterPassword`, {
          params: {
            Manager_Index: process.env.Manager_Index || "1",
            Account: account.mt5Account,
            password: master_pwd,
          },
          timeout: 15000,
        });

        const isMasterSuccess =
          masterResponse.data.success === true ||
          masterResponse.data.status === "success" ||
          masterResponse.data.status === "Success";

        if (isMasterSuccess) {
          updateData.master_pwd = master_pwd;
          changedPasswords.push("master_pwd");
        } else {
          errors.push({
            type: "master",
            message:
              masterResponse.data.Message ||
              masterResponse.data.message ||
              "Unknown error",
          });
        }
      } catch (apiError) {
        errors.push({
          type: "master",
          message: apiError.response?.data?.message || apiError.message,
        });
      }
    }

    // If there are errors and no successful updates
    if (errors.length > 0 && changedPasswords.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Failed to update passwords",
        errors,
      });
    }

    // Update database if any passwords were successfully changed
    let updatedAccount = null;
    if (changedPasswords.length > 0) {
      updatedAccount = await Account.findByIdAndUpdate(accountId, updateData, {
        new: true,
      });

      if (!updatedAccount) {
        return res.status(404).json({
          success: false,
          message: "Account not found after password update",
        });
      }

      // Invalidate caches
      await invalidateAccountCaches(req.user.id, accountId);

      // Populate user data for notifications
      await updatedAccount.populate("user", "firstName lastName email");

      // Trigger notifications
      if (req.notificationTriggers) {
        await req.notificationTriggers.handlePasswordChanged({
          ...updatedAccount.toObject(),
          user: req.user.id,
          changedPasswords,
        });
      }

      const io = req.app.get("io");
      if (io) {
        if (io.emitAccountUpdate) {
          io.emitAccountUpdate(req.user.id, updatedAccount.toObject());
        }
        if (io.emitCacheInvalidation) {
          io.emitCacheInvalidation(req.user.id, ["accounts", "userAccounts"]);
        }
      }
    }

    res.status(200).json({
      success: true,
      message:
        changedPasswords.length > 0
          ? "Password(s) updated successfully"
          : "No passwords were updated",
      data: updatedAccount,
      changedPasswords,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    if (error instanceof mongoose.Error.CastError) {
      return next(new AppError("Invalid account ID", 400));
    }

    next(error);
  }
};
// @desc    Get user accounts for copy request
// @route   GET /api/accounts/copy-accounts
// @access  Private (Client)
exports.getUserAccountsForCopy = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const cacheKey = CACHE_KEYS.COPY_ACCOUNTS(userId);

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

    const accounts = await Account.find({ user: userId })
      .select("mt5Account accountType balance updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    const availableAccounts = await filterAvailableCopyAccounts(accounts);

    const response = {
      success: true,
      count: availableAccounts.length,
      data: availableAccounts,
    };

    // Cache for longer period since copy accounts don't change often
    await cacheService.set(cacheKey, response, CACHE_TTL.COPY_ACCOUNTS);

    res.status(200).json(response);
  } catch (error) {
    next(new AppError("Internal server error", 500));
  }
};
// @desc    Get account balance from MT5 (real-time)
// @route   GET /api/accounts/:accountId/balance
// @access  Private
exports.getAccountBalance = async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.user.id;

    const account = await Account.findOne({
      _id: accountId,
      user: userId,
    }).lean();
    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // Fetch real-time balance from MT5
    const response = await metaApi.get(`/GetUserInfo`, {
      params: {
        Manager_Index: account.managerIndex || process.env.Manager_Index || "1",
        MT5Account: account.mt5Account,
      },
      timeout: 10000,
    });

    const balance =
      response.data?.Balance || response.data?.balance || account.balance;
    const equity =
      response.data?.Equity || response.data?.equity || account.equity;

    res.status(200).json({
      success: true,
      data: {
        mt5Account: account.mt5Account,
        balance,
        equity,
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    next(new AppError("Failed to fetch account balance", 500));
  }
};

// @desc    Refresh all account balances (batch)
// @route   POST /api/accounts/refresh-balances
// @access  Private
exports.refreshAllBalances = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const accounts = await Account.find({ user: userId })
      .select("mt5Account managerIndex _id")
      .lean();

    if (accounts.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No accounts found",
        updatedCount: 0,
      });
    }

    // Group by manager index for batch API calls
    const accountsByManager = new Map();
    for (const account of accounts) {
      const managerIndex =
        account.managerIndex || process.env.Manager_Index || "1";
      if (!accountsByManager.has(managerIndex)) {
        accountsByManager.set(managerIndex, []);
      }
      accountsByManager.get(managerIndex).push({
        mt5Account: parseInt(account.mt5Account),
        accountId: account._id,
      });
    }

    // Fetch each manager group's balances in parallel instead of one at a time
    const managerResults = await Promise.all(
      Array.from(accountsByManager.entries()).map(
        async ([managerIndex, managerAccounts]) => {
          const mt5AccountNumbers = managerAccounts.map(
            (acc) => acc.mt5Account,
          );
          const accountLookup = new Map(
            managerAccounts.map((acc) => [acc.mt5Account, acc.accountId]),
          );
          const managerBulkOperations = [];

          try {
            const response = await metaApi.post(
              `/GetUserInfoByAccounts`,
              {
                Manager_Index: parseInt(managerIndex),
                MT5Accounts: mt5AccountNumbers,
              },
              { timeout: 30000 },
            );

            if (response.data && Array.isArray(response.data)) {
              for (const userInfo of response.data) {
                const mt5Account =
                  userInfo.MT5Account || userInfo.Login || userInfo.login;
                const balance = userInfo.Balance || userInfo.balance || 0;
                const equity = userInfo.Equity || userInfo.equity || 0;

                if (mt5Account) {
                  const accountId = accountLookup.get(mt5Account);
                  if (accountId) {
                    managerBulkOperations.push({
                      updateOne: {
                        filter: { _id: accountId },
                        update: {
                          $set: {
                            balance,
                            equity,
                            updatedAt: new Date(),
                          },
                        },
                      },
                    });
                  }
                }
              }
            }
          } catch (apiError) {
            console.error(
              `Error fetching balances for manager ${managerIndex}:`,
              apiError.message,
            );
          }

          return managerBulkOperations;
        },
      ),
    );

    const bulkOperations = managerResults.flat();
    const updatedCount = bulkOperations.length;

    if (bulkOperations.length > 0) {
      await Account.bulkWrite(bulkOperations, { ordered: false });
    }

    // Invalidate caches
    await invalidateAccountCaches(userId);

    res.status(200).json({
      success: true,
      message: `Updated ${updatedCount} accounts`,
      updatedCount,
    });
  } catch (error) {
    next(new AppError("Failed to refresh balances", 500));
  }
};
// Invalidate account-related caches
async function invalidateAccountCaches(userId, accountId = null) {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.USER_ACCOUNTS(userId)),
    cacheService.deletePattern(CACHE_KEYS.COPY_ACCOUNTS(userId)),
  ];

  if (accountId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_ACCOUNT(accountId)),
    );
  }

  await Promise.all(promises);
  console.log(`🗑️ Account caches invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateAccountCaches = invalidateAccountCaches;

async function filterAvailableCopyAccounts(accounts) {
  if (!accounts.length) {
    return accounts;
  }

  const accountNumbers = accounts
    .map((account) => parseInt(account.mt5Account, 10))
    .filter((accountNumber) => !Number.isNaN(accountNumber));

  if (!accountNumbers.length) {
    return accounts;
  }

  try {
    const response = await axios.post(
      `${COPY_API_URL}/api/getAllCopierDetailsByAccouts`,
      { copiers: accountNumbers },
      { timeout: COPY_API_TIMEOUT },
    );

    const linkedCopierAccounts = new Set(
      (response.data?.masterAccounts || []).flatMap((master) =>
        (master.copiers || []).map((copier) => String(copier.login)),
      ),
    );

    return accounts.filter(
      (account) => !linkedCopierAccounts.has(String(account.mt5Account)),
    );
  } catch (error) {
    console.error("Copy account availability check failed:", {
      message: error.message,
      code: error.code,
      status: error.response?.status,
    });

    // Fail open so account loading still works if the copy API is unavailable.
    return accounts;
  }
}

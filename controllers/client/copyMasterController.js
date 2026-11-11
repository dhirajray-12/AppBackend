// Backend/controllers/client/copyMasterController.js - FULLY OPTIMIZED
const Copy = require("../../models/Copy");
const Account = require("../../models/client/Account");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");
require("dotenv").config();
const axios = require("axios");
const FormData = require("form-data");
const { AppError } = require("../../middlewares/errorHandler");

const COPY_API_URL = process.env.COPY_API_URL;
const API_TIMEOUT = 30000; // 30 seconds

// Cache keys
const CACHE_KEYS = {
  MASTERS: (userId, role) => `copy:master:list:${role}:${userId}`,
  SINGLE_MASTER: (masterId) => `copy:master:single:${masterId}`,
  ALL_ACCOUNTS: (userId, role) => `copy:master:accounts:${role}:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  MASTERS: 30, // 30 seconds
  SINGLE_MASTER: 60, // 1 minute
  ALL_ACCOUNTS: 60, // 1 minute
};

const getCopyAccessibleAccounts = async (userId, userRole, selectFields) => {
  const query = userRole === "admin" ? {} : { user: userId };
  return Account.find(query)
    .select(selectFields)
    .sort({ createdAt: -1 })
    .lean();
};

const extractMt5AccountNumbers = (accounts) =>
  accounts
    .map((account) => parseInt(account.mt5Account, 10))
    .filter((num) => !isNaN(num));

// The external copy-trading API (a Django/MySQL service) has two
// separate problems once `masterAccounts` gets large, both confirmed by
// hand against the real service:
//  1. It silently returns an empty result (no error) once the array
//     grows past roughly 1300 entries - admin's listing hits this
//     immediately since it queries every account in the system
//     (thousands, once the client base grows).
//  2. Under back-to-back requests it can outright fail with a
//     DatabaseError (its MySQL connection pool appears to exhaust local
//     ports rather than reuse connections).
// Mitigate both: keep each batch comfortably under the size cliff, send
// batches one at a time (no concurrent load on their DB), and retry a
// batch a couple of times before giving up on it.
const GET_MASTER_DETAILS_BATCH_SIZE = 1000;
const GET_MASTER_DETAILS_MAX_RETRIES = 2;
const GET_MASTER_DETAILS_RETRY_DELAY_MS = 1000;

const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchMasterDetailsBatch = async (batch) => {
  const response = await axios.post(
    `${COPY_API_URL}/api/getMasterDetailsByAccounts`,
    {
      userId: parseInt(process.env.User_Id),
      masterAccounts: batch,
    },
    { timeout: API_TIMEOUT },
  );

  if (response.data.error) {
    throw new AppError(
      response.data.message || "Error fetching data from external API",
      400,
    );
  }

  return response.data.masterAccountsData || [];
};

const fetchMasterDetailsBatchWithRetry = async (batch) => {
  let lastError;

  for (let attempt = 0; attempt <= GET_MASTER_DETAILS_MAX_RETRIES; attempt++) {
    try {
      return await fetchMasterDetailsBatch(batch);
    } catch (error) {
      lastError = error;
      if (attempt < GET_MASTER_DETAILS_MAX_RETRIES) {
        await sleep(GET_MASTER_DETAILS_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError;
};

// Fetch master details for a (possibly large) list of MT5 account
// numbers, batching requests to stay under the external API's size limit
// and sending them one at a time so we don't add to the load that seems
// to trip up its DB connection handling.
const fetchMasterDetailsByAccounts = async (accountNumbers) => {
  const batches = chunkArray(accountNumbers, GET_MASTER_DETAILS_BATCH_SIZE);
  const allMasterAccountsData = [];

  for (const batch of batches) {
    const batchResults = await fetchMasterDetailsBatchWithRetry(batch);
    allMasterAccountsData.push(...batchResults);
  }

  return allMasterAccountsData;
};

// @desc    Get all masters for a user
// @route   GET /api/copy-trade/masters
// @access  Private
exports.getMasters = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const cacheKey = CACHE_KEYS.MASTERS(userId, userRole);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        data: cached.data,
        isAdmin: cached.isAdmin,
        fromCache: true,
      });
    }

    // Get user accounts based on role
    const userAccounts = await getCopyAccessibleAccounts(
      userId,
      userRole,
      "mt5Account",
    );
    const accountNumbers = extractMt5AccountNumbers(userAccounts);

    if (accountNumbers.length === 0) {
      const emptyResponse = {
        success: true,
        count: 0,
        data: [],
        isAdmin: userRole === "admin",
        message:
          userRole === "admin"
            ? "No accounts found in the system"
            : "No accounts found for this user",
      };
      return res.status(200).json(emptyResponse);
    }

    // Call external API - batched, since it silently drops everything
    // once too many account numbers are sent in a single request (see
    // fetchMasterDetailsByAccounts above).
    const masterAccountsData = await fetchMasterDetailsByAccounts(accountNumbers);

    // Transform data efficiently
    const transformedData = masterAccountsData.map(
      (item) => ({
        _id: item.master.MT5Account.toString(),
        nickname: item.master.name,
        commission: item.master.commission,
        totalCopiers: item.master.totalCopiers,
        totalProfit: item.master.totalProfit,
        totalCommissionEarned: item.master.totalMasterCommission,
        accountDetails: {
          mt5Account: item.master.MT5Account.toString(),
          balance: item.master.balance,
        },
        copiers: item.copiers.map((copier) => ({
          copierUserId: {
            firstname: copier.name?.split(" ")[0] || copier.name || "",
            lastname: copier.name?.split(" ").slice(1).join(" ") || "",
          },
          copierAccountId: {
            accountNumber: copier.MT5Account?.toString(),
            balance: copier.balance,
          },
          currentProfit: copier.totalProfit || 0,
          totalCommissionPaid: copier.totalMasterCommission || 0,
          status: "active",
        })),
        isActive: true,
        createdAt: item.master.created_at,
      }),
    );

    const result = {
      success: true,
      count: transformedData.length,
      data: transformedData,
      isAdmin: userRole === "admin",
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.MASTERS);

    res.status(200).json(result);
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      return next(
        new AppError("External API timeout. Please try again.", 504),
      );
    }

    if (error instanceof AppError) {
      return next(error);
    }

    next(new AppError("Server error while fetching masters", 500));
  }
};

// @desc    Get single master
// @route   GET /api/copy/masters/:id
// @access  Private
exports.getMaster = async (req, res, next) => {
  try {
    const { id } = req.params;
    const cacheKey = CACHE_KEYS.SINGLE_MASTER(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const response = await axios.get(
      `${COPY_API_URL}/api/getMasterDetailsByAccount?MT5Account=${id}`,
      { timeout: API_TIMEOUT },
    );

    if (!response.data.success) {
      return res.status(404).json({
        success: false,
        message: response.data.message || "Master not found",
      });
    }

    // Cache the response
    await cacheService.set(
      cacheKey,
      response.data.data,
      CACHE_TTL.SINGLE_MASTER,
    );

    res.status(200).json({
      success: true,
      data: response.data.data,
    });
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      return next(
        new AppError("External API timeout. Please try again.", 504),
      );
    }

    next(new AppError("Server error while fetching master", 500));
  }
};

// @desc    Create master
// @route   POST /api/copy/masters
// @access  Private
exports.createMaster = async (req, res, next) => {
  try {
    const {
      nickname,
      accountId,
      commission,
      minimumInvestment,
      publicChatLink,
      strategyDescription,
    } = req.body;

    // Validate required fields
    if (
      !nickname ||
      !accountId ||
      commission === undefined ||
      minimumInvestment === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please provide nickname, account, commission, and minimum investment",
      });
    }

    // Validate commission range
    if (commission < 0 || commission > 50) {
      return res.status(400).json({
        success: false,
        message: "Commission must be between 0% and 50%",
      });
    }

    // Check if account exists - admins may create a master out of any
    // client's account, not just their own (mirrors updateMaster below).
    const accountQuery = { mt5Account: accountId };
    if (req.user.role !== "admin") {
      accountQuery.user = req.user.id;
    }

    const account = await Account.findOne(accountQuery).lean();

    if (!account) {
      const errorMessage =
        req.user.role === "admin"
          ? "Account not found"
          : "Account not found or does not belong to you";
      return res.status(404).json({
        success: false,
        message: errorMessage,
      });
    }

    // Check if master already exists
    const checkExistingResponse = await checkIfMasterExists(account.mt5Account);
    if (checkExistingResponse.exists) {
      return res.status(400).json({
        success: false,
        message: "Master account already exists",
      });
    }

    // Create new master
    return await createNewMaster(req, res, next, account, {
      nickname,
      commission,
      minimumInvestment,
      publicChatLink,
      strategyDescription,
    });
  } catch (error) {
    next(new AppError("Server error while creating master", 500));
  }
};
// @desc    Update master
// @route   PUT /api/copy/masters/:id
// @access  Private
exports.updateMaster = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      nickname,
      commission,
      minimumInvestment,
      publicChatLink,
      strategyDescription,
    } = req.body;

    // Validate required fields
    if (
      !nickname ||
      commission === undefined ||
      minimumInvestment === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide nickname, commission, and minimum investment",
      });
    }

    // Validate commission range
    if (commission < 0 || commission > 50) {
      return res.status(400).json({
        success: false,
        message: "Commission must be between 0% and 50%",
      });
    }

    // Find account by MT5 account number
    let accountQuery = { mt5Account: id };
    if (req.user.role !== "admin") {
      accountQuery.user = req.user.id;
    }

    const account = await Account.findOne(accountQuery).lean();

    if (!account) {
      const errorMessage =
        req.user.role === "admin"
          ? "Account not found"
          : "Account not found or does not belong to you";
      return res.status(404).json({
        success: false,
        message: errorMessage,
      });
    }

    // Check if master exists
    const checkExistingResponse = await checkIfMasterExists(account.mt5Account);
    if (!checkExistingResponse.exists) {
      return res.status(404).json({
        success: false,
        message: "Master account not found",
      });
    }

    // Update existing master
    return await updateExistingMaster(req, res, next, account, {
      nickname,
      commission,
      minimumInvestment,
      publicChatLink,
      strategyDescription,
    });
  } catch (error) {
    next(new AppError("Server error while updating master", 500));
  }
};
// @desc    Delete master
// @route   DELETE /api/copy-trade/masters/:id
// @access  Private
exports.deleteMaster = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Find account by MT5 account number
    const account = await Account.findOne({ mt5Account: id }).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found.",
      });
    }

    // Check if master exists in external API
    const checkExistingResponse = await checkIfMasterExists(account.mt5Account);
    if (!checkExistingResponse.exists) {
      return res.status(404).json({
        success: false,
        message: "Master account not found",
      });
    }

    // Delete from external API
    try {
      const formData = new FormData();
      formData.append("masterccount", account.mt5Account.toString());

      const deleteResponse = await axios.post(
        `${COPY_API_URL}/api/deleteMasterAccount`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: API_TIMEOUT,
        },
      );

      if (deleteResponse.data.error) {
        return res.status(400).json({
          success: false,
          message:
            deleteResponse.data.message ||
            "Failed to delete master account from external API",
        });
      }
    } catch (apiError) {
      return next(
        new AppError(
          "Error deleting master account from external API: " +
            (apiError.response?.data?.message || apiError.message),
          500,
        ),
      );
    }

    // Update local database
    try {
      const copyRecord = await Copy.findOne({
        accounts: account._id,
        copyType: "Master",
        status: "accepted",
      });

      if (copyRecord) {
        if (copyRecord.accounts.length === 1) {
          copyRecord.status = "inactive";
        } else {
          copyRecord.accounts = copyRecord.accounts.filter(
            (acc) => !acc.equals(account._id),
          );
        }
        await copyRecord.save();
      }
    } catch (dbError) {
      console.error("Database update error after API deletion:", dbError);
    }

    // Invalidate caches
    await invalidateMasterCaches(req.user.id, req.user.role, id);
    emitMasterUpdate(req, req.user.id);

    res.status(200).json({
      success: true,
      message: "Master account deleted successfully",
    });
  } catch (error) {
    next(new AppError("Server error while deleting master", 500));
  }
};
// @desc    Get all accounts
// @route   GET /api/copy-trade/masters/accounts
// @access  Private
exports.getAllAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const cacheKey = CACHE_KEYS.ALL_ACCOUNTS(userId, userRole);

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

    const accounts = await getCopyAccessibleAccounts(
      userId,
      userRole,
      userRole === "admin" ? "mt5Account name createdAt user" : "mt5Account name createdAt",
    );

    const result = {
      success: true,
      count: accounts.length,
      data: accounts,
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.ALL_ACCOUNTS);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
// Helper function to check if master exists
async function checkIfMasterExists(mt5Account) {
  try {
    const response = await axios.post(
      `${COPY_API_URL}/api/getAllMasterAndLinkedAccountsByManagerIndex`,
      {
        Manager_Index: parseInt(process.env.Copy_Manager_Index) || 1,
        accounts: [parseInt(mt5Account)],
      },
      { timeout: API_TIMEOUT },
    );

    const copyManagerId = response.data?.copyManagerId;
    const mastersData = response.data?.data?.mastersAndLinkedAccounts || [];

    const existingMaster = mastersData.find(
      (master) => master.masterAccount?.login === parseInt(mt5Account),
    );

    return {
      exists: !!existingMaster,
      copyManagerId,
      masterData: existingMaster,
    };
  } catch (error) {
    const copyManagerId = error.response?.data?.copyManagerId;
    return {
      exists: false,
      copyManagerId,
      masterData: null,
    };
  }
}

// Helper function to update existing master
async function updateExistingMaster(req, res, next, account, masterData) {
  try {
    const {
      nickname,
      commission,
      minimumInvestment,
      publicChatLink,
      strategyDescription,
    } = masterData;

    const api3Response = await axios.post(
      `${COPY_API_URL}/api/updateMasterCommission`,
      {
        masterAccount: parseInt(account.mt5Account),
        commission: commission,
        nickname: nickname,
        min_invest: minimumInvestment,
        description: strategyDescription || "",
        chat_link: publicChatLink || "",
      },
      { timeout: API_TIMEOUT },
    );

    if (api3Response.data.success) {
      // Invalidate caches after update
      await invalidateMasterCaches(
        req.user.id,
        req.user.role,
        account.mt5Account,
      );
      emitMasterUpdate(req, req.user.id);

      return res.status(200).json({
        success: true,
        message: "Master updated successfully",
        data: {
          mt5Account: account.mt5Account,
          nickname,
          commission,
          minimumInvestment,
          publicChatLink: publicChatLink || "",
          strategyDescription: strategyDescription || "",
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message:
          api3Response.data.message ||
          "Failed to update master commission on external API",
      });
    }
  } catch (apiError) {
    return next(
      new AppError(
        apiError.response?.data?.message ||
          "Error updating master commission on external API",
        500,
      ),
    );
  }
}

// Helper function to create new master
async function createNewMaster(req, res, next, account, masterData) {
  const {
    nickname,
    commission,
    minimumInvestment,
    publicChatLink,
    strategyDescription,
  } = masterData;

  try {
    // Step 1: Get copy manager ID
    const checkResult = await checkIfMasterExists(account.mt5Account);
    const copyManagerId = checkResult.copyManagerId;

    if (!copyManagerId) {
      return res.status(400).json({
        success: false,
        message: "Failed to get copy manager ID from external API",
      });
    }

    // Step 2: Add master account
    const formData = new FormData();
    formData.append("userId", copyManagerId.toString());
    formData.append("mt5Account", account.mt5Account.toString());

    const api2Response = await axios.post(
      `${COPY_API_URL}/api/addMasterAccount`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: API_TIMEOUT,
      },
    );

    if (api2Response.data.error) {
      return res.status(400).json({
        success: false,
        message:
          api2Response.data.message ||
          "Failed to add master account on external API",
      });
    }

    // Step 3: Update master commission
    const api3Response = await axios.post(
      `${COPY_API_URL}/api/updateMasterCommission`,
      {
        masterAccount: parseInt(account.mt5Account),
        commission: commission,
        nickname: nickname,
        min_invest: minimumInvestment,
        description: strategyDescription || "",
        chat_link: publicChatLink || "",
      },
      { timeout: API_TIMEOUT },
    );

    if (!api3Response.data.success) {
      return res.status(400).json({
        success: false,
        message:
          api3Response.data.message ||
          "Failed to update master commission on external API",
      });
    }

    // Create or update Copy record in database - owned by the account's
    // actual client, not the requester (an admin creating a master on a
    // client's behalf must not end up owning that client's Copy record).
    let copyRecord = await Copy.findOne({
      user: account.user,
      accounts: account._id,
      copyType: "Master",
    });

    if (!copyRecord) {
      copyRecord = await Copy.create({
        user: account.user,
        accounts: [account._id],
        copyType: "Master",
        status: "accepted",
      });
    }

    // Invalidate caches - both the requester's (so an admin's own view
    // refreshes) and the account owner's, if different.
    await invalidateMasterCaches(
      req.user.id,
      req.user.role,
      account.mt5Account,
    );
    emitMasterUpdate(req, req.user.id);

    if (String(account.user) !== String(req.user.id)) {
      await invalidateMasterCaches(account.user, "client", account.mt5Account);
      emitMasterUpdate(req, account.user);
    }

    res.status(201).json({
      success: true,
      message: "Master created successfully",
      data: {
        mt5Account: account.mt5Account,
        nickname,
        commission,
        minimumInvestment,
        publicChatLink: publicChatLink || "",
        strategyDescription: strategyDescription || "",
        copyManagerId: copyManagerId,
      },
    });
  } catch (apiError) {
    const copyManagerId = apiError.response?.data?.copyManagerId;

    if (copyManagerId) {
      return await retryCreateMaster(
        req,
        res,
        next,
        account,
        masterData,
        copyManagerId,
      );
    } else {
      return next(
        new AppError(
          "Error communicating with external APIs: " +
            (apiError.response?.data?.message || apiError.message),
          500,
        ),
      );
    }
  }
}

// Retry create master with existing copyManagerId
async function retryCreateMaster(req, res, next, account, masterData, copyManagerId) {
  const {
    nickname,
    commission,
    minimumInvestment,
    publicChatLink,
    strategyDescription,
  } = masterData;

  try {
    const formData = new FormData();
    formData.append("userId", copyManagerId.toString());
    formData.append("mt5Account", account.mt5Account.toString());

    const api2Response = await axios.post(
      `${COPY_API_URL}/api/addMasterAccount`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: API_TIMEOUT,
      },
    );

    if (api2Response.data.error) {
      return res.status(400).json({
        success: false,
        message:
          api2Response.data.message ||
          "Failed to add master account on external API",
      });
    }

    const api3Response = await axios.post(
      `${COPY_API_URL}/api/updateMasterCommission`,
      {
        masterAccount: parseInt(account.mt5Account),
        commission: commission,
        nickname: nickname,
        min_invest: minimumInvestment,
        description: strategyDescription || "",
        chat_link: publicChatLink || "",
      },
      { timeout: API_TIMEOUT },
    );

    if (!api3Response.data.success) {
      return res.status(400).json({
        success: false,
        message:
          api3Response.data.message ||
          "Failed to update master commission on external API",
      });
    }

    // Invalidate caches
    await invalidateMasterCaches(
      req.user.id,
      req.user.role,
      account.mt5Account,
    );
    emitMasterUpdate(req, req.user.id);

    res.status(201).json({
      success: true,
      message: "Master created successfully",
      data: {
        mt5Account: account.mt5Account,
        nickname,
        commission,
        minimumInvestment,
        publicChatLink: publicChatLink || "",
        strategyDescription: strategyDescription || "",
        copyManagerId: copyManagerId,
      },
    });
  } catch (secondError) {
    return next(
      new AppError(
        "Error in secondary processing: " + secondError.message,
        500,
      ),
    );
  }
}

// Notify the master's owner + admins that a master account changed
function emitMasterUpdate(req, userId) {
  const io = req.app.get("io");
  if (!io) return;

  if (userId && io.emitCacheInvalidation) {
    io.emitCacheInvalidation(userId, ["mastersAndCopiers", "copyTradingStats"]);
  }

  if (io.broadcastCacheInvalidation) {
    io.broadcastCacheInvalidation(["mastersAndCopiers", "copyTradingStats"]);
  }
}

// Invalidate master-related caches
async function invalidateMasterCaches(userId, userRole, masterId = null) {
  const promises = [
    cacheService.deletePattern(CACHE_KEYS.MASTERS(userId, userRole)),
    cacheService.deletePattern(CACHE_KEYS.ALL_ACCOUNTS(userId, userRole)),
  ];

  if (masterId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_MASTER(masterId)),
    );
  }

  await Promise.all(promises);
  console.log(`🗑️ Master caches invalidated for user: ${userId}`);
}

// Export cache invalidation function
exports.invalidateMasterCaches = invalidateMasterCaches;

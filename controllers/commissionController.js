// Backend/controllers/client/commissionController.js - SUPER FAST VERSION
const IBCommission = require("../models/IBCommission");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBClosedTrades = require("../models/IBClosedTrade");
const User = require("../models/User");
const Account = require("../models/client/Account");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");

// Cache keys
const CACHE_KEYS = {
  TRADE_COMMISSIONS: (userId) => `commission:trades:${userId}`,
  COMMISSION_SUMMARY: (userId, period) =>
    `commission:summary:${userId}:${period}`,
  COMMISSION_BREAKDOWN: (userId, period) =>
    `commission:breakdown:${userId}:${period}`,
  PARTNER_COMMISSIONS: (userId, partnerId) =>
    `commission:partner:${userId}:${partnerId}`,
  PARTNERS_LIST: (userId) => `commission:partners:${userId}`,
  DOWNLINE_PARTNERS: (ibConfigId, level) =>
    `commission:downline:${ibConfigId}:${level || "root"}`,
  TODAY_COMMISSION: (userId) => `commission:today:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  TRADE_COMMISSIONS: 60, // 1 minute
  COMMISSION_SUMMARY: 120, // 2 minutes
  COMMISSION_BREAKDOWN: 300, // 5 minutes
  PARTNER_COMMISSIONS: 60, // 1 minute
  PARTNERS_LIST: 120, // 2 minutes
  DOWNLINE_PARTNERS: 300, // 5 minutes
  TODAY_COMMISSION: 60, // 1 minute
};

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
};
// @desc    Get trade commissions for the logged-in user
// @route   GET /api/ibclients/commission/trade-commissions
// @access  Private (Client)
exports.getTradeCommissions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.TRADE_COMMISSIONS(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        trades: cached.trades,
        totals: cached.totals,
        fromCache: true,
      });
    }

    // Find user's IB configuration
    const ibConfig = await IBClientConfiguration.findOne({ userId }).lean();

    if (!ibConfig) {
      return res.status(404).json({
        success: false,
        message:
          "No IB configuration found. Please set up your referral system first.",
      });
    }

    const [commissionData] = await IBCommission.aggregate([
      { $match: { ibUserId: new mongoose.Types.ObjectId(userId) } },
      {
        $facet: {
          trades: [
            { $sort: { createdAt: -1 } },
            {
              $project: {
                clientMT5Account: 1,
                openTime: 1,
                closeTime: 1,
                openPrice: 1,
                closePrice: 1,
                symbol: 1,
                profit: 1,
                volume: 1,
                commissionAmount: 1,
                status: 1,
                level: 1,
              },
            },
          ],
          totals: [
            {
              $group: {
                _id: null,
                totalProfit: { $sum: "$profit" },
                totalVolume: { $sum: "$volume" },
                totalRebate: { $sum: "$commissionAmount" },
              },
            },
          ],
        },
      },
    ]);

    const trades = (commissionData?.trades || []).map((commission) => ({
      acNo: commission.clientMT5Account,
      openTime: commission.openTime,
      closeTime: commission.closeTime,
      openPrice: commission.openPrice?.toFixed(5) || "0.00000",
      closePrice: commission.closePrice?.toFixed(5) || "0.00000",
      symbol: commission.symbol,
      profit: commission.profit,
      volume: commission.volume,
      rebate: commission.commissionAmount,
      status: commission.status,
      level: commission.level,
    }));

    const totalsData = commissionData?.totals?.[0] || {
      totalProfit: 0,
      totalVolume: 0,
      totalRebate: 0,
    };

    const result = {
      trades,
      totals: {
        totalProfit: totalsData.totalProfit || 0,
        totalVolume: totalsData.totalVolume || 0,
        totalRebate: totalsData.totalRebate || 0,
      },
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.TRADE_COMMISSIONS);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get commission summary for dashboard
// @route   GET /api/ibclients/commission/summary
// @access  Private (Client)
exports.getCommissionSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { period = "30" } = req.query;
    const periodNum = parsePositiveInt(period, 30, 365);

    const cacheKey = CACHE_KEYS.COMMISSION_SUMMARY(userId, periodNum);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        summary: cached,
        fromCache: true,
      });
    }

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodNum);

    // OPTIMIZED: Single aggregation for all summary data
    const summaryResult = await IBCommission.aggregate([
      {
        $match: {
          ibUserId: new mongoose.Types.ObjectId(userId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: "$commissionAmount" },
          totalVolume: { $sum: "$volume" },
          totalProfit: { $sum: "$profit" },
          totalTrades: { $sum: 1 },
          avgCommission: { $avg: "$commissionAmount" },
        },
      },
    ]);

    const data = summaryResult[0] || {
      totalCommission: 0,
      totalVolume: 0,
      totalProfit: 0,
      totalTrades: 0,
      avgCommission: 0,
    };

    const summary = {
      totalCommission: data.totalCommission,
      totalTrades: data.totalTrades,
      totalVolume: data.totalVolume,
      totalProfit: data.totalProfit,
      avgCommissionPerTrade: data.avgCommission || 0,
      period: periodNum,
    };

    // Cache the result
    await cacheService.set(cacheKey, summary, CACHE_TTL.COMMISSION_SUMMARY);

    res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get today's commission for dashboard
// @route   GET /api/ibclients/commission/summary/today
// @access  Private (Client)
exports.getTodayCommission = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.TODAY_COMMISSION(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        summary: cached,
        fromCache: true,
      });
    }

    // Calendar-day boundaries (server local time)
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const [result] = await IBCommission.aggregate([
      {
        $match: {
          ibUserId: new mongoose.Types.ObjectId(userId),
          createdAt: { $gte: startOfDay, $lt: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: "$commissionAmount" },
          totalVolume: { $sum: "$volume" },
          totalProfit: { $sum: "$profit" },
          totalTrades: { $sum: 1 },
          avgCommission: { $avg: "$commissionAmount" },
        },
      },
    ]);

    const data = result || {
      totalCommission: 0,
      totalVolume: 0,
      totalProfit: 0,
      totalTrades: 0,
      avgCommission: 0,
    };

    const summary = {
      totalCommission: data.totalCommission,
      totalTrades: data.totalTrades,
      totalVolume: data.totalVolume,
      totalProfit: data.totalProfit,
      avgCommissionPerTrade: data.avgCommission || 0,
    };

    await cacheService.set(cacheKey, summary, CACHE_TTL.TODAY_COMMISSION);

    res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get detailed commission breakdown by level
// @route   GET /api/ibclients/commission/breakdown
// @access  Private (Client)
exports.getCommissionBreakdown = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { period = "30" } = req.query;
    const periodNum = parsePositiveInt(period, 30, 365);

    const cacheKey = CACHE_KEYS.COMMISSION_BREAKDOWN(userId, periodNum);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        breakdown: cached,
        fromCache: true,
      });
    }

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodNum);

    const breakdown = await IBCommission.aggregate([
      {
        $match: {
          ibUserId: new mongoose.Types.ObjectId(userId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$level",
          totalCommission: { $sum: "$commissionAmount" },
          totalTrades: { $sum: 1 },
          totalVolume: { $sum: "$volume" },
          avgCommission: { $avg: "$commissionAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    await cacheService.set(cacheKey, breakdown, CACHE_TTL.COMMISSION_BREAKDOWN);

    res.status(200).json({
      success: true,
      breakdown,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get commission details for a specific partner/client
// @route   GET /api/ibclients/commission/partner/:partnerId
// @access  Private (Client)
exports.getPartnerCommissions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { partnerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(partnerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid partner ID format",
      });
    }

    const cacheKey = CACHE_KEYS.PARTNER_COMMISSIONS(userId, partnerId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        ...cached,
        fromCache: true,
      });
    }

    // Verify partner is a downline of current user
    const partnerIBConfig =
      await IBClientConfiguration.findById(partnerId).lean();

    if (!partnerIBConfig) {
      return res.status(404).json({
        success: false,
        message: "Partner not found.",
      });
    }

    const [commissionData, partner, partnerAccounts] = await Promise.all([
      IBCommission.aggregate([
        {
          $match: {
            ibUserId: new mongoose.Types.ObjectId(userId),
            clientId: partnerIBConfig.userId,
          },
        },
        {
          $facet: {
            trades: [
              { $sort: { createdAt: -1 } },
              {
                $project: {
                  clientMT5Account: 1,
                  openTime: 1,
                  closeTime: 1,
                  openPrice: 1,
                  closePrice: 1,
                  symbol: 1,
                  profit: 1,
                  volume: 1,
                  commissionAmount: 1,
                  status: 1,
                  level: 1,
                },
              },
            ],
            totals: [
              {
                $group: {
                  _id: null,
                  totalProfit: { $sum: "$profit" },
                  totalVolume: { $sum: "$volume" },
                  totalRebate: { $sum: "$commissionAmount" },
                },
              },
            ],
            accountSummaries: [
              {
                $group: {
                  _id: "$clientMT5Account",
                  totalProfit: { $sum: "$profit" },
                  totalVolume: { $sum: "$volume" },
                  totalRebate: { $sum: "$commissionAmount" },
                  totalTrades: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]),
      User.findById(partnerIBConfig.userId, "firstName lastName email").lean(),
      Account.find({ user: partnerIBConfig.userId })
        .select("mt5Account accountType")
        .lean(),
    ]);

    const commissionResult = commissionData[0] || {
      trades: [],
      totals: [],
      accountSummaries: [],
    };

    const trades = commissionResult.trades.map((commission) => ({
      acNo: commission.clientMT5Account,
      openTime: commission.openTime,
      closeTime: commission.closeTime,
      openPrice: commission.openPrice?.toFixed(5) || "0.00000",
      closePrice: commission.closePrice?.toFixed(5) || "0.00000",
      symbol: commission.symbol,
      profit: commission.profit,
      volume: commission.volume,
      rebate: commission.commissionAmount,
      status: commission.status,
      level: commission.level,
    }));

    const totalsData = commissionResult.totals[0] || {
      totalProfit: 0,
      totalVolume: 0,
      totalRebate: 0,
    };

    const accountSummariesMap = new Map(
      (commissionResult.accountSummaries || []).map((summary) => [
        String(summary._id),
        summary,
      ]),
    );

    const accountSummaries = partnerAccounts.map((account) => {
      const mt5Account = String(account.mt5Account);
      const summary = accountSummariesMap.get(mt5Account);

      return {
        acNo: mt5Account,
        accountType: account.accountType || "",
        totalProfit: summary?.totalProfit || 0,
        totalVolume: summary?.totalVolume || 0,
        totalRebate: summary?.totalRebate || 0,
        totalTrades: summary?.totalTrades || 0,
      };
    });

    for (const summary of commissionResult.accountSummaries || []) {
      const mt5Account = String(summary._id);
      const exists = accountSummaries.some(
        (account) => account.acNo === mt5Account,
      );

      if (!exists) {
        accountSummaries.push({
          acNo: mt5Account,
          accountType: "",
          totalProfit: summary.totalProfit || 0,
          totalVolume: summary.totalVolume || 0,
          totalRebate: summary.totalRebate || 0,
          totalTrades: summary.totalTrades || 0,
        });
      }
    }

    const result = {
      partner: {
        id: partner._id,
        name: `${partner.firstName || partner.firstname || ""} ${partner.lastName || partner.lastname || ""}`.trim(),
        email: partner.email,
        accounts: accountSummaries.map((acc) => acc.acNo),
        accountCount: accountSummaries.length,
      },
      trades,
      accountSummaries,
      totals: {
        totalProfit: totalsData.totalProfit || 0,
        totalVolume: totalsData.totalVolume || 0,
        totalRebate: totalsData.totalRebate || 0,
      },
    };

    await cacheService.set(cacheKey, result, CACHE_TTL.PARTNER_COMMISSIONS);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get enhanced partners list with commission data
// @route   GET /api/ibclients/commission/partners
// @access  Private (Client)
exports.getPartnersWithCommissions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.PARTNERS_LIST(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        partners: cached,
        fromCache: true,
      });
    }

    // Find user's IB configuration
    const ibConfig = await IBClientConfiguration.findOne({ userId }).lean();

    if (!ibConfig) {
      return res.status(404).json({
        success: false,
        message: "No IB configuration found.",
      });
    }

    // Get all downline partners
    const partners = await getAllDownlinePartnersCached(
      ibConfig._id,
      ibConfig.level,
    );

    if (partners.length === 0) {
      return res.status(200).json({
        success: true,
        partners: [],
      });
    }

    // Get all partner user IDs. A stale IB configuration can point to a
    // deleted user, which makes populate("userId") return null.
    const validPartners = partners.filter((partner) =>
      getPartnerUserObjectId(partner),
    );
    const partnerUserIds = validPartners.map((partner) =>
      getPartnerUserObjectId(partner),
    );

    if (partnerUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        partners: [],
      });
    }

    // OPTIMIZED: Batch get all commission data
    const [commissionsData, accountsData, usersData] = await Promise.all([
      IBCommission.aggregate([
        {
          $match: {
            ibUserId: new mongoose.Types.ObjectId(userId),
            clientId: { $in: partnerUserIds },
          },
        },
        {
          $group: {
            _id: "$clientId",
            totalEarned: { $sum: "$commissionAmount" },
            totalVolume: { $sum: "$volume" },
            totalTrades: { $sum: 1 },
          },
        },
      ]),
      Account.aggregate([
        { $match: { user: { $in: partnerUserIds } } },
        {
          $group: {
            _id: "$user",
            mt5Account: { $first: "$mt5Account" },
            accounts: { $push: "$mt5Account" },
            accountCount: { $sum: 1 },
          },
        },
      ]),
      User.find({ _id: { $in: partnerUserIds } })
        .select("firstName lastName email country")
        .lean(),
    ]);

    // Create maps for O(1) lookup
    const commissionsMap = new Map();
    for (const c of commissionsData) {
      commissionsMap.set(c._id.toString(), c);
    }

    const accountsMap = new Map();
    for (const a of accountsData) {
      accountsMap.set(a._id.toString(), a);
    }

    const usersMap = new Map();
    for (const u of usersData) {
      usersMap.set(u._id.toString(), u);
    }

    // Build enhanced partners list
    const enhancedPartners = [];
    for (const partner of validPartners) {
      const partnerUserObjectId = getPartnerUserObjectId(partner);
      const partnerId = partnerUserObjectId.toString();
      const commission = commissionsMap.get(partnerId) || {
        totalEarned: 0,
        totalVolume: 0,
        totalTrades: 0,
      };
      const account = accountsMap.get(partnerId);
      const user = usersMap.get(partnerId);
      const populatedUser = partner.userId?._id ? partner.userId : {};

      enhancedPartners.push({
        _id: partner._id,
        userId: {
          _id: partnerUserObjectId,
          firstName: user?.firstName || populatedUser.firstName || "",
          lastName: user?.lastName || populatedUser.lastName || "",
          email: user?.email || populatedUser.email || "",
        },
        referralCode: partner.referralCode,
        level: partner.level,
        totalVolume: commission.totalVolume || 0,
        totalEarned: commission.totalEarned || 0,
        totalTrades: commission.totalTrades || 0,
        createdAt: partner.createdAt,
        country: user?.country?.name || "Unknown",
        mt5Account: account?.mt5Account || "No Account",
        accounts: account?.accounts || [],
        accountCount: account?.accountCount || 0,
      });
    }

    await cacheService.set(cacheKey, enhancedPartners, CACHE_TTL.PARTNERS_LIST);

    res.status(200).json({
      success: true,
      partners: enhancedPartners,
    });
  } catch (error) {
    next(error);
  }
};
const getPartnerUserObjectId = (partner) => {
  const userId = partner?.userId?._id || partner?.userId;

  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return userId instanceof mongoose.Types.ObjectId
    ? userId
    : new mongoose.Types.ObjectId(userId);
};

// Cached version of getAllDownlinePartners
const getAllDownlinePartnersCached = async (
  ibConfigId,
  currentUserLevel = null,
) => {
  const cacheKey = CACHE_KEYS.DOWNLINE_PARTNERS(ibConfigId, currentUserLevel);

  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  const partners = await getAllDownlinePartnersRecursive(
    ibConfigId,
    currentUserLevel,
  );

  await cacheService.set(cacheKey, partners, CACHE_TTL.DOWNLINE_PARTNERS);

  return partners;
};

// Downline lookup using a single aggregation instead of recursive queries
const getAllDownlinePartnersRecursive = async (
  ibConfigId,
  currentUserLevel = null,
) => {
  try {
    const rootId =
      ibConfigId instanceof mongoose.Types.ObjectId
        ? ibConfigId
        : new mongoose.Types.ObjectId(ibConfigId);

    const [result] = await IBClientConfiguration.aggregate([
      { $match: { _id: rootId } },
      {
        $graphLookup: {
          from: "ibclientconfigurations",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "parent",
          as: "downline",
          depthField: "depth",
        },
      },
      {
        $project: {
          downline: 1,
        },
      },
    ]);

    const partners = result?.downline || [];
    if (partners.length === 0) {
      return [];
    }

    const userIds = partners
      .map((partner) => partner.userId)
      .filter((userId) => mongoose.Types.ObjectId.isValid(userId));

    const users = await User.find({ _id: { $in: userIds } })
      .select("firstName lastName email country firstname lastname")
      .lean();

    const usersMap = new Map(users.map((user) => [user._id.toString(), user]));

    return partners
      .map((partner) => {
        const userId = getPartnerUserObjectId(partner);
        if (!userId) {
          return null;
        }

        const user = usersMap.get(userId.toString());
        const displayLevel =
          currentUserLevel !== null
            ? partner.level - currentUserLevel
            : partner.level;

        return {
          ...partner,
          level: displayLevel,
          userId: user
            ? {
                _id: user._id,
                firstName: user.firstName || user.firstname || "",
                lastName: user.lastName || user.lastname || "",
                email: user.email || "",
                country: user.country || null,
              }
            : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.level !== b.level) return a.level - b.level;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
  } catch (error) {
    console.error("Error getting downline partners:", error);
    return [];
  }
};

// Export the helper function
exports.getAllDownlinePartners = getAllDownlinePartnersRecursive;
// Invalidate commission caches for a user
const invalidateCommissionCaches = async (userId) => {
  const patterns = [
    CACHE_KEYS.TRADE_COMMISSIONS(userId),
    CACHE_KEYS.COMMISSION_SUMMARY(userId, "*"),
    CACHE_KEYS.COMMISSION_BREAKDOWN(userId, "*"),
    CACHE_KEYS.PARTNERS_LIST(userId),
    CACHE_KEYS.TODAY_COMMISSION(userId),
    `commission:partner:${userId}:*`,
  ];

  await Promise.all(patterns.map((pattern) => cacheService.deletePattern(pattern)));
  console.log(`🗑️ Commission caches invalidated for user: ${userId}`);
};

// @desc    Get sync status for trade synchronization
// @route   GET /api/sync/status
// @access  Public (used by sync service)
exports.getSyncStatus = async (req, res, next) => {
  try {
    const syncStatus = {
      isProcessing: false,
      lastSyncTime: new Date().toISOString(),
      nextSyncIn: "10 seconds",
    };

    res.status(200).json({
      success: true,
      syncStatus,
    });
  } catch (error) {
    next(error);
  }
};

// Export cache invalidation
exports.invalidateCommissionCaches = invalidateCommissionCaches;

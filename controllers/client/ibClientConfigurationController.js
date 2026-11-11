const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const IBCommission = require("../../models/IBCommission");
const IBWithdrawal = require("../../models/IBWithdrawal");
const IBConfiguration = require("../../models/admin/IBAdminConfiguration");
const User = require("../../models/User");
const Group = require("../../models/Group");
const crypto = require("crypto");
const Account = require("../../models/client/Account");
const { metaApi } = require("../../API/metaApi");
const cacheService = require("../../services/cacheService");
const mongoose = require("mongoose");

// groupId is only stored on the root IB (the node the admin assigned a
// group ceiling to) — non-root nodes inherit their group via ancestry, so
// walk up the parent chain to find it before looking up commissionMode.
// Deliberately not cached: it must reflect the admin's toggle immediately.
const resolveGroupCommissionMode = async (ibConfiguration) => {
  let current = ibConfiguration;
  let guard = 0;

  while (current && !current.groupId && current.parent && guard < 25) {
    current = await IBClientConfiguration.findById(current.parent)
      .select("parent groupId")
      .lean();
    guard += 1;
  }

  if (!current?.groupId) return "waterfall";

  const group = await Group.findById(current.groupId)
    .select("commissionMode")
    .lean();

  return group?.commissionMode || "waterfall";
};

// Cache keys
const CACHE_KEYS = {
  MY_IB_CONFIG: (userId) => `ib:config:user:${userId}`,
  IB_DASHBOARD: (userId) => `ib:dashboard:${userId}`,
  PARTNERS_ACCOUNTS: (userId) => `ib:partners:accounts:${userId}`,
  IB_TREE: (userId) => `ib:tree:${userId}`,
  VERIFY_REFERRAL: (code) => `ib:referral:verify:${code}`,
  PENDING_DOWNLINE: (userId) => `ib:pending-downline:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  MY_IB_CONFIG: 300, // 5 minutes
  IB_DASHBOARD: 60, // 1 minute
  PARTNERS_ACCOUNTS: 60, // 1 minute
  IB_TREE: 300, // 5 minutes
  VERIFY_REFERRAL: 3600, // 1 hour
  PENDING_DOWNLINE: 60, // 1 minute
};

// Generate unique referral code with retry logic
const generateUniqueReferralCode = async (maxAttempts = 10) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const referralCode = crypto.randomBytes(3).toString("hex").toUpperCase();
    const existingCode = await IBClientConfiguration.findOne({ referralCode })
      .select("_id")
      .lean();
    if (!existingCode) return referralCode;
  }
  return null;
};
// @desc    Create a new IB referral code (or activate existing pending one)
// @route   POST /api/ibclients/ib-configurations/create
// @access  Private (Client)
exports.createIBConfiguration = async (req, res, next) => {
  try {
    // Check if user already has an IB configuration
    const existingConfig = await IBClientConfiguration.findOne({
      userId: req.user.id,
    }).lean();

    if (existingConfig) {
      // If user has a pending configuration without referral code, generate one
      if (existingConfig.status === "pending" && !existingConfig.referralCode) {
        const referralCode = await generateUniqueReferralCode();

        if (!referralCode) {
          return res.status(500).json({
            success: false,
            message: "Failed to generate unique referral code",
          });
        }

        // Update existing configuration
        const updatedConfig = await IBClientConfiguration.findByIdAndUpdate(
          existingConfig._id,
          { referralCode, status: "active" },
          { new: true },
        );

        // Invalidate caches
        await invalidateIBConfigCaches(req.user.id);

        // Trigger notifications
        if (req.notificationTriggers) {
          await req.notificationTriggers.handleNewUserSignup(
            req.user, 
            updatedConfig.toObject(),
          );
        }

        return res.status(200).json({
          success: true,
          message: "IB configuration activated successfully with referral code",
          ibConfiguration: updatedConfig,
        });
      }
      // If user has pending configuration with referral code, just activate it
      else if (
        existingConfig.status === "pending" &&
        existingConfig.referralCode
      ) {
        const updatedConfig = await IBClientConfiguration.findByIdAndUpdate(
          existingConfig._id,
          { status: "active" },
          { new: true },
        );

        await invalidateIBConfigCaches(req.user.id);

        return res.status(200).json({
          success: true,
          message: "IB configuration activated successfully",
          ibConfiguration: updatedConfig,
        });
      }
      // If user already has active configuration
      else {
        return res.status(400).json({
          success: false,
          message: "You already have an active IB referral code",
        });
      }
    }

    // Generate new referral code
    const referralCode = await generateUniqueReferralCode();
    if (!referralCode) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate unique referral code",
      });
    }

    const user = await User.findById(req.user.id).lean();
    let parentIB = null;

    if (user.referredBy) {
      parentIB = await IBClientConfiguration.findOne({
        referralCode: user.referredBy,
      }).lean();
    }

    const ibConfiguration = await IBClientConfiguration.create({
      userId: req.user.id,
      referralCode,
      parent: parentIB ? parentIB._id : null,
      level: parentIB ? parentIB.level + 1 : 0,
      referredBy: user.referredBy,
      status: "active",
    });

    // Invalidate caches
    await invalidateIBConfigCaches(req.user.id);

    // Notify referrer if exists
    if (parentIB) {
      const referrer = await User.findById(parentIB.userId)
        .select("firstName lastName email")
        .lean();
      if (referrer && req.notificationTriggers) {
        await req.notificationTriggers.handleNewReferral(
          ibConfiguration.toObject(),
          referrer,
        );
      }
    }

    // Trigger notifications for new IB signup
    if (req.notificationTriggers) {
      await req.notificationTriggers.handleNewUserSignup(
        req.user,
        ibConfiguration.toObject(),
      );
    }

    res.status(201).json({
      success: true,
      message: "IB configuration created successfully",
      ibConfiguration,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get user's own IB referral code with parent details
// @route   GET /api/ibclients/ib-configurations/my-code
// @access  Private (Client)
exports.getMyIBConfiguration = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.MY_IB_CONFIG(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        ibConfiguration: cached,
        fromCache: true,
      });
    }

    const ibConfiguration = await IBClientConfiguration.findOne({ userId })
      .populate({
        path: "parent",
        populate: { path: "userId", select: "firstName lastName email" },
      })
      .lean();

    if (!ibConfiguration) {
      return res.status(200).json({
        success: false,
        message: "No IB configuration found for this user",
      });
    }

    // Get parent referral details if exists
    let parentDetails = null;
    if (ibConfiguration.parent?.userId) {
      parentDetails = {
        name: `${ibConfiguration.parent.userId.firstName} ${ibConfiguration.parent.userId.lastName}`,
        email: ibConfiguration.parent.userId.email,
        referralCode: ibConfiguration.parent.referralCode,
        level: ibConfiguration.parent.level,
      };
    }

    const result = {
      ...ibConfiguration,
      maximumCommission: ibConfiguration.maximumCommission ?? null,
      parentDetails,
      isPendingAssignment: ibConfiguration.maximumCommission == null,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.MY_IB_CONFIG);

    res.status(200).json({
      success: true,
      ibConfiguration: result,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get IB dashboard summary
// @route   GET /api/ibclients/ib-configurations/dashboard
// @access  Private (Client)
exports.getIBDashboardSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.IB_DASHBOARD(userId);

    const ibConfiguration = await IBClientConfiguration.findOne({
      userId,
    }).lean();

    if (!ibConfiguration) {
      return res.status(200).json({
        success: false,
        message:
          "No IB configuration found. Please create your referral code first.",
      });
    }

    // Resolved outside the cache so a commissionMode toggle is reflected on
    // the very next request instead of waiting out IB_DASHBOARD's TTL.
    const commissionMode = await resolveGroupCommissionMode(ibConfiguration);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        summary: { ...cached, commissionMode },
        fromCache: true,
      });
    }

    // Calendar-day boundaries (server local time)
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    // OPTIMIZED: Run aggregations in parallel
    const [
      totalCommissions,
      todayCommissions,
      totalWithdrawals,
      partnersCount,
      parentConfig,
    ] = await Promise.all([
        IBCommission.aggregate([
          { $match: { ibConfigurationId: ibConfiguration._id } },
          { $group: { _id: null, total: { $sum: "$commissionAmount" } } },
        ]),
        IBCommission.aggregate([
          {
            $match: {
              ibConfigurationId: ibConfiguration._id,
              createdAt: { $gte: startOfDay, $lt: endOfDay },
            },
          },
          { $group: { _id: null, total: { $sum: "$commissionAmount" } } },
        ]),
        IBWithdrawal.aggregate([
          {
            $match: {
              ibConfigurationId: ibConfiguration._id,
              status: { $in: ["completed", "approved"] },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        // Full downline (all levels), not just direct referrals, to match
        // the partners list page.
        IBClientConfiguration.aggregate([
          { $match: { _id: ibConfiguration._id } },
          {
            $graphLookup: {
              from: "ibclientconfigurations",
              startWith: "$_id",
              connectFromField: "_id",
              connectToField: "parent",
              as: "downline",
            },
          },
          { $project: { downline: 1 } },
          { $unwind: "$downline" },
          {
            $lookup: {
              from: "users",
              localField: "downline.userId",
              foreignField: "_id",
              as: "user",
            },
          },
          { $match: { user: { $ne: [] } } },
          { $count: "count" },
        ]),
        // Parent referrer details, if this IB was itself referred by someone.
        ibConfiguration.parent
          ? IBClientConfiguration.findById(ibConfiguration.parent)
              .populate("userId", "firstName lastName email")
              .select("userId referralCode level")
              .lean()
          : Promise.resolve(null),
      ]);

    const totalCommission = totalCommissions[0]?.total || 0;
    const todayCommission = todayCommissions[0]?.total || 0;
    const totalWithdrawn = totalWithdrawals[0]?.total || 0;
    const withdrawableBalance = totalCommission - totalWithdrawn;

    const parentDetails = parentConfig?.userId
      ? {
          name: `${parentConfig.userId.firstName} ${parentConfig.userId.lastName}`,
          email: parentConfig.userId.email,
          referralCode: parentConfig.referralCode,
          level: parentConfig.level,
        }
      : null;

    const result = {
      totalCommission,
      todayCommission,
      withdrawableBalance,
      totalWithdrawals: totalWithdrawn,
      partnersCount: partnersCount[0]?.count || 0,
      hasParent: !!ibConfiguration.parent,
      parentDetails,
    };

    // Cache the result (commissionMode is intentionally excluded from the
    // cached shape and merged back in fresh on every request, see above)
    await cacheService.set(cacheKey, result, CACHE_TTL.IB_DASHBOARD);

    res.status(200).json({
      success: true,
      summary: { ...result, commissionMode },
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get all partners/downline list
// @route   GET /api/ibclients/ib-configurations/partners
// @access  Private (Client)
exports.getPartnersList = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const ibConfiguration = await IBClientConfiguration.findOne({
      userId,
    }).lean();

    if (!ibConfiguration) {
      return res.status(204).json({
        success: false,
        message:
          "No IB configuration found. Please create your referral code first.",
      });
    }

    // Get all partners with levels normalized
    const partners = await getAllDownlinePartnersOptimized(
      ibConfiguration._id,
      ibConfiguration.level,
    );

    if (partners.length === 0) {
      return res.status(200).json({ success: true, partners: [] });
    }

    // OPTIMIZED: Batch get all partner data. Stale IB configs can reference a
    // deleted user, making populate("userId") return null.
    const validPartners = partners.filter((partner) =>
      getPartnerUserObjectId(partner),
    );
    const partnerUserIds = validPartners.map((partner) =>
      getPartnerUserObjectId(partner),
    );

    if (partnerUserIds.length === 0) {
      return res.status(200).json({ success: true, partners: [] });
    }

    const [commissionsVolume, commissionsEarned, accountsData] =
      await Promise.all([
        // Total volume from partners
        IBCommission.aggregate([
          { $match: { clientId: { $in: partnerUserIds } } },
          { $group: { _id: "$clientId", totalVolume: { $sum: "$volume" } } },
        ]),
        // Commissions earned from partners
        IBCommission.aggregate([
          {
            $match: {
              ibConfigurationId: ibConfiguration._id,
              clientId: { $in: partnerUserIds },
            },
          },
          {
            $group: {
              _id: "$clientId",
              totalEarned: { $sum: "$commissionAmount" },
            },
          },
        ]),
        // Account data for partners
        Account.aggregate([
          { $match: { user: { $in: partnerUserIds } } },
          {
            $group: {
              _id: "$user",
              totalBalance: { $sum: "$balance" },
              totalEquity: { $sum: "$equity" },
            },
          },
        ]),
      ]);

    // Create maps for O(1) lookup
    const volumeMap = new Map(
      commissionsVolume.map((v) => [v._id.toString(), v.totalVolume]),
    );
    const earnedMap = new Map(
      commissionsEarned.map((e) => [e._id.toString(), e.totalEarned]),
    );
    const accountMap = new Map(
      accountsData.map((a) => [
        a._id.toString(),
        { balance: a.totalBalance, equity: a.totalEquity },
      ]),
    );

    // Map of IB configuration id -> referrer details, so each partner can
    // show who referred them (their immediate parent in the tree). Includes
    // the requesting user's own config since it's the parent of their direct
    // referrals.
    const configReferrerMap = new Map(
      validPartners.map((partner) => [
        partner._id.toString(),
        {
          name: `${partner.userId.firstName} ${partner.userId.lastName}`,
          email: partner.userId.email,
          referralCode: partner.referralCode,
        },
      ]),
    );
    configReferrerMap.set(ibConfiguration._id.toString(), {
      name: `${req.user.firstName} ${req.user.lastName}`,
      email: req.user.email,
      referralCode: ibConfiguration.referralCode,
    });

    // Build enhanced partners list
    const enhancedPartners = validPartners.map((partner) => {
      const partnerId = getPartnerUserObjectId(partner).toString();
      return {
        _id: partner._id,
        userId: partner.userId,
        referralCode: partner.referralCode,
        level: partner.level,
        parent: partner.parent,
        parentDetails: partner.parent
          ? configReferrerMap.get(partner.parent.toString()) || null
          : null,
        maximumCommission: partner.maximumCommission ?? null,
        isPendingAssignment: partner.maximumCommission == null,
        totalVolume: volumeMap.get(partnerId) || 0,
        totalEarned: earnedMap.get(partnerId) || 0,
        totalBalance: accountMap.get(partnerId)?.balance || 0,
        totalEquity: accountMap.get(partnerId)?.equity || 0,
        createdAt: partner.createdAt,
      };
    });

    res.status(200).json({
      success: true,
      partners: enhancedPartners,
    });
  } catch (error) {
    next(error);
  }
};
// Get all accounts for a specific user
exports.getPartnersAccounts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.PARTNERS_ACCOUNTS(userId);

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

    const ibConfiguration = await IBClientConfiguration.findOne({
      userId,
    }).lean();

    if (!ibConfiguration) {
      return res.status(204).json({
        success: false,
        message:
          "No IB configuration found. Please create your referral code first.",
      });
    }

    // Get all partners
    const partners = await getAllDownlinePartnersOptimized(
      ibConfiguration._id,
      ibConfiguration.level,
    );

    if (partners.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const partnerUserIds = partners
      .map((partner) => getPartnerUserObjectId(partner))
      .filter(Boolean);

    if (partnerUserIds.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    // Get all accounts for partners
    const allAccounts = await Account.find({ user: { $in: partnerUserIds } })
      .select(
        "mt5Account name accountType leverage balance equity managerIndex user",
      )
      .sort({ createdAt: -1 })
      .lean();

    if (allAccounts.length === 0) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    // Refresh balances from MT5 (non-blocking, don't wait for cache)
    refreshPartnerAccountBalances(allAccounts).catch((err) =>
      console.error("Error refreshing partner balances:", err),
    );

    // Cache the result
    await cacheService.set(
      cacheKey,
      {
        count: allAccounts.length,
        data: allAccounts,
      },
      CACHE_TTL.PARTNERS_ACCOUNTS,
    );

    res.status(200).json({
      success: true,
      count: allAccounts.length,
      data: allAccounts,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Verify and apply referral code during signup
// @route   POST /api/ibclients/ib-configurations/verify-referral
// @access  Public
exports.verifyReferralCode = async (req, res, next) => {
  try {
    const { referralCode } = req.body;

    if (!referralCode) {
      return res.status(400).json({
        success: false,
        message: "Referral code is required",
      });
    }

    const cacheKey = CACHE_KEYS.VERIFY_REFERRAL(referralCode);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const ibConfiguration = await IBClientConfiguration.findOne({
      referralCode,
      status: "active",
    }).lean();

    if (!ibConfiguration) {
      const errorResponse = {
        success: false,
        message: "Invalid or inactive referral code",
      };
      await cacheService.set(
        cacheKey,
        errorResponse,
        CACHE_TTL.VERIFY_REFERRAL,
      );
      return res.status(200).json(errorResponse);
    }

    const referringUser = await User.findById(ibConfiguration.userId)
      .select("firstName lastName")
      .lean();

    if (!referringUser) {
      const errorResponse = {
        success: false,
        message: "Referring user not found",
      };
      await cacheService.set(
        cacheKey,
        errorResponse,
        CACHE_TTL.VERIFY_REFERRAL,
      );
      return res.status(200).json(errorResponse);
    }

    const successResponse = {
      success: true,
      message: "Valid referral code",
      referralInfo: {
        referralCode,
        referringUserName: `${referringUser.firstName} ${referringUser.lastName}`,
      },
    };

    await cacheService.set(
      cacheKey,
      successResponse,
      CACHE_TTL.VERIFY_REFERRAL,
    );

    res.status(200).json(successResponse);
  } catch (error) {
    next(error);
  }
};
// @desc    Get IB tree data with proper hierarchy
// @route   GET /api/ibclients/ib-configurations/tree
// @access  Private (Client)
exports.getIBTree = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.IB_TREE(userId);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        ...cached,
        fromCache: true,
      });
    }

    const userIBConfig = await IBClientConfiguration.findOne({ userId })
      .populate("userId", "firstName lastName email")
      .lean();

    if (!userIBConfig) {
      return res.status(200).json({
        success: false,
        message:
          "No IB configuration found. Please create your referral code first.",
      });
    }

    let rootNode = null;
    let currentUserNode = null;

    // Build tree structure
    if (userIBConfig.parent) {
      const parentConfig = await IBClientConfiguration.findById(
        userIBConfig.parent,
      )
        .populate("userId", "firstName lastName email")
        .lean();

      if (parentConfig) {
        rootNode = {
          id: parentConfig._id.toString(),
          name: `${parentConfig.userId.firstName} ${parentConfig.userId.lastName}`,
          email: parentConfig.userId.email,
          referralCode: parentConfig.referralCode,
          level: "ROOT",
          maximumCommission: parentConfig.maximumCommission ?? null,
          isPendingAssignment: parentConfig.maximumCommission == null,
          isRoot: true,
          children: [],
        };

        currentUserNode = {
          id: userIBConfig._id.toString(),
          name: `${req.user.firstName} ${req.user.lastName} (You)`,
          email: req.user.email,
          referralCode: userIBConfig.referralCode,
          level: "0",
          maximumCommission: userIBConfig.maximumCommission ?? null,
          isPendingAssignment: userIBConfig.maximumCommission == null,
          isCurrentUser: true,
          children: [],
        };

        rootNode.children.push(currentUserNode);
      }
    } else {
      currentUserNode = {
        id: userIBConfig._id.toString(),
        name: `${req.user.firstName} ${req.user.lastName} (You)`,
        email: req.user.email,
        referralCode: userIBConfig.referralCode,
        level: "ROOT",
        maximumCommission: userIBConfig.maximumCommission ?? null,
        isPendingAssignment: userIBConfig.maximumCommission == null,
        isCurrentUser: true,
        isRoot: true,
        children: [],
      };
      rootNode = currentUserNode;
    }

    // Get downline partners
    const userDownlinePartners = await getAllDownlinePartnersForTreeOptimized(
      userIBConfig._id,
    );

    // Build tree recursively
    const buildDownlineTree = (partners, parentId, baseLevel) => {
      const directChildren = partners.filter(
        (partner) => partner.parent?.toString() === parentId,
      );

      return directChildren.map((child) => {
        const levelNumber = baseLevel + 1;
        return {
          id: child._id.toString(),
          name: `${child.userId.firstName} ${child.userId.lastName}`,
          email: child.userId.email,
          referralCode: child.referralCode,
          level: `${levelNumber}`,
          maximumCommission: child.maximumCommission ?? null,
          isPendingAssignment: child.maximumCommission == null,
          children: buildDownlineTree(
            partners,
            child._id.toString(),
            levelNumber,
          ),
        };
      });
    };

    currentUserNode.children = buildDownlineTree(
      userDownlinePartners,
      userIBConfig._id.toString(),
      0,
    );

    const result = {
      treeData: rootNode,
      currentUserLevel: currentUserNode.level,
      hasParent: !!userIBConfig.parent,
      totalDownlinePartners: userDownlinePartners.length,
    };

    // Cache the result
    await cacheService.set(cacheKey, result, CACHE_TTL.IB_TREE);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get direct downline referrals that still need a commission assigned
// @route   GET /api/ibclients/ib-configurations/downline/pending
// @access  Private (Client)
exports.getPendingDownlineAssignments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const cacheKey = CACHE_KEYS.PENDING_DOWNLINE(userId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        pending: cached.pending,
        myMaximumCommission: cached.myMaximumCommission,
        fromCache: true,
      });
    }

    const myConfig = await IBClientConfiguration.findOne({ userId }).lean();

    if (!myConfig) {
      return res.status(200).json({
        success: false,
        message: "No IB configuration found for this user",
      });
    }

    const pendingChildren = await IBClientConfiguration.find({
      parent: myConfig._id,
      maximumCommission: null,
    })
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    const pending = pendingChildren.filter((child) => child.userId);
    const myMaximumCommission = myConfig.maximumCommission ?? null;

    await cacheService.set(
      cacheKey,
      { pending, myMaximumCommission },
      CACHE_TTL.PENDING_DOWNLINE,
    );

    res.status(200).json({
      success: true,
      pending,
      myMaximumCommission,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Assign (or update) the maximum commission for a direct referral
// @route   PATCH /api/ibclients/ib-configurations/downline/:childConfigId/commission
// @access  Private (Client)
exports.assignDownlineCommission = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { childConfigId } = req.params;
    const { maximumCommission } = req.body;

    if (!mongoose.Types.ObjectId.isValid(childConfigId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid downline configuration ID",
      });
    }

    if (maximumCommission === undefined || maximumCommission == null) {
      return res.status(400).json({
        success: false,
        message: "maximumCommission is required",
      });
    }

    if (maximumCommission < 0) {
      return res.status(400).json({
        success: false,
        message: "Maximum commission cannot be negative",
      });
    }

    const myConfig = await IBClientConfiguration.findOne({ userId });

    if (!myConfig) {
      return res.status(404).json({
        success: false,
        message: "No IB configuration found for this user",
      });
    }

    if (myConfig.maximumCommission == null) {
      return res.status(400).json({
        success: false,
        message: "Your own maximum commission has not been assigned yet",
      });
    }

    if (maximumCommission > myConfig.maximumCommission) {
      return res.status(400).json({
        success: false,
        message: `Maximum commission cannot exceed your own maximum of ${myConfig.maximumCommission}`,
      });
    }

    const childConfig = await IBClientConfiguration.findById(childConfigId);

    if (!childConfig) {
      return res.status(404).json({
        success: false,
        message: "Downline configuration not found",
      });
    }

    if (
      !childConfig.parent ||
      childConfig.parent.toString() !== myConfig._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only assign commission to your direct referrals",
      });
    }

    childConfig.maximumCommission = maximumCommission;
    await childConfig.save();

    await Promise.all([
      invalidateIBConfigCaches(userId),
      invalidateIBConfigCaches(childConfig.userId.toString()),
    ]);

    if (req.notificationTriggers) {
      await req.notificationTriggers.handleNewReferral?.(
        childConfig.toObject(),
        req.user,
      );
    }

    res.status(200).json({
      success: true,
      message: "Downline commission assigned successfully",
      data: childConfig,
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

async function getAllDownlinePartnersBase(ibConfigId) {
  const [result] = await IBClientConfiguration.aggregate([
    {
      $match: {
        _id:
          ibConfigId instanceof mongoose.Types.ObjectId
            ? ibConfigId
            : new mongoose.Types.ObjectId(ibConfigId),
      },
    },
    {
      $graphLookup: {
        from: "ibclientconfigurations",
        startWith: "$_id",
        connectFromField: "_id",
        connectToField: "parent",
        as: "downline",
        depthField: "graphDepth",
      },
    },
    {
      $project: {
        _id: 0,
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
    .select("firstName lastName email")
    .lean();

  const userMap = new Map(users.map((user) => [user._id.toString(), user]));
  const childrenByParent = new Map();

  for (const partner of partners) {
    const parentId = partner.parent?.toString();
    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }
    childrenByParent.get(parentId).push(partner);
  }

  const orderedPartners = [];
  const traverse = (parentId) => {
    const children = childrenByParent.get(parentId) || [];

    for (const child of children) {
      const userId = child.userId?.toString();
      orderedPartners.push({
        ...child,
        userId: userId ? userMap.get(userId) || null : null,
      });
      traverse(child._id.toString());
    }
  };

  traverse(ibConfigId.toString());

  return orderedPartners;
}

// Optimized recursive function to get all downline partners
async function getAllDownlinePartnersOptimized(
  ibConfigId,
  currentUserLevel = null,
) {
  const partners = await getAllDownlinePartnersBase(ibConfigId);

  return partners.map((partner) => ({
    ...partner,
    level:
      currentUserLevel !== null ? partner.level - currentUserLevel : partner.level,
  }));
}

// Optimized function for tree building (without level normalization)
async function getAllDownlinePartnersForTreeOptimized(ibConfigId) {
  return getAllDownlinePartnersBase(ibConfigId);
}

// Refresh partner account balances (background task)
async function refreshPartnerAccountBalances(accounts) {
  const accountsByManager = new Map();

  for (const account of accounts) {
    const managerIndex = account.managerIndex || "3";
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
        const mt5AccountNumbers = managerAccounts.map((acc) => acc.mt5Account);
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
            { timeout: 15000 },
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
                      update: { $set: { balance, equity } },
                    },
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error(
            `Error refreshing balances for manager ${managerIndex}:`,
            error.message,
          );
        }

        return managerBulkOperations;
      },
    ),
  );

  const bulkOperations = managerResults.flat();

  if (bulkOperations.length > 0) {
    await Account.bulkWrite(bulkOperations, { ordered: false });
  }
}

// Invalidate all IB configuration caches for a user
async function invalidateIBConfigCaches(userId) {
  const patterns = [
    CACHE_KEYS.MY_IB_CONFIG(userId),
    CACHE_KEYS.IB_DASHBOARD(userId),
    CACHE_KEYS.PARTNERS_ACCOUNTS(userId),
    CACHE_KEYS.IB_TREE(userId),
  ];

  for (const pattern of patterns) {
    await cacheService.deletePattern(pattern);
  }
  console.log(`🗑️ IB config caches invalidated for user: ${userId}`);
}

// Export helper functions
exports.getAllDownlinePartners = getAllDownlinePartnersOptimized;
exports.getAllDownlinePartnersForTree = getAllDownlinePartnersForTreeOptimized;
exports.invalidateIBConfigCaches = invalidateIBConfigCaches;

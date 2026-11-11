// backend/controllers/admin/adminPartnerController.js
const mongoose = require("mongoose");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const IBAdminConfiguration = require("../../models/admin/IBAdminConfiguration");
const IBCommission = require("../../models/IBCommission");
const User = require("../../models/User");
const cacheService = require("../../services/cacheService");
const {
  invalidateIBConfigCaches: invalidateClientIBConfigCaches,
} = require("../client/ibClientConfigurationController");

const CACHE_KEYS = {
  ALL_PARTNERS: "admin:partners:all",
  PARTNER_STATS: "admin:partners:stats",
  PARTNER_DETAIL: (id) => `admin:partners:detail:${id}`,
  PARTNER_TREE: (id) => `admin:partners:tree:${id}`,
};

const CACHE_TTL = {
  ALL_PARTNERS: 30,
  PARTNER_STATS: 60,
  PARTNER_DETAIL: 30,
  PARTNER_TREE: 30,
};

const STORED_SORT_FIELDS = {
  createdAt: "createdAt",
  level: "level",
  name: "user.firstName",
  referralCode: "referralCode",
};
const COMPUTED_SORT_FIELDS = new Set(["totalEarned", "directReferrals"]);

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const emptyCommissionTotals = () => ({
  totalEarned: 0,
  totalTrades: 0,
  totalVolume: 0,
  totalPaid: 0,
  totalPending: 0,
  totalConfirmed: 0,
});

// Bulk-computes commission totals for a batch of IB user ids in a single
// indexed aggregation, instead of a correlated $lookup pipeline per partner.
const getCommissionTotalsMap = async (userIds) => {
  const map = new Map();
  if (!userIds.length) return map;

  const rows = await IBCommission.aggregate([
    { $match: { ibUserId: { $in: userIds } } },
    {
      $group: {
        _id: "$ibUserId",
        totalEarned: { $sum: "$commissionAmount" },
        totalTrades: { $sum: 1 },
        totalVolume: { $sum: "$volume" },
        totalPaid: {
          $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$commissionAmount", 0] },
        },
        totalPending: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$commissionAmount", 0] },
        },
        totalConfirmed: {
          $sum: { $cond: [{ $eq: ["$status", "confirmed"] }, "$commissionAmount", 0] },
        },
      },
    },
  ]);

  for (const row of rows) {
    map.set(row._id.toString(), row);
  }
  return map;
};

// Bulk-computes direct-referral counts for a batch of config ids in a single
// indexed aggregation (uses the { parent: 1 } index), instead of one
// correlated $lookup pipeline per partner.
const getDirectReferralCountsMap = async (configIds) => {
  const map = new Map();
  if (!configIds.length) return map;

  const rows = await IBClientConfiguration.aggregate([
    { $match: { parent: { $in: configIds } } },
    { $group: { _id: "$parent", count: { $sum: 1 } } },
  ]);

  for (const row of rows) {
    map.set(row._id.toString(), row.count);
  }
  return map;
};

// @desc    Get all partners with referrer, downline and commission totals
// @route   GET /api/admin/partners
// @access  Private (Admin)
exports.getAllPartners = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      status = "all",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.max(parseInt(limit) || 20, 1);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = cacheService.generateKey(CACHE_KEYS.ALL_PARTNERS, {
      page: pageNum,
      limit: limitNum,
      search,
      status,
      sortBy,
      sortOrder,
    });

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, ...cached, fromCache: true });
    }

    const matchStage = {};
    if (status && status !== "all") {
      matchStage.status = status;
    }

    // Cheap base pipeline: just the filter + user join needed for search/display.
    // No per-partner commission/referral lookups here — those are batched below,
    // scoped to only the rows that actually get returned.
    const basePipeline = [
      { $match: matchStage },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
          pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1, status: 1 } }],
        },
      },
      { $unwind: "$user" },
    ];

    if (search && search.trim()) {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
      basePipeline.push({
        $match: {
          $or: [
            { "user.firstName": searchRegex },
            { "user.lastName": searchRegex },
            { "user.email": searchRegex },
            { referralCode: searchRegex },
          ],
        },
      });
    }

    basePipeline.push({
      $project: {
        referralCode: 1,
        referredBy: 1,
        status: 1,
        level: 1,
        IBbalance: 1,
        maximumCommission: 1,
        createdAt: 1,
        updatedAt: 1,
        parent: 1,
        userId: 1,
        user: {
          _id: "$user._id",
          firstName: "$user.firstName",
          lastName: "$user.lastName",
          email: "$user.email",
          status: "$user.status",
        },
      },
    });

    const isComputedSort = COMPUTED_SORT_FIELDS.has(sortBy);
    let rows;
    let total;

    if (isComputedSort) {
      // Sorting by a computed value (totalEarned / directReferrals) needs every
      // matching row before it can be ranked — but that's still one lean query
      // plus two bulk aggregations below, not N correlated lookups.
      rows = await IBClientConfiguration.aggregate(basePipeline);
      total = rows.length;
    } else {
      const sortField = STORED_SORT_FIELDS[sortBy] || "createdAt";
      const [result] = await IBClientConfiguration.aggregate([
        ...basePipeline,
        { $sort: { [sortField]: sortOrder === "asc" ? 1 : -1 } },
        {
          $facet: {
            data: [{ $skip: skip }, { $limit: limitNum }],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);
      rows = result?.data || [];
      total = result?.totalCount?.[0]?.count || 0;
    }

    const configIds = rows.map((r) => r._id);
    const userIds = rows.map((r) => r.userId);
    const parentIds = [...new Set(rows.filter((r) => r.parent).map((r) => r.parent.toString()))].map(
      (id) => new mongoose.Types.ObjectId(id),
    );

    const [commissionMap, directReferralMap, parentConfigs] = await Promise.all([
      getCommissionTotalsMap(userIds),
      getDirectReferralCountsMap(configIds),
      parentIds.length
        ? IBClientConfiguration.find({ _id: { $in: parentIds } })
            .select("referralCode userId")
            .populate("userId", "firstName lastName email")
            .lean()
        : [],
    ]);

    const parentConfigMap = new Map(parentConfigs.map((pc) => [pc._id.toString(), pc]));

    let partners = rows.map((r) => {
      const commission = commissionMap.get(r.userId.toString()) || emptyCommissionTotals();
      const parentConfig = r.parent ? parentConfigMap.get(r.parent.toString()) : null;
      return {
        _id: r._id,
        referralCode: r.referralCode,
        referredBy: r.referredBy,
        status: r.status,
        level: r.level,
        IBbalance: r.IBbalance,
        maximumCommission: r.maximumCommission ?? null,
        isPendingAssignment: r.maximumCommission == null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        directReferrals: directReferralMap.get(r._id.toString()) || 0,
        totalEarned: commission.totalEarned,
        totalTrades: commission.totalTrades,
        totalVolume: commission.totalVolume,
        totalPaid: commission.totalPaid,
        totalPending: commission.totalPending,
        totalConfirmed: commission.totalConfirmed,
        user: r.user,
        referrer: parentConfig?.userId
          ? {
              _id: parentConfig.userId._id,
              firstName: parentConfig.userId.firstName,
              lastName: parentConfig.userId.lastName,
              email: parentConfig.userId.email,
              referralCode: parentConfig.referralCode,
            }
          : null,
      };
    });

    if (isComputedSort) {
      partners.sort((a, b) =>
        sortOrder === "asc" ? a[sortBy] - b[sortBy] : b[sortBy] - a[sortBy],
      );
      partners = partners.slice(skip, skip + limitNum);
    }

    const response = {
      partners,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_PARTNERS);

    res.status(200).json({ success: true, ...response });
  } catch (error) {
    next(error);
  }
};

// @desc    Get platform-wide partner/commission overview stats
// @route   GET /api/admin/partners/stats
// @access  Private (Admin)
exports.getPartnerStats = async (req, res, next) => {
  try {
    const cached = await cacheService.get(CACHE_KEYS.PARTNER_STATS);
    if (cached) {
      return res.status(200).json({ success: true, stats: cached, fromCache: true });
    }

    const [statusCounts, commissionStats, totalPartners] = await Promise.all([
      IBClientConfiguration.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      IBCommission.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            amount: { $sum: "$commissionAmount" },
          },
        },
      ]),
      IBClientConfiguration.countDocuments(),
    ]);

    const byStatus = statusCounts.reduce((acc, s) => {
      acc[s._id] = s.count;
      return acc;
    }, {});

    const commissionByStatus = commissionStats.reduce((acc, s) => {
      acc[s._id] = { count: s.count, amount: s.amount };
      return acc;
    }, {});

    const totalCommissionPaid = commissionByStatus.paid?.amount || 0;
    const totalCommissionPending = commissionByStatus.pending?.amount || 0;
    const totalCommissionConfirmed = commissionByStatus.confirmed?.amount || 0;

    const stats = {
      totalPartners,
      activePartners: byStatus.active || 0,
      pendingPartners: byStatus.pending || 0,
      inactivePartners: byStatus.inactive || 0,
      totalCommissionPaid,
      totalCommissionPending,
      totalCommissionConfirmed,
      totalCommissionAllTime:
        totalCommissionPaid + totalCommissionPending + totalCommissionConfirmed,
      commissionByStatus,
    };

    await cacheService.set(CACHE_KEYS.PARTNER_STATS, stats, CACHE_TTL.PARTNER_STATS);

    res.status(200).json({ success: true, stats });
  } catch (error) {
    next(error);
  }
};

// @desc    Get a single partner's detail: profile, referrer, direct downline
// @route   GET /api/admin/partners/:id
// @access  Private (Admin)
exports.getPartnerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid partner ID format." });
    }

    const cacheKey = CACHE_KEYS.PARTNER_DETAIL(id);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, partner: cached, fromCache: true });
    }

    const configId = new mongoose.Types.ObjectId(id);

    const partnerDoc = await IBClientConfiguration.findById(configId)
      .populate("userId", "firstName lastName email phone status country createdAt")
      .populate("groupId", "name value commissionMode")
      .lean();

    if (!partnerDoc) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    const [parentConfig, directChildren] = await Promise.all([
      partnerDoc.parent
        ? IBClientConfiguration.findById(partnerDoc.parent)
            .select("referralCode userId")
            .populate("userId", "firstName lastName email")
            .lean()
        : null,
      IBClientConfiguration.find({ parent: configId })
        .select("referralCode status level createdAt userId maximumCommission")
        .populate("userId", "firstName lastName email")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    // Batch commission totals for this partner + all its direct children in
    // one aggregation instead of a correlated lookup per row.
    const commissionUserIds = [
      partnerDoc.userId._id,
      ...directChildren.filter((c) => c.userId?._id).map((c) => c.userId._id),
    ];
    const commissionMap = await getCommissionTotalsMap(commissionUserIds);
    const ownTotals =
      commissionMap.get(partnerDoc.userId._id.toString()) || emptyCommissionTotals();

    const directDownline = directChildren.map((c) => {
      const totals = c.userId?._id
        ? commissionMap.get(c.userId._id.toString()) || emptyCommissionTotals()
        : emptyCommissionTotals();
      return {
        _id: c._id,
        referralCode: c.referralCode,
        status: c.status,
        level: c.level,
        createdAt: c.createdAt,
        user: c.userId,
        maximumCommission: c.maximumCommission ?? null,
        isPendingAssignment: c.maximumCommission == null,
        totalEarned: totals.totalEarned,
        totalTrades: totals.totalTrades,
        totalVolume: totals.totalVolume,
      };
    });

    const partner = {
      _id: partnerDoc._id,
      referralCode: partnerDoc.referralCode,
      referredBy: partnerDoc.referredBy,
      status: partnerDoc.status,
      level: partnerDoc.level,
      IBbalance: partnerDoc.IBbalance,
      maximumCommission: partnerDoc.maximumCommission ?? null,
      isPendingAssignment: partnerDoc.maximumCommission == null,
      isRoot: !partnerDoc.parent,
      // Only meaningful for root IBs today - Sub-IBs don't carry their own
      // groupId, so the frontend falls back to treating them as waterfall.
      group: partnerDoc.groupId
        ? {
            _id: partnerDoc.groupId._id,
            name: partnerDoc.groupId.name,
            commissionMode: partnerDoc.groupId.commissionMode || "waterfall",
          }
        : null,
      createdAt: partnerDoc.createdAt,
      updatedAt: partnerDoc.updatedAt,
      user: partnerDoc.userId,
      referrer: parentConfig?.userId
        ? {
            _id: parentConfig.userId._id,
            firstName: parentConfig.userId.firstName,
            lastName: parentConfig.userId.lastName,
            email: parentConfig.userId.email,
            referralCode: parentConfig.referralCode,
          }
        : null,
      directDownline,
      directReferrals: directDownline.length,
      ...ownTotals,
    };

    await cacheService.set(cacheKey, partner, CACHE_TTL.PARTNER_DETAIL);

    res.status(200).json({ success: true, partner });
  } catch (error) {
    next(error);
  }
};

// @desc    Get a partner's full downline tree (all levels)
// @route   GET /api/admin/partners/:id/tree
// @access  Private (Admin)
exports.getPartnerDownlineTree = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid partner ID format." });
    }

    const cacheKey = CACHE_KEYS.PARTNER_TREE(id);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, ...cached, fromCache: true });
    }

    const rootConfig = await IBClientConfiguration.findById(id).populate(
      "userId",
      "firstName lastName email",
    );

    if (!rootConfig) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    const rootId = new mongoose.Types.ObjectId(id);

    const [result] = await IBClientConfiguration.aggregate([
      { $match: { _id: rootId } },
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
      { $project: { _id: 0, downline: 1 } },
    ]);

    const partners = result?.downline || [];
    const userIds = partners
      .map((p) => p.userId)
      .filter((uid) => mongoose.Types.ObjectId.isValid(uid));

    const users = await User.find({ _id: { $in: userIds } })
      .select("firstName lastName email")
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const childrenByParent = new Map();
    for (const partner of partners) {
      const parentId = partner.parent?.toString();
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(partner);
    }

    const buildTree = (parentId) => {
      const children = childrenByParent.get(parentId) || [];
      return children.map((child) => {
        const user = userMap.get(child.userId?.toString());
        return {
          id: child._id.toString(),
          name: user ? `${user.firstName} ${user.lastName}` : "Unknown",
          email: user?.email || "",
          referralCode: child.referralCode,
          status: child.status,
          level: child.level,
          maximumCommission: child.maximumCommission ?? null,
          isPendingAssignment: child.maximumCommission == null,
          children: buildTree(child._id.toString()),
        };
      });
    };

    const treeData = {
      id: rootConfig._id.toString(),
      name: `${rootConfig.userId.firstName} ${rootConfig.userId.lastName}`,
      email: rootConfig.userId.email,
      referralCode: rootConfig.referralCode,
      status: rootConfig.status,
      level: rootConfig.level,
      maximumCommission: rootConfig.maximumCommission ?? null,
      isPendingAssignment: rootConfig.maximumCommission == null,
      isRoot: true,
      children: buildTree(rootConfig._id.toString()),
    };

    const response = { treeData, totalDownlinePartners: partners.length };

    await cacheService.set(cacheKey, response, CACHE_TTL.PARTNER_TREE);

    res.status(200).json({ success: true, ...response });
  } catch (error) {
    next(error);
  }
};

// @desc    Get a partner's trade-level commission history
// @route   GET /api/admin/partners/:id/commissions
// @access  Private (Admin)
exports.getPartnerCommissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid partner ID format." });
    }

    const { page = 1, limit = 20, status = "all", level = "all" } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.max(parseInt(limit) || 20, 1);
    const skip = (pageNum - 1) * limitNum;

    const config = await IBClientConfiguration.findById(id).select("userId");
    if (!config) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    const query = { ibUserId: config.userId };
    if (status && status !== "all") query.status = status;
    if (level && level !== "all") query.level = parseInt(level);

    const [commissions, total] = await Promise.all([
      IBCommission.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("clientId", "firstName lastName email")
        .lean(),
      IBCommission.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      commissions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Admin sets/overrides the maximum commission for ANY partner
//          (root or Sub-IB), regardless of who normally controls that rate.
// @route   PATCH /api/admin/partners/:id/commission
// @access  Private (Admin)
exports.updatePartnerCommission = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { maximumCommission, groupId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid partner ID format." });
    }

    if (maximumCommission === undefined || maximumCommission === null) {
      return res.status(400).json({ success: false, message: "maximumCommission is required." });
    }

    if (maximumCommission < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Maximum commission cannot be negative." });
    }

    const partnerConfig = await IBClientConfiguration.findById(id);
    if (!partnerConfig) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    if (partnerConfig.parent) {
      // Sub-IB: bounded by the parent's own maximumCommission.
      const parentConfig = await IBClientConfiguration.findById(partnerConfig.parent)
        .select("maximumCommission")
        .lean();

      if (!parentConfig || parentConfig.maximumCommission == null) {
        return res.status(400).json({
          success: false,
          message: "This partner's upline has no maximum commission assigned yet.",
        });
      }

      if (maximumCommission > parentConfig.maximumCommission) {
        return res.status(400).json({
          success: false,
          message: `Maximum commission cannot exceed the upline's maximum of ${parentConfig.maximumCommission}.`,
        });
      }
    } else {
      // Root IB: bounded by the group ceiling. Reuse the partner's existing
      // group if one isn't explicitly supplied.
      const effectiveGroupId = groupId || partnerConfig.groupId;
      if (!effectiveGroupId) {
        return res.status(400).json({
          success: false,
          message: "groupId is required to assign a root IB's maximum commission.",
        });
      }
      if (!mongoose.Types.ObjectId.isValid(effectiveGroupId)) {
        return res.status(400).json({ success: false, message: "Invalid groupId format." });
      }

      const groupConfig = await IBAdminConfiguration.findOne({
        groupId: effectiveGroupId,
        maximumCommission: { $exists: true },
      }).lean();

      if (!groupConfig) {
        return res.status(400).json({
          success: false,
          message: "This group has no commission ceiling configured yet.",
        });
      }

      if (maximumCommission > groupConfig.maximumCommission) {
        return res.status(400).json({
          success: false,
          message: `Maximum commission cannot exceed the group ceiling of ${groupConfig.maximumCommission}.`,
        });
      }

      partnerConfig.groupId = effectiveGroupId;
    }

    // Soft warning: any direct children already granted more than the new
    // value will be clamped to 0 at payout time until rebalanced. We still
    // apply the admin's override (they have final authority) but surface it.
    const overGrantedChildren = await IBClientConfiguration.find({
      parent: partnerConfig._id,
      maximumCommission: { $gt: maximumCommission },
    })
      .select("_id")
      .lean();

    partnerConfig.maximumCommission = maximumCommission;
    if (partnerConfig.status === "pending") {
      partnerConfig.status = "active";
    }
    await partnerConfig.save();

    await Promise.all([
      cacheService.deletePattern("admin:partners:*"),
      cacheService.deletePattern("admin:ib:root:list"),
      invalidateClientIBConfigCaches(partnerConfig.userId.toString()),
    ]);

    res.status(200).json({
      success: true,
      message: "Commission updated successfully",
      data: partnerConfig,
      warning:
        overGrantedChildren.length > 0
          ? `${overGrantedChildren.length} direct referral(s) currently have a higher commission than this new value and will earn $0 until rebalanced.`
          : undefined,
    });
  } catch (error) {
    next(error);
  }
};

// Invalidate partner-facing caches (list/stats/detail/tree) so group-level
// changes like commissionMode show up immediately instead of waiting out
// PARTNER_DETAIL's TTL.
exports.invalidatePartnerCaches = async () => {
  await cacheService.deletePattern("admin:partners:*");
};

// Backend/controllers/admin/pammController.js
const mongoose = require("mongoose");
const Pamm = require("../../models/Pamm");
const PammInvestment = require("../../models/PammInvestment");
const PammTransaction = require("../../models/PammTransaction");
const Account = require("../../models/client/Account");
const cacheService = require("../../services/cacheService");
const pammSettlementService = require("../../services/pammSettlementService");

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const invalidatePammCaches = async () => {
  await cacheService.deletePattern("pamm:*");
};

const notify = async (req, transaction) => {
  if (req.notificationTriggers) {
    try {
      await req.notificationTriggers.handlePammInvestmentStatusChange(
        transaction,
        "pending",
      );
    } catch (error) {
      console.error("PAMM notification error:", error.message);
    }
  }

  const io = req.app.get("io");
  if (io?.emitPammInvestmentUpdate) {
    io.emitPammInvestmentUpdate(transaction, "pending");
  }
  if (io?.emitCacheInvalidation && transaction.investor) {
    io.emitCacheInvalidation(transaction.investor._id || transaction.investor, [
      "pamm",
      "pammInvestments",
      "pammRequests",
      "accounts",
      "dashboard",
    ]);
  }
  if (io?.broadcastCacheInvalidation) {
    io.broadcastCacheInvalidation(["admin_pamm"]);
  }
};

// @desc    List client accounts eligible to become a PAMM fund's pool account
// @route   GET /api/admin/pamm/eligible-accounts
exports.getEligibleAccounts = async (req, res, next) => {
  try {
    const { search } = req.query;

    const takenAccountIds = await Pamm.find({ status: { $ne: "closed" } })
      .select("account")
      .lean();

    const query = {
      _id: { $nin: takenAccountIds.map((p) => p.account) },
      status: true,
    };

    let accounts = await Account.find(query)
      .populate("user", "firstName lastName email")
      .select("mt5Account name accountType balance equity user")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    if (search) {
      const term = search.toLowerCase();
      accounts = accounts.filter((acc) => {
        const ownerName = `${acc.user?.firstName || ""} ${acc.user?.lastName || ""}`.toLowerCase();
        return (
          acc.mt5Account?.toLowerCase().includes(term) ||
          ownerName.includes(term) ||
          acc.user?.email?.toLowerCase().includes(term)
        );
      });
    }

    res.status(200).json({ success: true, data: accounts });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a PAMM fund from an existing client account
// @route   POST /api/admin/pamm/funds
exports.createFund = async (req, res, next) => {
  try {
    const {
      accountId,
      name,
      description = "",
      managementFeePercent = 0,
      managementFeeFrequency = "monthly",
      performanceFeePercent = 20,
      minInvestment = 0,
    } = req.body;

    if (!accountId || !name) {
      return res.status(400).json({
        success: false,
        message: "accountId and name are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({ success: false, message: "Invalid accountId" });
    }

    const account = await Account.findById(accountId);
    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const existing = await Pamm.findOne({ account: accountId, status: { $ne: "closed" } });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "This account is already a PAMM fund's pool account",
      });
    }

    const pamm = await Pamm.create({
      manager: account.user,
      account: account._id,
      name,
      description,
      managementFeePercent,
      managementFeeFrequency,
      performanceFeePercent,
      minInvestment,
      status: "active",
      navPerUnit: 100,
      totalUnits: 0,
      aum: 0,
      totalInvestors: 0,
      createdBy: req.user._id,
    });

    // Seed the manager's own capital already sitting in the account as a
    // normal position so it isn't silently diluted or credited by future
    // investor activity (see services/pammSettlementService.js header).
    if (account.balance > 0) {
      const seedUnits = account.balance / pamm.navPerUnit;
      await PammInvestment.create({
        pamm: pamm._id,
        investor: account.user,
        account: account._id,
        units: seedUnits,
        principalInvested: account.balance,
        hwmNav: pamm.navPerUnit,
      });

      pamm.totalUnits = seedUnits;
      pamm.aum = pammSettlementService.round2(pamm.navPerUnit * seedUnits);
      pamm.totalInvestors = 1;
      await pamm.save();
    }

    await invalidatePammCaches();

    const populated = await Pamm.findById(pamm._id)
      .populate("manager", "firstName lastName email")
      .populate("account", "mt5Account balance equity")
      .lean();

    res.status(201).json({ success: true, message: "PAMM fund created", data: populated });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a PAMM fund's terms / status
// @route   PUT /api/admin/pamm/funds/:id
exports.updateFund = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      managementFeePercent,
      managementFeeFrequency,
      performanceFeePercent,
      minInvestment,
      status,
    } = req.body;

    const pamm = await Pamm.findById(id);
    if (!pamm) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    if (pamm.status === "closed") {
      return res.status(400).json({ success: false, message: "Fund is closed" });
    }

    if (name !== undefined) pamm.name = name;
    if (description !== undefined) pamm.description = description;
    if (managementFeePercent !== undefined) pamm.managementFeePercent = managementFeePercent;
    if (managementFeeFrequency !== undefined) pamm.managementFeeFrequency = managementFeeFrequency;
    if (performanceFeePercent !== undefined) pamm.performanceFeePercent = performanceFeePercent;
    if (minInvestment !== undefined) pamm.minInvestment = minInvestment;
    if (status !== undefined && ["active", "inactive"].includes(status)) pamm.status = status;

    await pamm.save();
    await invalidatePammCaches();

    const io = req.app.get("io");
    if (io?.emitPammUpdate) io.emitPammUpdate(pamm.toObject(), "updated");

    res.status(200).json({ success: true, message: "Fund updated", data: pamm });
  } catch (error) {
    next(error);
  }
};

// @desc    Close a PAMM fund (only once every investor, including the manager's own stake, has been redeemed)
// @route   POST /api/admin/pamm/funds/:id/close
exports.closeFund = async (req, res, next) => {
  try {
    const { id } = req.params;
    const pamm = await Pamm.findById(id);
    if (!pamm) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    if (pamm.totalUnits > 1e-6) {
      return res.status(400).json({
        success: false,
        message: "All investors (including the manager's own stake) must be redeemed before closing this fund",
      });
    }

    pamm.status = "closed";
    pamm.closedAt = new Date();
    await pamm.save();
    await invalidatePammCaches();

    const io = req.app.get("io");
    if (io?.emitPammUpdate) io.emitPammUpdate(pamm.toObject(), "closed");

    res.status(200).json({ success: true, message: "Fund closed", data: pamm });
  } catch (error) {
    next(error);
  }
};

// @desc    List PAMM funds
// @route   GET /api/admin/pamm/funds
exports.getFunds = async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (status && status !== "all") query.status = status;

    let fundsQuery = Pamm.find(query)
      .populate("manager", "firstName lastName email")
      .populate("account", "mt5Account balance equity")
      .sort({ createdAt: -1 });

    let funds = await fundsQuery.lean();

    if (search) {
      const term = search.toLowerCase();
      funds = funds.filter((f) => {
        const managerName = `${f.manager?.firstName || ""} ${f.manager?.lastName || ""}`.toLowerCase();
        return (
          f.name?.toLowerCase().includes(term) ||
          managerName.includes(term) ||
          f.account?.mt5Account?.toLowerCase().includes(term)
        );
      });
    }

    const total = funds.length;
    const paged = funds.slice(skip, skip + limitNum);

    res.status(200).json({
      success: true,
      data: paged,
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

// @desc    Get one fund's detail: investors + recent transactions
// @route   GET /api/admin/pamm/funds/:id
exports.getFundById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [pamm, investors, transactions] = await Promise.all([
      Pamm.findById(id)
        .populate("manager", "firstName lastName email")
        .populate("account", "mt5Account balance equity")
        .populate("createdBy", "firstName lastName email")
        .lean(),
      PammInvestment.find({ pamm: id })
        .populate("investor", "firstName lastName email")
        .populate("account", "mt5Account")
        .sort({ createdAt: -1 })
        .lean(),
      PammTransaction.find({ pamm: id })
        .populate("investor", "firstName lastName email")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    if (!pamm) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    res.status(200).json({ success: true, data: { fund: pamm, investors, transactions } });
  } catch (error) {
    next(error);
  }
};

// @desc    Fund quick stats (fee revenue breakdown)
// @route   GET /api/admin/pamm/funds/:id/stats
exports.getFundStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [pamm, feeAgg] = await Promise.all([
      Pamm.findById(id).lean(),
      PammTransaction.aggregate([
        {
          $match: {
            pamm: new mongoose.Types.ObjectId(id),
            type: { $in: ["management_fee", "performance_fee", "settlement"] },
            status: "completed",
          },
        },
        { $group: { _id: "$type", total: { $sum: "$amount" } } },
      ]),
    ]);

    if (!pamm) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    const feesByType = feeAgg.reduce((acc, row) => {
      acc[row._id] = row.total;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        aum: pamm.aum,
        navPerUnit: pamm.navPerUnit,
        totalUnits: pamm.totalUnits,
        totalInvestors: pamm.totalInvestors,
        lastSettlementAt: pamm.lastSettlementAt,
        feesByType,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Shared list for both investment and redemption requests.
const listRequests = async (req, res, next, type) => {
  try {
    const { status = "pending", page = 1, limit = 20, pammId } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const query = { type };
    if (status && status !== "all") query.status = status;
    if (pammId) query.pamm = pammId;

    const [requests, total] = await Promise.all([
      PammTransaction.find(query)
        .populate("investor", "firstName lastName email")
        .populate("account", "mt5Account")
        .populate("pamm", "name navPerUnit")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      PammTransaction.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: requests,
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

exports.getInvestmentRequests = (req, res, next) => listRequests(req, res, next, "investment");
exports.getRedemptionRequests = (req, res, next) => listRequests(req, res, next, "redemption");

// @desc    Approve a pending investment request
// @route   PUT /api/admin/pamm/investments/:id/approve
exports.approveInvestment = async (req, res, next) => {
  try {
    const { tx, rejected } = await pammSettlementService.executeInvestment(
      req.params.id,
      req.user._id,
    );

    const populated = await PammTransaction.findById(tx._id)
      .populate("investor", "firstName lastName email")
      .lean();

    await invalidatePammCaches();
    await notify(req, populated);

    if (rejected) {
      return res.status(400).json({
        success: false,
        message: populated.remarks || "Investment could not be processed",
        data: populated,
      });
    }

    res.status(200).json({ success: true, message: "Investment approved", data: populated });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject a pending investment request
// @route   PUT /api/admin/pamm/investments/:id/reject
exports.rejectInvestment = async (req, res, next) => {
  try {
    const { remarks = "Rejected by admin" } = req.body;
    const tx = await PammTransaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: "Request not found" });
    if (tx.status !== "pending") {
      return res.status(400).json({ success: false, message: "Request already processed" });
    }

    tx.status = "rejected";
    tx.remarks = remarks;
    tx.processedBy = req.user._id;
    tx.processedAt = new Date();
    await tx.save();

    const populated = await PammTransaction.findById(tx._id)
      .populate("investor", "firstName lastName email")
      .lean();

    await invalidatePammCaches();
    await notify(req, populated);

    res.status(200).json({ success: true, message: "Request rejected", data: populated });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve a pending redemption request
// @route   PUT /api/admin/pamm/investments/:id/approve  (redemptions use the same tx id space)
exports.approveRedemption = async (req, res, next) => {
  try {
    const { tx, rejected } = await pammSettlementService.executeRedemption(
      req.params.id,
      req.user._id,
    );

    const populated = await PammTransaction.findById(tx._id)
      .populate("investor", "firstName lastName email")
      .lean();

    await invalidatePammCaches();
    await notify(req, populated);

    if (rejected) {
      return res.status(400).json({
        success: false,
        message: populated.remarks || "Redemption could not be processed",
        data: populated,
      });
    }

    res.status(200).json({ success: true, message: "Redemption approved", data: populated });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject a pending redemption request
// @route   PUT /api/admin/pamm/redemptions/:id/reject
exports.rejectRedemption = exports.rejectInvestment;

// @desc    Manually trigger NAV/fee settlement for a fund
// @route   POST /api/admin/pamm/funds/:id/settle
exports.triggerSettlement = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    const result = await pammSettlementService.settleFund(req.params.id, {
      manual: true,
      io,
      notificationTriggers: req.notificationTriggers,
    });

    await invalidatePammCaches();

    res.status(200).json({ success: true, message: "Settlement run complete", data: result });
  } catch (error) {
    next(error);
  }
};

// @desc    Dashboard-level PAMM stats for the admin overview cards
// @route   GET /api/admin/pamm/stats
exports.getDashboardStats = async (req, res, next) => {
  try {
    const [fundAgg, pendingInvestments, pendingRedemptions] = await Promise.all([
      Pamm.aggregate([
        {
          $group: {
            _id: null,
            totalFunds: { $sum: 1 },
            activeFunds: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
            totalAum: { $sum: "$aum" },
            totalInvestors: { $sum: "$totalInvestors" },
          },
        },
      ]),
      PammTransaction.countDocuments({ type: "investment", status: "pending" }),
      PammTransaction.countDocuments({ type: "redemption", status: "pending" }),
    ]);

    const stats = fundAgg[0] || {
      totalFunds: 0,
      activeFunds: 0,
      totalAum: 0,
      totalInvestors: 0,
    };

    res.status(200).json({
      success: true,
      data: {
        ...stats,
        pendingInvestments,
        pendingRedemptions,
      },
    });
  } catch (error) {
    next(error);
  }
};

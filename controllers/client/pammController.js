// Backend/controllers/client/pammController.js
const mongoose = require("mongoose");
const Pamm = require("../../models/Pamm");
const PammInvestment = require("../../models/PammInvestment");
const PammTransaction = require("../../models/PammTransaction");
const Account = require("../../models/client/Account");
const cacheService = require("../../services/cacheService");

const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const invalidatePammCaches = async () => {
  await cacheService.deletePattern("pamm:*");
};

const notifyNewRequest = async (req, transaction) => {
  if (req.notificationTriggers) {
    try {
      await req.notificationTriggers.handlePammInvestmentStatusChange(
        transaction,
        "new",
      );
    } catch (error) {
      console.error("PAMM notification error:", error.message);
    }
  }

  const io = req.app.get("io");
  if (io?.emitPammInvestmentUpdate) {
    io.emitPammInvestmentUpdate(transaction, "new");
  }
  if (io?.broadcastCacheInvalidation) {
    io.broadcastCacheInvalidation(["admin_pamm"]);
  }
};

// @desc    Browse funds open for investment
// @route   GET /api/pamm/funds
exports.getActiveFunds = async (req, res, next) => {
  try {
    const funds = await Pamm.find({ status: "active" })
      .populate("manager", "firstName lastName")
      .populate("account", "mt5Account")
      .sort({ aum: -1 })
      .lean();

    const data = funds.map((f) => ({
      ...f,
      sinceInceptionReturnPercent: round2(((f.navPerUnit - 100) / 100) * 100),
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Fund detail + NAV history (derived from transaction ledger)
// @route   GET /api/pamm/funds/:id
exports.getFundDetail = async (req, res, next) => {
  try {
    const { id } = req.params;

    const fund = await Pamm.findOne({ _id: id, status: { $ne: "closed" } })
      .populate("manager", "firstName lastName")
      .populate("account", "mt5Account")
      .lean();

    if (!fund) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    const navHistory = await PammTransaction.find({
      pamm: id,
      navAtTransaction: { $ne: null },
      status: "completed",
    })
      .select("navAtTransaction createdAt type")
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({
      success: true,
      data: {
        ...fund,
        sinceInceptionReturnPercent: round2(((fund.navPerUnit - 100) / 100) * 100),
        navHistory,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Submit an investment request into a fund
// @route   POST /api/pamm/invest
exports.investInFund = async (req, res, next) => {
  try {
    const { fundId, accountId, amount } = req.body;

    if (!fundId || !accountId || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "fundId, accountId and a positive amount are required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(fundId) ||
      !mongoose.Types.ObjectId.isValid(accountId)
    ) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const [fund, account] = await Promise.all([
      Pamm.findById(fundId),
      Account.findOne({ _id: accountId, user: req.user._id }),
    ]);

    if (!fund || fund.status !== "active") {
      return res.status(404).json({ success: false, message: "Fund not found or not open for investment" });
    }
    if (!account) {
      return res.status(404).json({ success: false, message: "Account not found or not yours" });
    }
    if (String(account._id) === String(fund.account)) {
      return res.status(400).json({
        success: false,
        message: "Cannot invest a fund's own pooled account into itself",
      });
    }
    if (amount < fund.minInvestment) {
      return res.status(400).json({
        success: false,
        message: `Minimum investment for this fund is $${fund.minInvestment}`,
      });
    }
    if (account.balance < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: $${account.balance.toFixed(2)}`,
      });
    }

    // Can't fund an investment from an account that is itself a pool for
    // another PAMM fund — keeps the money graph easy to reason about.
    const isPoolAccount = await Pamm.exists({ account: accountId, status: { $ne: "closed" } });
    if (isPoolAccount) {
      return res.status(400).json({
        success: false,
        message: "This account is itself a PAMM fund's pooled account and cannot be used to invest",
      });
    }

    const tx = await PammTransaction.create({
      pamm: fundId,
      investor: req.user._id,
      account: accountId,
      type: "investment",
      status: "pending",
      amount,
    });

    const populated = await PammTransaction.findById(tx._id)
      .populate("investor", "firstName lastName email")
      .populate("pamm", "name")
      .lean();

    await invalidatePammCaches();
    await notifyNewRequest(req, populated);

    res.status(201).json({
      success: true,
      message: "Investment request submitted and is pending admin approval",
      data: populated,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List the caller's own active positions
// @route   GET /api/pamm/my-investments
exports.getMyInvestments = async (req, res, next) => {
  try {
    const investments = await PammInvestment.find({
      investor: req.user._id,
      status: "active",
    })
      .populate("pamm", "name status navPerUnit managementFeePercent performanceFeePercent")
      .populate("account", "mt5Account")
      .sort({ createdAt: -1 })
      .lean();

    const data = investments.map((inv) => {
      const nav = inv.pamm?.navPerUnit || 0;
      const currentValue = round2(inv.units * nav);
      const roiPercent =
        inv.principalInvested > 0
          ? round2(((currentValue - inv.principalInvested) / inv.principalInvested) * 100)
          : 0;
      return { ...inv, currentValue, roiPercent };
    });

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Statement for one position
// @route   GET /api/pamm/my-investments/:id/transactions
exports.getInvestmentTransactions = async (req, res, next) => {
  try {
    const investment = await PammInvestment.findOne({
      _id: req.params.id,
      investor: req.user._id,
    }).lean();

    if (!investment) {
      return res.status(404).json({ success: false, message: "Position not found" });
    }

    const transactions = await PammTransaction.find({
      $or: [{ investment: investment._id }, { pamm: investment.pamm, investor: req.user._id }],
    })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: transactions });
  } catch (error) {
    next(error);
  }
};

// @desc    Submit a redemption request against a position
// @route   POST /api/pamm/redeem
exports.requestRedemption = async (req, res, next) => {
  try {
    const { investmentId, units, amount, all } = req.body;

    if (!investmentId || !mongoose.Types.ObjectId.isValid(investmentId)) {
      return res.status(400).json({ success: false, message: "Invalid investmentId" });
    }

    const investment = await PammInvestment.findOne({
      _id: investmentId,
      investor: req.user._id,
      status: "active",
    });

    if (!investment) {
      return res.status(404).json({ success: false, message: "Position not found" });
    }

    const fund = await Pamm.findById(investment.pamm);
    if (!fund) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    const navPerUnit = fund.navPerUnit > 0 ? fund.navPerUnit : 100;
    let requestedUnits;

    if (all) {
      requestedUnits = investment.units;
    } else if (units) {
      requestedUnits = Number(units);
    } else if (amount) {
      requestedUnits = Number(amount) / navPerUnit;
    } else {
      return res.status(400).json({
        success: false,
        message: "Provide units, amount, or all:true",
      });
    }

    if (!requestedUnits || requestedUnits <= 0 || requestedUnits > investment.units + 1e-9) {
      return res.status(400).json({
        success: false,
        message: "Requested amount exceeds your current holding in this fund",
      });
    }

    const estimatedAmount = round2(requestedUnits * navPerUnit);

    const tx = await PammTransaction.create({
      pamm: fund._id,
      investment: investment._id,
      investor: req.user._id,
      account: investment.account,
      type: "redemption",
      status: "pending",
      amount: estimatedAmount,
      units: requestedUnits,
      navAtTransaction: navPerUnit,
      remarks: "Amount is estimated at request time; final payout uses the NAV at approval.",
    });

    const populated = await PammTransaction.findById(tx._id)
      .populate("investor", "firstName lastName email")
      .populate("pamm", "name")
      .lean();

    await invalidatePammCaches();
    await notifyNewRequest(req, populated);

    res.status(201).json({
      success: true,
      message: "Redemption request submitted and is pending admin approval",
      data: populated,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List the caller's own investment/redemption requests
// @route   GET /api/pamm/my-requests
exports.getMyRequests = async (req, res, next) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const query = { investor: req.user._id };
    if (status && status !== "all") query.status = status;
    if (type && type !== "all") query.type = type;
    else query.type = { $in: ["investment", "redemption"] };

    const [requests, total] = await Promise.all([
      PammTransaction.find(query)
        .populate("pamm", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      PammTransaction.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: requests,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Funds where the caller is the designated manager: investors + fee earnings
// @route   GET /api/pamm/my-funds
exports.getMyManagedFunds = async (req, res, next) => {
  try {
    const funds = await Pamm.find({ manager: req.user._id })
      .populate("account", "mt5Account balance equity")
      .sort({ createdAt: -1 })
      .lean();

    if (funds.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const fundIds = funds.map((f) => f._id);

    const [investorCounts, feeAgg] = await Promise.all([
      PammInvestment.aggregate([
        { $match: { pamm: { $in: fundIds }, status: "active" } },
        { $group: { _id: "$pamm", count: { $sum: 1 } } },
      ]),
      PammTransaction.aggregate([
        {
          $match: {
            pamm: { $in: fundIds },
            type: "settlement",
            status: "completed",
          },
        },
        { $group: { _id: "$pamm", totalFees: { $sum: "$amount" } } },
      ]),
    ]);

    const investorCountByFund = investorCounts.reduce((acc, row) => {
      acc[row._id.toString()] = row.count;
      return acc;
    }, {});
    const feesByFund = feeAgg.reduce((acc, row) => {
      acc[row._id.toString()] = row.totalFees;
      return acc;
    }, {});

    const data = funds.map((f) => ({
      ...f,
      activeInvestorCount: investorCountByFund[f._id.toString()] || 0,
      totalFeesEarned: feesByFund[f._id.toString()] || 0,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Investors in one of the caller's own managed funds (read-only)
// @route   GET /api/pamm/my-funds/:id/investors
exports.getMyFundInvestors = async (req, res, next) => {
  try {
    const fund = await Pamm.findOne({ _id: req.params.id, manager: req.user._id }).lean();
    if (!fund) {
      return res.status(404).json({ success: false, message: "Fund not found" });
    }

    const investors = await PammInvestment.find({ pamm: fund._id, status: "active" })
      .populate("investor", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: investors });
  } catch (error) {
    next(error);
  }
};

// Backend/controllers/admin/clientController.js - FULLY OPTIMIZED
const User = require("../../models/User");
const metaApi = require("../../API/metaApi");
const Profile = require("../../models/client/Profile");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const Account = require("../../models/client/Account");
const IBClientConfiguration = require("../../models/client/IBClientConfiguration");
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const DeviceSession = require("../../models/DeviceSession");
const Ticket = require("../../models/Ticket");
const IBClosedTrade = require("../../models/IBClosedTrade");
const cacheService = require("../../services/cacheService");
require("dotenv").config();
const mongoose = require("mongoose");

// Cache keys
const CACHE_KEYS = {
  ALL_CLIENTS: (filters) => `admin:clients:all:${JSON.stringify(filters)}`,
  CLIENT_DETAILS: (id) => `admin:clients:details:${id}`,
  USER_ACCOUNTS: (userId, refresh) =>
    `admin:users:accounts:${userId}:${refresh}`,
  CLIENT_RISK_SCORE: (id) => `admin:clients:risk-score:${id}`,
  CLIENT_TIME_MACHINE: (id, at, accountId) =>
    `admin:clients:time-machine:${id}:${at}:${accountId || "all"}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  ALL_CLIENTS: 60, // 1 minute
  CLIENT_DETAILS: 300, // 5 minutes
  USER_ACCOUNTS: 30, // 30 seconds
  CLIENT_RISK_SCORE: 120, // 2 minutes - deliberately per-client, not bulk-precomputed (see comment on the handler)
  CLIENT_TIME_MACHINE: 60, // 1 minute - short, so scrubbing the timeline back and forth stays cheap
};

// @desc    Get all clients
// @route   GET /api/clients
// @access  Private (admin, superadmin)
exports.getAllClients = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit,
      search = "",
      status = "",
      kycStatus = "",
      hasDocuments = "",
    } = req.query;
    const requireDocuments = hasDocuments === "true";

    const pageNum = parseInt(page);
    // The KYC verification queue (hasDocuments=true) must never be silently
    // truncated by the default page size - it isn't paginated server-side,
    // the admin screen fetches the full matching set in one call. Callers
    // that do want normal pagination can still pass an explicit `limit`.
    const limitNum = limit
      ? parseInt(limit)
      : requireDocuments
        ? 100000
        : 20;
    const skip = (pageNum - 1) * limitNum;

    // Generate cache key based on all filters
    const cacheKey = cacheService.generateKey(CACHE_KEYS.ALL_CLIENTS({}), {
      page: pageNum,
      limit: limitNum,
      search,
      status,
      kycStatus,
      hasDocuments: requireDocuments,
    });

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        total: cached.total,
        page: cached.page,
        pages: cached.pages,
        data: cached.data,
        fromCache: true,
      });
    }

    // Build match conditions
    const matchConditions = { role: "client" };
    if (status) matchConditions.status = status;

    // Build search condition with regex (only if search provided)
    let searchCondition = {};
    if (search) {
      const searchRegex = new RegExp(search, "i");
      searchCondition = {
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
        ],
      };
    }

    // OPTIMIZED: Single aggregation pipeline with better performance
    const pipeline = [
      { $match: { ...matchConditions, ...searchCondition } },

      // Project early to reduce data size
      {
        $project: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          email: 1,
          country: 1,
          phone: 1,
          dateofbirth: 1,
          isEmailVerified: 1,
          createdAt: 1,
          status: 1,
        },
      },

      // Lookup profile with limited fields
      {
        $lookup: {
          from: "profiles",
          localField: "_id",
          foreignField: "user",
          as: "profile",
          pipeline: [
            {
              $project: {
                kycVerified: 1,
                kycStatus: 1,
                kycRejectReason: 1,
                educationLevel: 1,
                otherEducation: 1,
                idDocument: 1,
                address1Document: 1,
                address2Document: 1,
                bankDetails: 1,
                walletDetails: 1,
              },
            },
          ],
        },
      },
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },

      // Lookup IB config
      {
        $lookup: {
          from: "ibclientconfigurations",
          localField: "_id",
          foreignField: "userId",
          as: "ibConfig",
          pipeline: [
            {
              $project: {
                referralCode: 1,
                status: 1,
              },
            },
          ],
        },
      },
      { $unwind: { path: "$ibConfig", preserveNullAndEmptyArrays: true } },

      // Apply KYC filter after lookup (only if needed)
      ...(kycStatus ? [{ $match: { "profile.kycStatus": kycStatus } }] : []),

      // Only clients who have actually uploaded at least one KYC document
      // (used by the admin KYC verification queue, which should never be
      // silently truncated by the createdAt-based pagination below)
      ...(requireDocuments
        ? [
            {
              $match: {
                $or: [
                  { "profile.idDocument": { $exists: true, $nin: [null, ""] } },
                  {
                    "profile.address1Document": {
                      $exists: true,
                      $nin: [null, ""],
                    },
                  },
                  {
                    "profile.address2Document": {
                      $exists: true,
                      $nin: [null, ""],
                    },
                  },
                ],
              },
            },
          ]
        : []),

      // Final projection
      {
        $project: {
          id: "$_id",
          name: { $concat: ["$firstName", " ", "$lastName"] },
          email: 1,
          firstName: 1,
          lastName: 1,
          country: 1,
          phone: 1,
          dateofbirth: 1,
          isEmailVerified: 1,
          createdAt: 1,
          status: 1,
          kycVerified: { $ifNull: ["$profile.kycVerified", false] },
          kycStatus: { $ifNull: ["$profile.kycStatus", "unverified"] },
          kycRejectReason: "$profile.kycRejectReason",
          ibPartner: {
            $switch: {
              branches: [
                {
                  case: {
                    $and: [
                      { $ne: ["$ibConfig.referralCode", null] },
                      { $eq: ["$ibConfig.status", "active"] },
                    ],
                  },
                  then: "active",
                },
                {
                  case: { $ne: ["$ibConfig.referralCode", null] },
                  then: "inactive",
                },
              ],
              default: "None",
            },
          },
          accountNumber: {
            $ifNull: ["$profile.walletDetails.accountNumber", ""],
          },
          educationLevel: { $ifNull: ["$profile.educationLevel", ""] },
          otherEducation: { $ifNull: ["$profile.otherEducation", ""] },
          idDocument: { $ifNull: ["$profile.idDocument", ""] },
          address1Document: { $ifNull: ["$profile.address1Document", ""] },
          address2Document: { $ifNull: ["$profile.address2Document", ""] },
          bankDetails: { $ifNull: ["$profile.bankDetails", {}] },
          walletDetails: { $ifNull: ["$profile.walletDetails", {}] },
        },
      },

      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNum },
    ];

    // Optimized count pipeline - no need for full lookups
    let countPipeline = [
      { $match: { ...matchConditions, ...searchCondition } },
    ];

    if (kycStatus || requireDocuments) {
      countPipeline = [
        { $match: { ...matchConditions, ...searchCondition } },
        {
          $lookup: {
            from: "profiles",
            localField: "_id",
            foreignField: "user",
            as: "profile",
          },
        },
        {
          $unwind: {
            path: "$profile",
            preserveNullAndEmptyArrays: !kycStatus,
          },
        },
        ...(kycStatus ? [{ $match: { "profile.kycStatus": kycStatus } }] : []),
        ...(requireDocuments
          ? [
              {
                $match: {
                  $or: [
                    {
                      "profile.idDocument": { $exists: true, $nin: [null, ""] },
                    },
                    {
                      "profile.address1Document": {
                        $exists: true,
                        $nin: [null, ""],
                      },
                    },
                    {
                      "profile.address2Document": {
                        $exists: true,
                        $nin: [null, ""],
                      },
                    },
                  ],
                },
              },
            ]
          : []),
        { $count: "total" },
      ];
    } else {
      countPipeline.push({ $count: "total" });
    }

    // Run in parallel
    const [clients, countResult] = await Promise.all([
      User.aggregate(pipeline),
      User.aggregate(countPipeline),
    ]);

    const total = countResult[0]?.total || 0;
    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      count: clients.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: clients,
    };

    // Cache the response
    await cacheService.set(cacheKey, response, CACHE_TTL.ALL_CLIENTS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Get client details
// @route   GET /api/clients/:id
// @access  Private (admin, superadmin)
exports.getClientDetails = async (req, res, next) => {
  try {
    console.log("Fetching client details for ID:", req.params.id);
    const { id } = req.params;
    const cacheKey = CACHE_KEYS.CLIENT_DETAILS(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    // OPTIMIZED: Single aggregation pipeline for all data
    const [clientData] = await User.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id), role: "client" } },
      {
        $project: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          email: 1,
          country: 1,
          phone: 1,
          dateofbirth: 1,
          isEmailVerified: 1,
          status: 1,
          createdAt: 1,
        },
      },
      {
        $lookup: {
          from: "profiles",
          localField: "_id",
          foreignField: "user",
          as: "profile",
        },
      },
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "ibclientconfigurations",
          localField: "_id",
          foreignField: "userId",
          as: "ibConfig",
        },
      },
      { $unwind: { path: "$ibConfig", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          id: "$_id",
          firstname: "$firstName",
          lastname: "$lastName",
          email: 1,
          country: 1,
          phone: 1,
          dateofbirth: 1,
          isEmailVerified: 1,
          status: { $ifNull: ["$status", "activated"] },
          kycVerified: { $ifNull: ["$profile.kycVerified", false] },
          kycStatus: { $ifNull: ["$profile.kycStatus", "unverified"] },
          kycRejectReason: "$profile.kycRejectReason",
          ibPartner: {
            $switch: {
              branches: [
                {
                  case: { $ne: ["$ibConfig.referralCode", null] },
                  then: "active",
                },
                { case: "$ibConfig", then: "inactive" },
              ],
              default: "None",
            },
          },
          educationLevel: { $ifNull: ["$profile.educationLevel", ""] },
          otherEducation: { $ifNull: ["$profile.otherEducation", ""] },
          idDocument: { $ifNull: ["$profile.idDocument", ""] },
          address1Document: { $ifNull: ["$profile.address1Document", ""] },
          address2Document: { $ifNull: ["$profile.address2Document", ""] },
          bankDetails: { $ifNull: ["$profile.bankDetails", {}] },
          walletDetails: { $ifNull: ["$profile.walletDetails", {}] },
        },
      },
    ]);

    if (!clientData) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    // Cache the result
    await cacheService.set(cacheKey, clientData, CACHE_TTL.CLIENT_DETAILS);

    res.status(200).json({
      success: true,
      data: clientData,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Compute a compliance/fraud risk score (0-100, higher = riskier)
//          for a single client from signals already tracked elsewhere in
//          the CRM: KYC outcome, deposit/withdrawal behavior (rejected
//          attempts, rapid cash-out-after-deposit pattern), device
//          security flags, and support ticket volume. Each contributing
//          factor is returned with its own point value so the score is
//          fully explainable in the UI, not a black box.
// @route   GET /api/clients/:id/risk-score
// @access  Private (admin, superadmin)
//
// Deliberately per-client, computed on demand (not bulk-precomputed for
// the whole client list) - this queries deposits/withdrawals/device
// sessions/tickets for one user, which is fine on demand but would be an
// expensive N-query fan-out if run for every row of a paginated list of
// thousands of clients. A bulk/sortable version would need its own
// aggregation pipeline design, which is future scope, not this pass.
exports.getClientRiskScore = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid client id",
      });
    }

    const cacheKey = CACHE_KEYS.CLIENT_RISK_SCORE(id);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, fromCache: true });
    }

    const userId = new mongoose.Types.ObjectId(id);

    const [profile, deposits, withdrawals, deviceSessions, ticketCount] =
      await Promise.all([
        Profile.findOne({ user: userId }).select("kycStatus").lean(),
        Deposit.find({ user: userId })
          .select("status createdAt approvedDate")
          .sort({ createdAt: -1 })
          .limit(200)
          .lean(),
        Withdrawal.find({ user: userId })
          .select("status createdAt approvedDate")
          .sort({ createdAt: -1 })
          .limit(200)
          .lean(),
        DeviceSession.find({ user: userId })
          .select("deviceId isBlocked")
          .lean(),
        Ticket.countDocuments({ createdBy: userId }),
      ]);

    const factors = [];
    let score = 0;

    // 1) KYC outcome
    const kycStatus = profile?.kycStatus || "unverified";
    if (kycStatus === "rejected") {
      score += 35;
      factors.push({ label: "KYC was rejected", points: 35, severity: "critical" });
    } else if (kycStatus === "unverified") {
      score += 15;
      factors.push({ label: "KYC not yet verified", points: 15, severity: "warning" });
    }

    // 2) Rejected withdrawal attempts - repeated rejections can indicate
    // the client is probing for a payout method that won't get caught.
    const rejectedWithdrawals = withdrawals.filter((w) => w.status === "Rejected").length;
    if (rejectedWithdrawals > 0) {
      const points = Math.min(rejectedWithdrawals * 5, 20);
      score += points;
      factors.push({
        label: `${rejectedWithdrawals} rejected withdrawal attempt${rejectedWithdrawals === 1 ? "" : "s"}`,
        points,
        severity: "warning",
      });
    }

    // 3) Rapid cash-out: an approved withdrawal filed within 48h of an
    // approved deposit - a classic bonus-abuse / fraud pattern.
    const approvedDeposits = deposits.filter((d) => d.status === "Approved" && d.approvedDate);
    const approvedWithdrawals = withdrawals.filter((w) => w.status === "Approved" && w.createdAt);
    let rapidCashOuts = 0;
    for (const w of approvedWithdrawals) {
      const withdrawTime = new Date(w.createdAt).getTime();
      const hadRecentDeposit = approvedDeposits.some((d) => {
        const depositTime = new Date(d.approvedDate).getTime();
        const diffHours = (withdrawTime - depositTime) / 3_600_000;
        return diffHours >= 0 && diffHours <= 48;
      });
      if (hadRecentDeposit) rapidCashOuts += 1;
    }
    if (rapidCashOuts > 0) {
      score += 20;
      factors.push({
        label: `${rapidCashOuts} withdrawal${rapidCashOuts === 1 ? "" : "s"} filed within 48h of a deposit`,
        points: 20,
        severity: "warning",
      });
    }

    // 4) Device security flags - reuses the same isBlocked flag the Device
    // Sessions panel already lets admins set per-session.
    const blockedDevices = deviceSessions.filter((d) => d.isBlocked).length;
    if (blockedDevices > 0) {
      score += 20;
      factors.push({
        label: `${blockedDevices} blocked device session${blockedDevices === 1 ? "" : "s"}`,
        points: 20,
        severity: "critical",
      });
    }
    const distinctDevices = new Set(deviceSessions.map((d) => d.deviceId)).size;
    if (distinctDevices > 3) {
      score += 10;
      factors.push({
        label: `${distinctDevices} distinct devices used`,
        points: 10,
        severity: "info",
      });
    }

    // 5) Support ticket volume
    if (ticketCount >= 5) {
      score += 10;
      factors.push({
        label: `${ticketCount} support tickets raised`,
        points: 10,
        severity: "info",
      });
    }

    const finalScore = Math.min(Math.round(score), 100);
    const level = finalScore >= 60 ? "high" : finalScore >= 30 ? "medium" : "low";

    const data = {
      clientId: id,
      score: finalScore,
      level,
      factors,
      computedAt: new Date().toISOString(),
    };

    await cacheService.set(cacheKey, data, CACHE_TTL.CLIENT_RISK_SCORE);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @desc    "Time Machine" - reconstructs what a client's account(s) looked
//          like as of a past moment, purely from immutable historical
//          records: approved deposits/withdrawals and closed trades. There
//          is no stored history of Account.balance itself (it's a live
//          mirror of the MT5 account), so instead of snapshotting we derive
//          the balance-as-of-`at` from the ledger: every approved deposit
//          adds, every approved withdrawal subtracts, every trade that had
//          closed by `at` contributes its net P&L (profit + swap -
//          commission). This is additive from zero, not a walk backward
//          from the live balance, so it deliberately excludes anything not
//          reflected in those three collections (manual balance
//          adjustments, bonuses applied outside the deposit flow, etc.) -
//          callers get that caveat back in the response rather than a
//          number presented as exact.
//
//          Open positions "as of `at`" can only be reconstructed for trades
//          that have since closed (openTime <= at < closeTime, read from
//          IBClosedTrades) - a trade still open right now has no historical
//          snapshot of its state at an earlier moment, so it can't appear
//          in a past reconstruction. That scope is surfaced explicitly
//          rather than silently under-counting.
// @route   GET /api/clients/:id/time-machine?at=<ISO datetime>&accountId=<id>
// @access  Private (admin, superadmin)
exports.getClientTimeMachine = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { accountId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid client id",
      });
    }
    if (accountId && !mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account id",
      });
    }

    const at = req.query.at ? new Date(req.query.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid `at` date/time",
      });
    }

    const cacheKey = CACHE_KEYS.CLIENT_TIME_MACHINE(id, at.toISOString(), accountId);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, fromCache: true });
    }

    const userId = new mongoose.Types.ObjectId(id);

    const accountFilter = { user: userId };
    if (accountId) accountFilter._id = new mongoose.Types.ObjectId(accountId);

    const accounts = await Account.find(accountFilter)
      .select("mt5Account name accountType leverage balance equity createdAt")
      .lean();

    if (accounts.length === 0) {
      return res.status(404).json({
        success: false,
        message: accountId
          ? "Account not found for this client"
          : "This client has no trading accounts",
      });
    }

    const mt5Accounts = accounts.map((a) => a.mt5Account);
    const accountIds = accounts.map((a) => a._id);

    // Every deposit/withdrawal request that existed by `at` - not just the
    // approved ones - so the UI can show the full itemized picture (what
    // was requested, what its outcome was) rather than only a total.
    // Status "as of `at`" is derived below rather than trusted from the
    // document's current status: a request resolved after `at` was still
    // pending at that moment, and only its requestedDate is safe to gate on.
    const [depositsRequestedByAt, withdrawalsRequestedByAt, closedTradesToDate, openAsOfTrades] =
      await Promise.all([
        Deposit.find({
          account: { $in: accountIds },
          requestedDate: { $lte: at },
        })
          .select(
            "account amount status paymentType requestedDate approvedDate rejectedDate bonus remarks paymentMethod",
          )
          .populate("paymentMethod", "type bankName walletName")
          .sort({ requestedDate: -1 })
          .lean(),
        Withdrawal.find({
          account: { $in: accountIds },
          requestedDate: { $lte: at },
        })
          .select(
            "account amount status paymentMethod requestedDate approvedDate rejectedDate remarks bankDetails eWalletDetails",
          )
          .sort({ requestedDate: -1 })
          .lean(),
        IBClosedTrade.find({
          mt5Account: { $in: mt5Accounts },
          closeTime: { $lte: at },
        })
          .select("mt5Account symbol profit swap commission closeTime")
          .lean(),
        IBClosedTrade.find({
          mt5Account: { $in: mt5Accounts },
          openTime: { $lte: at },
          closeTime: { $gt: at },
        })
          .select("mt5Account symbol volume openTime openPrice tradeType")
          .sort({ openTime: -1 })
          .limit(100)
          .lean(),
      ]);

    // statusAsOf: what the request's status actually was at `at`, derived
    // from whichever resolution date (approved/rejected) had happened by
    // then - not the document's current status, which may reflect a later
    // resolution the reconstruction shouldn't credit yet.
    const statusAsOf = (doc) => {
      if (doc.status === "Approved" && doc.approvedDate && doc.approvedDate <= at) {
        return "Approved";
      }
      if (doc.status === "Rejected" && doc.rejectedDate && doc.rejectedDate <= at) {
        return "Rejected";
      }
      return "Pending";
    };

    // Attach statusAsOf to every raw record up front so both the itemized
    // lists and the Approved-only totals below read the same value.
    for (const d of depositsRequestedByAt) d.statusAsOf = statusAsOf(d);
    for (const w of withdrawalsRequestedByAt) w.statusAsOf = statusAsOf(w);

    const depositsToDate = depositsRequestedByAt.filter((d) => d.statusAsOf === "Approved");
    const withdrawalsToDate = withdrawalsRequestedByAt.filter(
      (w) => w.statusAsOf === "Approved",
    );

    const byAccount = new Map(
      accounts.map((a) => [
        a._id.toString(),
        {
          accountId: a._id,
          mt5Account: a.mt5Account,
          name: a.name,
          accountType: a.accountType,
          currentBalance: a.balance,
          currentEquity: a.equity,
          depositsTotal: 0,
          withdrawalsTotal: 0,
          closedPnlTotal: 0,
          reconstructedBalance: 0,
          openPositionsAsOf: [],
          deposits: [],
          withdrawals: [],
        },
      ]),
    );
    const byMt5Account = new Map(accounts.map((a) => [a.mt5Account, a._id.toString()]));

    for (const d of depositsToDate) {
      const bucket = byAccount.get(d.account.toString());
      if (bucket) bucket.depositsTotal += Number(d.amount) || 0;
    }
    for (const w of withdrawalsToDate) {
      const bucket = byAccount.get(w.account.toString());
      if (bucket) bucket.withdrawalsTotal += Number(w.amount) || 0;
    }
    // Full itemized list (every status, not just Approved) - what the
    // client detail view actually needs to show "every deposit/withdrawal"
    // as it stood on that date.
    for (const d of depositsRequestedByAt) {
      const bucket = byAccount.get(d.account.toString());
      if (!bucket) continue;
      bucket.deposits.push({
        id: d._id,
        amount: Number(d.amount) || 0,
        status: d.statusAsOf,
        paymentType: d.paymentType || null,
        paymentMethod: d.paymentMethod
          ? {
              type: d.paymentMethod.type || null,
              bankName: d.paymentMethod.bankName || null,
              walletName: d.paymentMethod.walletName || null,
            }
          : null,
        bonus: Number(d.bonus) || 0,
        requestedDate: d.requestedDate,
        approvedDate: d.statusAsOf === "Approved" ? d.approvedDate : null,
        remarks: d.remarks || "",
      });
    }
    for (const w of withdrawalsRequestedByAt) {
      const bucket = byAccount.get(w.account.toString());
      if (!bucket) continue;
      bucket.withdrawals.push({
        id: w._id,
        amount: Number(w.amount) || 0,
        status: w.statusAsOf,
        paymentMethod: w.paymentMethod || null,
        bankDetails: w.bankDetails || null,
        eWalletDetails: w.eWalletDetails || null,
        requestedDate: w.requestedDate,
        approvedDate: w.statusAsOf === "Approved" ? w.approvedDate : null,
        remarks: w.remarks || "",
      });
    }
    for (const t of closedTradesToDate) {
      const accId = byMt5Account.get(t.mt5Account);
      const bucket = accId && byAccount.get(accId);
      if (bucket) {
        bucket.closedPnlTotal +=
          (Number(t.profit) || 0) + (Number(t.swap) || 0) - (Number(t.commission) || 0);
      }
    }
    for (const t of openAsOfTrades) {
      const accId = byMt5Account.get(t.mt5Account);
      const bucket = accId && byAccount.get(accId);
      if (bucket) {
        bucket.openPositionsAsOf.push({
          symbol: t.symbol,
          direction: (t.tradeType || "").toLowerCase() === "buy" ? "buy" : "sell",
          volume: t.volume,
          openTime: t.openTime,
          openPrice: t.openPrice,
        });
      }
    }

    // Recent activity leading up to `at`, most-recent-first - gives the UI
    // a timeline to render alongside the reconstructed numbers. Includes
    // every deposit/withdrawal request seen by `at`, whatever its
    // statusAsOf, not just the ones that ended up Approved.
    const timeline = [
      ...depositsRequestedByAt.map((d) => ({
        type: "deposit",
        amount: Number(d.amount) || 0,
        status: d.statusAsOf,
        at: d.statusAsOf === "Approved" ? d.approvedDate : d.requestedDate,
        accountId: d.account,
      })),
      ...withdrawalsRequestedByAt.map((w) => ({
        type: "withdrawal",
        amount: Number(w.amount) || 0,
        status: w.statusAsOf,
        at: w.statusAsOf === "Approved" ? w.approvedDate : w.requestedDate,
        accountId: w.account,
      })),
      ...closedTradesToDate.map((t) => ({
        type: "trade-closed",
        symbol: t.symbol,
        profit: Number(t.profit) || 0,
        at: t.closeTime,
        accountId: byMt5Account.get(t.mt5Account) || null,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 80);

    const result = Array.from(byAccount.values()).map((bucket) => ({
      ...bucket,
      depositsTotal: Number(bucket.depositsTotal.toFixed(2)),
      withdrawalsTotal: Number(bucket.withdrawalsTotal.toFixed(2)),
      closedPnlTotal: Number(bucket.closedPnlTotal.toFixed(2)),
      reconstructedBalance: Number(
        (bucket.depositsTotal - bucket.withdrawalsTotal + bucket.closedPnlTotal).toFixed(2),
      ),
      openPositionsCount: bucket.openPositionsAsOf.length,
      // Already sorted by requestedDate: -1 from the query.
      deposits: bucket.deposits,
      withdrawals: bucket.withdrawals,
    }));

    const data = {
      clientId: id,
      at: at.toISOString(),
      accounts: result,
      timeline,
      caveats: [
        "Balance is reconstructed from approved deposits/withdrawals and closed trades only - manual balance adjustments or bonuses applied outside the deposit flow aren't reflected.",
        "Each deposit/withdrawal below shows its status as of this moment (Approved/Rejected/Pending), derived from its resolution date - not necessarily its current status if it was resolved after this point in time.",
        "Open positions as of this moment only include trades that have since closed; a position still open right now has no historical snapshot and can't appear here.",
      ],
      computedAt: new Date().toISOString(),
    };

    await cacheService.set(cacheKey, data, CACHE_TTL.CLIENT_TIME_MACHINE);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Update client profile
// @route   PUT /api/clients/:id
// @access  Private (admin, superadmin)
exports.updateClient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const isKycAction = req.body.kycAction === true;
    const io = req.app.get("io");
    const previousProfile = isKycAction
      ? await Profile.findOne({ user: id }).select("kycStatus")
      : null;

    // Validate KYC rejection reason
    if (
      isKycAction &&
      req.body.kycStatus === "rejected" &&
      !req.body.kycRejectReason
    ) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required when KYC status is rejected",
      });
    }

    // Update user details
    const userUpdateData = {
      firstName: req.body.firstname,
      lastName: req.body.lastname,
      email: req.body.email,
      isEmailVerified: req.body.isEmailVerified,
      country: req.body.country,
      phone: req.body.phone,
      dateofbirth: req.body.dateofbirth,
      updatedAt: Date.now(),
    };

    // Remove undefined fields
    Object.keys(userUpdateData).forEach(
      (key) => userUpdateData[key] === undefined && delete userUpdateData[key],
    );

    const user = await User.findByIdAndUpdate(id, userUpdateData, {
      new: true,
      runValidators: true,
    }).select(
      "-password -passwordResetToken -passwordResetExpires -emailVerificationToken -emailVerificationExpires",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    // Update or create profile
    const profileUpdateData = {
      ibPartner: req.body.ibPartner,
      updatedAt: Date.now(),
    };

    if (isKycAction) {
      profileUpdateData.kycVerified = req.body.kycVerified;
      profileUpdateData.kycStatus = req.body.kycStatus || "unverified";
      profileUpdateData.kycRejectReason =
        req.body.kycStatus === "rejected" ? req.body.kycRejectReason : null;
    }

    // Handle education fields
    if (req.body.educationLevel && req.body.educationLevel.trim() !== "") {
      profileUpdateData.educationLevel = req.body.educationLevel;
      if (req.body.educationLevel === "other") {
        profileUpdateData.otherEducation = req.body.otherEducation;
      }
    }

    // Add bank and wallet details if provided
    if (req.body.bankDetails)
      profileUpdateData.bankDetails = req.body.bankDetails;
    if (req.body.walletDetails)
      profileUpdateData.walletDetails = req.body.walletDetails;

    let profile = await Profile.findOneAndUpdate(
      { user: id },
      profileUpdateData,
      { new: true, runValidators: true, upsert: true },
    );

    // Invalidate caches
    await Promise.all([
      invalidateClientCaches(id),
      invalidateClientProfileCaches(id),
    ]);

    if (io) {
      io.emitCacheInvalidation(id, ["profile"]);
      io.broadcastCacheInvalidation(["clients", "profile", "kyc"]);
    }

    if (
      isKycAction &&
      req.notificationTriggers &&
      previousProfile?.kycStatus !== profile?.kycStatus
    ) {
      req.notificationTriggers
        .handleKycStatusChange({
          userId: id,
          profileId: profile?._id,
          status: profile?.kycStatus,
          reason: profile?.kycRejectReason,
        })
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(200).json({
      success: true,
      message: "Client updated successfully",
      data: { user, profile },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update client password
// @route   PUT /api/clients/:id/update-password
// @access  Private (admin, superadmin)
exports.updateClientPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.findByIdAndUpdate(
      id,
      { password: hashedPassword, updatedAt: Date.now() },
      { new: true, runValidators: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    // Invalidate client cache
    await invalidateClientCaches(id);

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client password info (not the actual password)
// @route   GET /api/clients/:id/password
// @access  Private (admin, superadmin)
exports.getClientPassword = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id).select("password updatedAt");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Password is set and secured with bcrypt hashing",
      lastUpdated: user.updatedAt,
      hasPassword: !!user.password,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Suspend client
// @route   PUT /api/clients/:id/suspend
// @access  Private (admin, superadmin)
exports.suspendClient = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndUpdate(
      id,
      { status: "suspended", updatedAt: Date.now() },
      { new: true, runValidators: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    await invalidateClientCaches(id);

    res.status(200).json({
      success: true,
      message: "Client suspended successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Activate client
// @route   PUT /api/clients/:id/activate
// @access  Private (admin, superadmin)
exports.activateClient = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndUpdate(
      id,
      { status: "activated", updatedAt: Date.now() },
      { new: true, runValidators: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    await invalidateClientCaches(id);

    res.status(200).json({
      success: true,
      message: "Client activated successfully",
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get all accounts for a specific user
// @route   GET /api/clients/users/:userId/accounts
// @access  Private (admin, superadmin)
exports.getUserAccounts = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { refresh = "true" } = req.query;

    const cacheKey = cacheService.generateKey(
      CACHE_KEYS.USER_ACCOUNTS(userId, refresh),
      {},
    );

    // Try cache for non-refresh requests
    if (refresh !== "true") {
      const cached = await cacheService.get(cacheKey);
      if (cached) {
        return res.status(200).json({
          success: true,
          count: cached.count,
          data: cached.data,
          fromCache: true,
        });
      }
    }

    // Get accounts with lean() for better performance
    const accounts = await Account.find({ user: userId })
      .select(
        "mt5Account name accountType leverage balance equity profit managerIndex groupName platform",
      )
      .sort({ createdAt: -1 })
      .lean();

    if (accounts.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
      });
    }

    // Only refresh if requested
    if (refresh === "true") {
      await refreshAccountBalances(accounts);
    }

    // Fetch updated accounts
    const updatedAccounts = await Account.find({ user: userId })
      .select(
        "mt5Account name accountType leverage balance equity profit platform groupName",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Push live balance/equity updates to the client over websocket
    if (refresh === "true") {
      const io = req.app.get("io");
      if (io) {
        updatedAccounts.forEach((account) => {
          io.emitAccountUpdate(userId, account);
        });
        io.emitCacheInvalidation(userId, ["accounts", "availableBalances"]);
      }
    }

    const response = {
      success: true,
      count: updatedAccounts.length,
      data: updatedAccounts,
    };

    // Cache for non-refresh requests
    if (refresh !== "true") {
      await cacheService.set(cacheKey, response, CACHE_TTL.USER_ACCOUNTS);
    }

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

// Helper function to refresh account balances
async function refreshAccountBalances(accounts) {
  try {
    const accountsByManager = new Map();

    accounts.forEach((account) => {
      const managerIndex = account.managerIndex || "3";
      if (!accountsByManager.has(managerIndex)) {
        accountsByManager.set(managerIndex, []);
      }
      accountsByManager.get(managerIndex).push({
        mt5Account: parseInt(account.mt5Account),
        accountId: account._id,
      });
    });

    // Fetch each manager group's balances in parallel instead of one at a time
    const managerUpdatePromises = await Promise.all(
      Array.from(accountsByManager.entries()).map(
        async ([managerIndex, managerAccounts]) => {
          const mt5AccountNumbers = managerAccounts.map(
            (acc) => acc.mt5Account,
          );

          try {
            const response = await metaApi.post(`/GetUserInfoByAccounts`, {
              Manager_Index: parseInt(managerIndex),
              MT5Accounts: mt5AccountNumbers,
            });

            const updates = [];

            if (response.data && Array.isArray(response.data)) {
              for (const userInfo of response.data) {
                const mt5Account =
                  userInfo.MT5Account || userInfo.Login || userInfo.login;
                const balance = userInfo.Balance || userInfo.balance || 0;
                const equity = userInfo.Equity || userInfo.equity || 0;

                if (mt5Account) {
                  const accountMapping = managerAccounts.find(
                    (acc) => acc.mt5Account === mt5Account,
                  );

                  if (accountMapping) {
                    updates.push(
                      Account.findByIdAndUpdate(accountMapping.accountId, {
                        balance: balance,
                        equity: equity,
                        updatedAt: Date.now(),
                      }),
                    );
                  }
                }
              }
            }

            return updates;
          } catch (apiError) {
            console.error(
              `Error fetching balances for manager ${managerIndex}:`,
              apiError.message,
            );
            return [];
          }
        },
      ),
    );

    await Promise.all(managerUpdatePromises.flat());
  } catch (apiError) {
    console.error(
      "External API Error in refreshAccountBalances:",
      apiError.message,
    );
    // Don't throw - continue with existing data
  }
}
// @desc    Get account details by account ID
// @route   GET /api/clients/accounts/:accountId
// @access  Private (admin, superadmin)
exports.getAccountDetails = async (req, res, next) => {
  try {
    const { accountId } = req.params;

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: "Account ID is required",
      });
    }

    const cacheKey = `admin:accounts:details:${accountId}`;
    const cached = await cacheService.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const account = await Account.findById(accountId).lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    await cacheService.set(cacheKey, account, 300); // 5 minutes cache

    res.status(200).json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Export clients to Excel
// @route   GET /api/clients/export/excel
// @access  Private (admin, superadmin)
exports.exportToExcel = async (req, res, next) => {
  try {
    // Use lean() for better performance and select only needed fields
    const [users, profiles] = await Promise.all([
      User.find({ role: "client" })
        .select("firstName lastName email isEmailVerified country status")
        .lean(),
      Profile.find({})
        .select("user walletDetails kycVerified ibPartner")
        .lean(),
    ]);

    // Create profile map for O(1) lookup
    const profileMap = new Map();
    profiles.forEach((profile) => {
      profileMap.set(profile.user.toString(), profile);
    });

    // Prepare data for Excel
    const clientsData = users.map((user) => {
      const profile = profileMap.get(user._id.toString());

      return {
        Name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        Email: user.email || "",
        "Account Number": profile?.walletDetails?.accountNumber || "",
        "Email Verified": user.isEmailVerified ? "Yes" : "No",
        "KYC Verified": profile?.kycVerified ? "Yes" : "No",
        Country: user.country?.name || "",
        State: user.country?.state || "",
        "IB Partner": profile?.ibPartner || "None",
        Status: user.status || "activated",
      };
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Clients");

    const headers = Object.keys(clientsData[0] || {});
    worksheet.columns = headers.map((header) => ({
      header,
      key: header,
      width: 20,
    }));

    worksheet.addRows(clientsData);
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    const tempFilePath = path.join(
      __dirname,
      "../temp",
      `clients_${Date.now()}.xlsx`,
    );
    const tempDir = path.dirname(tempFilePath);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    await workbook.xlsx.writeFile(tempFilePath);

    res.download(tempFilePath, "clients.xlsx", (err) => {
      fs.unlink(tempFilePath, (unlinkErr) => {
        if (unlinkErr)
          console.error("Error deleting temp excel file:", unlinkErr);
      });
      if (err) {
        console.error("Error sending excel file:", err);
      }
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Export clients to PDF
// @route   GET /api/clients/export/pdf
// @access  Private (admin, superadmin)
exports.exportToPdf = async (req, res, next) => {
  try {
    const [users, profiles] = await Promise.all([
      User.find({ role: "client" })
        .select("firstName lastName email isEmailVerified country status")
        .lean(),
      Profile.find({})
        .select("user walletDetails kycVerified ibPartner")
        .lean(),
    ]);

    // Create profile map
    const profileMap = new Map();
    profiles.forEach((profile) => {
      profileMap.set(profile.user.toString(), profile);
    });

    const doc = new PDFDocument({
      margin: 20,
      bufferPages: true,
      size: "A4",
      layout: "landscape",
    });

    const tempFilePath = path.join(
      __dirname,
      "../temp",
      `clients_${Date.now()}.pdf`,
    );
    const tempDir = path.dirname(tempFilePath);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const stream = fs.createWriteStream(tempFilePath);
    doc.pipe(stream);

    // Header
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#003366")
      .text("Clients List", { align: "center" });
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(`Generated on: ${new Date().toLocaleDateString()}`, {
        align: "center",
      });
    doc.moveDown(1);

    // Table configuration
    const tableHeaders = [
      "Name",
      "Email",
      "Account No.",
      "Email Verified",
      "KYC Verified",
      "Country",
      "IB Partner",
      "Status",
    ];
    const availableWidth = doc.page.width - 2 * doc.page.margins.left;
    const colWidths = [
      Math.floor(availableWidth * 0.15),
      Math.floor(availableWidth * 0.2),
      Math.floor(availableWidth * 0.12),
      Math.floor(availableWidth * 0.1),
      Math.floor(availableWidth * 0.1),
      Math.floor(availableWidth * 0.12),
      Math.floor(availableWidth * 0.1),
      Math.floor(availableWidth * 0.11),
    ];

    const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
    const cellPadding = 5;
    const lineHeight = 20;
    const fontSize = 8;

    // Prepare table data
    const tableData = users.map((user) => {
      const profile = profileMap.get(user._id.toString());
      return [
        `${user.firstName || ""} ${user.lastName || ""}`.substring(0, 30),
        (user.email || "").substring(0, 35),
        (profile?.walletDetails?.accountNumber || "").substring(0, 15),
        user.isEmailVerified ? "Yes" : "No",
        profile?.kycVerified ? "Yes" : "No",
        (user.country?.name || "").substring(0, 20),
        (profile?.ibPartner || "None").substring(0, 15),
        user.status || "activated",
      ];
    });

    // Draw table (simplified for performance)
    let currentY = 80;

    // Draw header
    doc
      .fillColor(headerColor)
      .rect(doc.page.margins.left, currentY, tableWidth, lineHeight)
      .fill();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(fontSize);
    let xPos = doc.page.margins.left + cellPadding;
    tableHeaders.forEach((header, i) => {
      doc.text(header, xPos, currentY + cellPadding, {
        width: colWidths[i] - 2 * cellPadding,
        align: "left",
      });
      xPos += colWidths[i];
    });

    currentY += lineHeight;

    // Draw rows
    for (let i = 0; i < tableData.length; i++) {
      if (currentY > doc.page.height - doc.page.margins.bottom - 50) {
        doc.addPage({ margin: 20, size: "A4", layout: "landscape" });
        currentY = doc.page.margins.top;

        // Redraw header on new page
        doc
          .fillColor(headerColor)
          .rect(doc.page.margins.left, currentY, tableWidth, lineHeight)
          .fill();
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(fontSize);
        xPos = doc.page.margins.left + cellPadding;
        tableHeaders.forEach((header, idx) => {
          doc.text(header, xPos, currentY + cellPadding, {
            width: colWidths[idx] - 2 * cellPadding,
            align: "left",
          });
          xPos += colWidths[idx];
        });
        currentY += lineHeight;
      }

      const isEven = i % 2 === 0;
      doc
        .fillColor(isEven ? evenRowColor : oddRowColor)
        .rect(doc.page.margins.left, currentY, tableWidth, lineHeight)
        .fill();

      doc.fillColor(textColor).font("Helvetica").fontSize(fontSize);
      xPos = doc.page.margins.left + cellPadding;
      tableData[i].forEach((cell, idx) => {
        doc.text(cell.toString(), xPos, currentY + cellPadding, {
          width: colWidths[idx] - 2 * cellPadding,
          align: "left",
        });
        xPos += colWidths[idx];
      });

      currentY += lineHeight;
    }

    doc.end();

    stream.on("finish", () => {
      res.download(tempFilePath, "clients.pdf", (err) => {
        fs.unlink(tempFilePath, (unlinkErr) => {
          if (unlinkErr)
            console.error("Error deleting temp PDF file:", unlinkErr);
        });
        if (err) {
          console.error("Error sending PDF file:", err);
        }
      });
    });
  } catch (error) {
    next(error);
  }
};
// Invalidate all caches related to a client
async function invalidateClientCaches(clientId) {
  // Delete specific client cache
  await cacheService.deletePattern(CACHE_KEYS.CLIENT_DETAILS(clientId));

  // Delete all clients list caches (since data changed)
  await cacheService.deletePattern("admin:clients:all:*");

  // Delete user accounts cache
  await cacheService.deletePattern(`admin:users:accounts:${clientId}:*`);

  console.log(`🗑️ Client cache invalidated for ID: ${clientId}`);
}

async function invalidateClientProfileCaches(clientId) {
  await Promise.all([
    cacheService.deletePattern(`profile:user:${clientId}`),
    cacheService.deletePattern(`profile:summary:${clientId}`),
  ]);

  console.log(`🗑️ Client profile cache invalidated for ID: ${clientId}`);
}

// Invalidate all client caches (call when bulk changes happen)
exports.invalidateAllClientCaches = async () => {
  await cacheService.deletePattern("admin:clients:*");
  console.log("🗑️ All client caches invalidated");
};

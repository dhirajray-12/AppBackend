require("dotenv").config();
const Deposit = require("../../models/Deposit");
const Withdrawal = require("../../models/Withdrawal");
const Transfer = require("../../models/client/Transfer");
const User = require("../../models/User");
const cacheService = require("../../services/cacheService");

// Cache keys
const CACHE_KEYS = {
  ALL_TRANSACTIONS: (filters) =>
    `admin:transactions:all:${JSON.stringify(filters)}`,
};

// Cache TTL (in seconds)
const CACHE_TTL = {
  TRANSACTIONS: 30, // 30 seconds - transactions update frequently
};

const buildUserProjection = () => ({
  id: "$user._id",
  name: {
    $trim: {
      input: {
        $concat: [
          { $ifNull: ["$user.firstName", ""] },
          " ",
          { $ifNull: ["$user.lastName", ""] },
        ],
      },
    },
  },
  email: "$user.email",
});

const buildDepositPipeline = ({ dateFilter, statusFilter, searchUserIds, topK }) => [
  { $match: { ...dateFilter, ...statusFilter } },
  ...(searchUserIds
    ? [{ $match: { user: { $in: searchUserIds } } }]
    : []),
  // Bound the join cost: only the top-K candidates (by date) from THIS
  // collection can possibly land in the final page after the 3-way union
  // is sorted, so join/enrich only those instead of every matching row.
  { $addFields: { _sortDate: { $ifNull: ["$requestedDate", "$createdAt"] } } },
  { $sort: { _sortDate: -1 } },
  { $limit: topK },
  {
    $lookup: {
      from: "users",
      localField: "user",
      foreignField: "_id",
      pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1 } }],
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "accounts",
      localField: "account",
      foreignField: "_id",
      pipeline: [{ $project: { mt5Account: 1, accountType: 1 } }],
      as: "account",
    },
  },
  { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "paymentmethods",
      localField: "paymentMethod",
      foreignField: "_id",
      pipeline: [{ $project: { name: 1 } }],
      as: "paymentMethod",
    },
  },
  { $unwind: { path: "$paymentMethod", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      transactionType: { $literal: "deposit" },
      user: buildUserProjection(),
      accountNumber: {
        $ifNull: ["$account.mt5Account", "$accountNumber", "N/A"],
      },
      amount: { $toDouble: "$amount" },
      paymentMethod: {
        $ifNull: ["$paymentMethod.name", "$paymentType", "N/A"],
      },
      type: { $literal: "Deposit" },
      planType: { $ifNull: ["$account.accountType", "N/A"] },
      requestedOn: {
        $ifNull: ["$requestedDate", "$createdAt", null],
      },
      completedOn: {
        $ifNull: ["$approvedDate", "$rejectedDate", "$updatedAt", null],
      },
      status: { $ifNull: ["$status", "Pending"] },
      remarks: { $ifNull: ["$remarks", "$notes", ""] },
      bonus: { $toDouble: { $ifNull: ["$bonus", 0] } },
      sortDate: { $ifNull: ["$requestedDate", "$createdAt"] },
    },
  },
];

const buildWithdrawalPipeline = ({ dateFilter, statusFilter, searchUserIds, topK }) => [
  { $match: { ...dateFilter, ...statusFilter } },
  ...(searchUserIds
    ? [{ $match: { user: { $in: searchUserIds } } }]
    : []),
  { $addFields: { _sortDate: { $ifNull: ["$requestedDate", "$createdAt"] } } },
  { $sort: { _sortDate: -1 } },
  { $limit: topK },
  {
    $lookup: {
      from: "users",
      localField: "user",
      foreignField: "_id",
      pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1 } }],
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "accounts",
      localField: "account",
      foreignField: "_id",
      pipeline: [{ $project: { mt5Account: 1, accountType: 1 } }],
      as: "account",
    },
  },
  { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      transactionType: { $literal: "withdrawal" },
      user: buildUserProjection(),
      accountNumber: {
        $ifNull: ["$account.mt5Account", "$accountNumber", "N/A"],
      },
      amount: { $toDouble: "$amount" },
      paymentMethod: { $ifNull: ["$paymentMethod", "N/A"] },
      type: { $literal: "Withdrawal" },
      planType: { $ifNull: ["$account.accountType", "N/A"] },
      requestedOn: {
        $ifNull: ["$requestedDate", "$createdAt", null],
      },
      completedOn: {
        $ifNull: ["$approvedDate", "$rejectedDate", "$updatedAt", null],
      },
      status: { $ifNull: ["$status", "Pending"] },
      remarks: { $ifNull: ["$remarks", ""] },
      bankDetails: "$bankDetails",
      sortDate: { $ifNull: ["$requestedDate", "$createdAt"] },
    },
  },
];

const buildTransferPipeline = ({ dateFilter, statusFilter, searchUserIds, topK }) => [
  { $match: { ...dateFilter, ...statusFilter } },
  ...(searchUserIds
    ? [{ $match: { user: { $in: searchUserIds } } }]
    : []),
  { $sort: { createdAt: -1 } },
  { $limit: topK },
  {
    $lookup: {
      from: "users",
      localField: "user",
      foreignField: "_id",
      pipeline: [{ $project: { firstName: 1, lastName: 1, email: 1 } }],
      as: "user",
    },
  },
  { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "accounts",
      localField: "fromAccount",
      foreignField: "_id",
      pipeline: [{ $project: { mt5Account: 1, accountType: 1 } }],
      as: "fromAccount",
    },
  },
  { $unwind: { path: "$fromAccount", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "accounts",
      localField: "toAccount",
      foreignField: "_id",
      pipeline: [{ $project: { mt5Account: 1, accountType: 1 } }],
      as: "toAccount",
    },
  },
  { $unwind: { path: "$toAccount", preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      transactionType: { $literal: "transfer" },
      user: buildUserProjection(),
      accountNumber: {
        $concat: [
          { $ifNull: ["$fromAccount.mt5Account", "N/A"] },
          " → ",
          { $ifNull: ["$toAccount.mt5Account", "N/A"] },
        ],
      },
      amount: { $toDouble: "$amount" },
      paymentMethod: { $literal: "Internal Transfer" },
      type: { $literal: "Transfer" },
      planType: {
        $concat: [
          { $ifNull: ["$fromAccount.accountType", "N/A"] },
          " → ",
          { $ifNull: ["$toAccount.accountType", "N/A"] },
        ],
      },
      requestedOn: "$createdAt",
      completedOn: "$updatedAt",
      status: { $ifNull: ["$status", "Completed"] },
      fromAccount: {
        accountNumber: { $ifNull: ["$fromAccount.mt5Account", "N/A"] },
        planType: { $ifNull: ["$fromAccount.accountType", "N/A"] },
      },
      toAccount: {
        accountNumber: { $ifNull: ["$toAccount.mt5Account", "N/A"] },
        planType: { $ifNull: ["$toAccount.accountType", "N/A"] },
      },
      sortDate: "$createdAt",
    },
  },
];

const buildAggregationConfig = ({ type, dateFilter, statusFilter, searchUserIds, topK }) => {
  const sharedFilters = { dateFilter, statusFilter, searchUserIds, topK };

  switch (type) {
    case "deposit":
      return {
        model: Deposit,
        pipeline: buildDepositPipeline(sharedFilters),
      };
    case "withdrawal":
      return {
        model: Withdrawal,
        pipeline: buildWithdrawalPipeline(sharedFilters),
      };
    case "transfer":
      return {
        model: Transfer,
        pipeline: buildTransferPipeline(sharedFilters),
      };
    case "all":
    default:
      return {
        model: Deposit,
        pipeline: [
          ...buildDepositPipeline(sharedFilters),
          {
            $unionWith: {
              coll: Withdrawal.collection.name,
              pipeline: buildWithdrawalPipeline(sharedFilters),
            },
          },
          {
            $unionWith: {
              coll: Transfer.collection.name,
              pipeline: buildTransferPipeline(sharedFilters),
            },
          },
        ],
      };
  }
};

exports.getAllTransactions = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      type = "all",
      status = "all",
      search = "",
      startDate,
      endDate,
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const cacheKey = cacheService.generateKey(CACHE_KEYS.ALL_TRANSACTIONS({}), {
      page: pageNum,
      limit: limitNum,
      type,
      status,
      search,
      startDate,
      endDate,
      aggregated: true,
    });

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, fromCache: true });
    }

    // Build match conditions for each collection
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate + "T23:59:59.999Z"),
      };
    }

    const statusFilter = status !== "all" ? { status } : {};

    // Search filter
    let searchUserIds = null;
    if (search) {
      const searchRegex = new RegExp(search, "i");
      const matchingUsers = await User.find({
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
        ],
      })
        .select("_id")
        .lean();
      searchUserIds = matchingUsers.map((u) => u._id);

      if (searchUserIds.length === 0) {
        const emptyResponse = {
          success: true,
          count: 0,
          total: 0,
          page: pageNum,
          pages: 0,
          limit: limitNum,
          data: [],
          summary: {
            total: 0,
            volume: 0,
            pending: 0,
            deposits: 0,
            withdrawals: 0,
            transfers: 0,
          },
        };

        await cacheService.set(cacheKey, emptyResponse, CACHE_TTL.TRANSACTIONS);
        return res.status(200).json(emptyResponse);
      }
    }

    // Every filter (date/status/searchUserIds) matches raw, unjoined fields
    // on each source collection, so `total` AND the summary stat-tile counts
    // (volume/pending/deposits/withdrawals/transfers) can both be computed
    // directly via cheap indexed $match+$group aggregates — no joins needed,
    // and no need to touch the whole filtered set twice.
    const rawMatchQuery = {
      ...dateFilter,
      ...statusFilter,
      ...(searchUserIds ? { user: { $in: searchUserIds } } : {}),
    };

    const buildStatsPipeline = () => [
      { $match: rawMatchQuery },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          volume: { $sum: { $toDouble: "$amount" } },
          pending: { $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] } },
        },
      },
    ];

    const summaryPromise = (async () => {
      if (type === "all") {
        const [[depositStats], [withdrawalStats], [transferStats]] = await Promise.all([
          Deposit.aggregate(buildStatsPipeline()),
          Withdrawal.aggregate(buildStatsPipeline()),
          Transfer.aggregate(buildStatsPipeline()),
        ]);
        const deposits = depositStats?.count || 0;
        const withdrawals = withdrawalStats?.count || 0;
        const transfers = transferStats?.count || 0;
        return {
          total: deposits + withdrawals + transfers,
          volume:
            (depositStats?.volume || 0) +
            (withdrawalStats?.volume || 0) +
            (transferStats?.volume || 0),
          pending:
            (depositStats?.pending || 0) +
            (withdrawalStats?.pending || 0) +
            (transferStats?.pending || 0),
          deposits,
          withdrawals,
          transfers,
        };
      }

      const { model: statsModel } = buildAggregationConfig({
        type,
        dateFilter,
        statusFilter,
        searchUserIds,
      });
      const [stats] = await statsModel.aggregate(buildStatsPipeline());
      const count = stats?.count || 0;
      return {
        total: count,
        volume: stats?.volume || 0,
        pending: stats?.pending || 0,
        deposits: type === "deposit" ? count : 0,
        withdrawals: type === "withdrawal" ? count : 0,
        transfers: type === "transfer" ? count : 0,
      };
    })();

    // topK = skip + limitNum: the most candidates any single source could
    // possibly contribute to this page once merged by date, so joining only
    // this many rows per collection (instead of every matching row) is safe.
    const topK = skip + limitNum;

    const { model, pipeline } = buildAggregationConfig({
      type,
      dateFilter,
      statusFilter,
      searchUserIds,
      topK,
    });

    const [summary, aggregationResult] = await Promise.all([
      summaryPromise,
      model.aggregate([
        ...pipeline,
        { $sort: { sortDate: -1, id: -1 } },
        { $skip: skip },
        { $limit: limitNum },
      ]),
    ]);

    const total = summary.total;
    const paginatedTransactions = aggregationResult || [];
    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      count: paginatedTransactions.length,
      total,
      page: pageNum,
      pages: totalPages,
      limit: limitNum,
      data: paginatedTransactions,
      summary,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.TRANSACTIONS);

    return res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
exports.getTransactionById = async (req, res, next) => {
  try {
    const { id, type } = req.params;

    const cacheKey = cacheService.generateKey(
      `admin:transaction:${type}:${id}`,
      {},
    );
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res
        .status(200)
        .json({ success: true, data: cached, fromCache: true });
    }

    let transaction = null;
    let model = null;

    switch (type) {
      case "deposit":
        model = Deposit;
        break;
      case "withdrawal":
        model = Withdrawal;
        break;
      case "transfer":
        model = Transfer;
        break;
      default:
        return res
          .status(400)
          .json({ success: false, message: "Invalid transaction type" });
    }

    transaction = await model
      .findById(id)
      .populate("user", "firstName lastName email")
      .populate("account", "mt5Account accountType")
      .lean();

    if (!transaction) {
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });
    }

    await cacheService.set(cacheKey, transaction, 300); // Cache for 5 minutes

    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};
// Call this function when deposits/withdrawals/transfers are created, updated, or deleted
exports.invalidateTransactionsCache = async () => {
  await cacheService.deletePattern("admin:transactions:*");
  console.log("🗑️ Transactions cache invalidated");
};

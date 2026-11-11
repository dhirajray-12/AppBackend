// backend/services/transactionService.js
const Deposit = require("../models/Deposit");
const Withdrawal = require("../models/Withdrawal");
const Transfer = require("../models/client/Transfer");
const Account = require("../models/client/Account");
const mongoose = require("mongoose");

class TransactionService {
  /**
   * Get user transactions with filtering and pagination
   */
  async getUserTransactions(userId, filters = {}) {
    const {
      type = "all",
      status = "all",
      startDate,
      endDate,
      search = "",
      page = 1,
      limit = 10,
    } = filters;

    const pageNum = Number.parseInt(page, 10) || 1;
    const limitNum = Number.parseInt(limit, 10) || 10;
    const skip = (pageNum - 1) * limitNum;
    const dateFilter = {};
    const userObjectId =
      userId instanceof mongoose.Types.ObjectId
        ? userId
        : new mongoose.Types.ObjectId(userId);

    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { $gte: new Date(startDate) } : {}),
        ...(endDate ? { $lte: new Date(`${endDate}T23:59:59.999Z`) } : {}),
      };
    }

    const statusFilter = status !== "all" ? { status } : {};
    const searchRegex = search ? new RegExp(search, "i") : null;

    const queryPromises = [];

    if (type === "all" || type === "deposit") {
      const depositQuery = { user: userId, ...dateFilter, ...statusFilter };
      if (searchRegex) {
        depositQuery.$or = [
          { accountNumber: searchRegex },
          { paymentType: searchRegex },
          { notes: searchRegex },
          { remarks: searchRegex },
        ];
      }

      queryPromises.push(
        Deposit.find(depositQuery)
          .select(
            "amount status requestedDate approvedDate createdAt account accountNumber paymentType",
          )
          .populate("account", "mt5Account name accountType")
          .lean(),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    if (type === "all" || type === "withdrawal") {
      const withdrawalQuery = {
        user: userId,
        ...dateFilter,
        ...statusFilter,
      };
      if (searchRegex) {
        withdrawalQuery.$or = [
          { accountNumber: searchRegex },
          { paymentMethod: searchRegex },
          { remarks: searchRegex },
        ];
      }

      queryPromises.push(
        Withdrawal.find(withdrawalQuery)
          .select(
            "amount status requestedDate approvedDate createdAt account accountNumber paymentMethod remarks",
          )
          .populate("account", "mt5Account name accountType")
          .lean(),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    if (type === "all" || type === "transfer") {
      queryPromises.push(
        Account.find({ user: userObjectId }).select("_id").lean().then((accounts) => {
          const accountIds = accounts.map((account) => account._id);

          if (accountIds.length === 0) {
            return [];
          }

          return Transfer.find({
            $or: [
              { fromAccount: { $in: accountIds } },
              { toAccount: { $in: accountIds } },
            ],
            ...dateFilter,
            ...statusFilter,
          })
            .select("amount status createdAt fromAccount toAccount")
            .populate("fromAccount", "mt5Account name accountType")
            .populate("toAccount", "mt5Account name accountType")
            .lean();
        }),
      );
    } else {
      queryPromises.push(Promise.resolve([]));
    }

    const [deposits, withdrawals, transfers] = await Promise.all(queryPromises);

    // Transform and combine
    const allTransactions = this.transformTransactions(
      deposits,
      withdrawals,
      transfers,
    );

    // Sort by date
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Apply search
    const filteredTransactions = searchRegex
      ? allTransactions.filter(
          (t) =>
            t.account.match(searchRegex) ||
            t.description.match(searchRegex) ||
            t.status.match(searchRegex),
        )
      : allTransactions;

    // Paginate
    const paginatedTransactions = filteredTransactions.slice(
      skip,
      skip + limitNum,
    );
    return {
      transactions: paginatedTransactions,
      total: filteredTransactions.length,
      page: pageNum,
      pages: Math.ceil(filteredTransactions.length / limitNum),
    };
  }

  /**
   * Transform transactions to consistent format
   */
  transformTransactions(deposits, withdrawals, transfers) {
    const transformed = [];

    deposits.forEach((deposit) => {
      const approvedDate = deposit.approvedDate || null;
      const createdAt = deposit.createdAt || null;
      const timeTaken =
        approvedDate && deposit.requestedDate
          ? new Date(approvedDate) - new Date(deposit.requestedDate)
          : 0; // in milliseconds

      transformed.push({
        id: deposit._id,
        date:
          deposit.status === "Pending"
            ? deposit.requestedDate
            : approvedDate || createdAt,
        type: "Deposit",
        description: `${deposit.paymentType} Deposit`,
        amount: deposit.amount,
        formattedAmount: `+$${deposit.amount.toFixed(2)}`,
        account: deposit.account?.mt5Account || deposit.accountNumber || "Unknown",
        accountName: deposit.account?.name,
        accountType: deposit.account?.accountType,
        status: deposit.status,
        rawAmount: deposit.amount,
        approvedDate,
        createdAt,
        timeTaken, // in milliseconds
      });
    });

    withdrawals.forEach((withdrawal) => {
      const approvedDate = withdrawal.approvedDate || null;
      const createdAt = withdrawal.createdAt || null;
      const timeTaken =
        approvedDate && withdrawal.requestedDate
          ? new Date(approvedDate) - new Date(withdrawal.requestedDate)
          : 0;

      transformed.push({
        id: withdrawal._id,
        date:
          withdrawal.status === "Pending"
            ? withdrawal.requestedDate
            : approvedDate || createdAt,
        type: "Withdrawal",
        description: `${withdrawal.paymentMethod} Withdrawal`,
        amount: -withdrawal.amount,
        formattedAmount: `-$${withdrawal.amount.toFixed(2)}`,
        account:
          withdrawal.account?.mt5Account || withdrawal.accountNumber || "Unknown",
        accountName: withdrawal.account?.name,
        accountType: withdrawal.account?.accountType,
        status: withdrawal.status,
        rawAmount: -withdrawal.amount,
        approvedDate,
        createdAt,
        timeTaken,
      });
    });

    transfers.forEach((transfer) => {
      const approvedDate = transfer.approvedDate || null;
      const createdAt = transfer.createdAt || null;
      const timeTaken =
        approvedDate && transfer.requestedDate
          ? new Date(approvedDate) - new Date(transfer.requestedDate)
          : 0;

      const fromMt5 = transfer.fromAccount?.mt5Account || "Unknown";
      const toMt5 = transfer.toAccount?.mt5Account || "Unknown";

      transformed.push({
        id: transfer._id,
        date: createdAt,
        type: "Transfer",
        description: `Transfer to ${toMt5}`,
        amount: -transfer.amount,
        formattedAmount: `-$${transfer.amount.toFixed(2)}`,
        account: fromMt5,
        accountName: transfer.fromAccount?.name,
        accountType: transfer.fromAccount?.accountType,
        fromAccount: fromMt5,
        toAccount: toMt5,
        status: transfer.status,
        rawAmount: -transfer.amount,
        approvedDate,
        createdAt,
        timeTaken,
      });

      transformed.push({
        id: `${transfer._id}-to`,
        date: createdAt,
        type: "Transfer",
        description: `Transfer from ${fromMt5}`,
        amount: transfer.amount,
        formattedAmount: `+$${transfer.amount.toFixed(2)}`,
        account: toMt5,
        accountName: transfer.toAccount?.name,
        accountType: transfer.toAccount?.accountType,
        fromAccount: fromMt5,
        toAccount: toMt5,
        status: transfer.status,
        rawAmount: transfer.amount,
        approvedDate,
        createdAt,
        timeTaken,
      });
    });

    return transformed;
  }
}

module.exports = new TransactionService();

// Backend/models/PammTransaction.js
// Ledger of everything that happens to a PAMM fund's money: join/leave
// requests (pending until admin approval, same as Withdrawal/Deposit) and
// the fee/settlement entries the settlement job writes automatically.
const mongoose = require("mongoose");

const PammTransactionSchema = new mongoose.Schema(
  {
    pamm: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Pamm",
      required: true,
      index: true,
    },
    investment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PammInvestment",
      default: null,
    },
    investor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    // The investor's account for investment/redemption requests.
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    type: {
      type: String,
      enum: [
        "investment",
        "redemption",
        "management_fee",
        "performance_fee",
        "settlement",
      ],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "rejected"],
      default: "pending",
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    units: {
      type: Number,
      default: 0,
    },
    navAtTransaction: {
      type: Number,
      default: null,
    },
    remarks: {
      type: String,
      default: "",
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    mt5Ticket: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

PammTransactionSchema.index({ pamm: 1, createdAt: -1 });
PammTransactionSchema.index({ investor: 1, createdAt: -1 });
PammTransactionSchema.index({ status: 1, type: 1, createdAt: -1 });
PammTransactionSchema.index({ investment: 1, createdAt: -1 });

module.exports =
  mongoose.models.PammTransaction ||
  mongoose.model("PammTransaction", PammTransactionSchema);

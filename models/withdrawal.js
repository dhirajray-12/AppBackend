//Backend\models\withdrawal.js

const mongoose = require("mongoose");

const WithdrawalSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    accountNumber: {
      type: String,
      required: true,
      index: true,
    },
    accountType: {
      type: String,
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      index: true,
    },
    paymentMethod: {
      type: String,
      required: true,
      index: true,
    },
    bankDetails: {
      bankName: String,
      accountHolderName: String,
      accountNumber: String,
      ifscCode: String,
    },
    eWalletDetails: {
      walletId: { type: String },
      type: { type: String },
    },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
      index: true,
    },
    requestedDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    approvedDate: {
      type: Date,
      index: true,
    },
    rejectedDate: {
      type: Date,
    },
    remarks: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

WithdrawalSchema.index({ status: 1, createdAt: -1 });
WithdrawalSchema.index({ user: 1, createdAt: -1 });
WithdrawalSchema.index({ user: 1, status: 1, createdAt: -1 });
WithdrawalSchema.index({ account: 1, status: 1 });
WithdrawalSchema.index({ account: 1, status: 1, approvedDate: -1 });
WithdrawalSchema.index({ status: 1, approvedDate: -1 });
WithdrawalSchema.index({ paymentMethod: 1, status: 1 });

module.exports =
  mongoose.models.Withdrawal || mongoose.model("Withdrawal", WithdrawalSchema);

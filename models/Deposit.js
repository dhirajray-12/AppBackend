// Backend/models/Deposit.js - UPDATED WITH INDEXES
const mongoose = require("mongoose");

const DepositSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // Added index
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true, // Added index
    },
    amount: {
      type: Number,
      required: true,
    },
    planType: {
      type: String,
      index: true, // Added index for filtering
    },
    paymentMethod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentMethod",
      required: true,
    },
    paymentType: {
      type: String,
      required: true,
      index: true, // Added index for filtering
    },
    proofOfPayment: {
      type: String,
      required: true,
    },
    proofOfPaymentPublicId: {
      type: String,
    },
    accountNumber: {
      type: String,
      index: true, // Added index for search
    },
    bonus: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
      index: true, // Added index for filtering
    },
    transactionId: {
      type: String,
      index: true, // Added index for search
    },
    requestedDate: {
      type: Date,
      default: Date.now,
      index: true, // Added index for date sorting
    },
    approvedDate: {
      type: Date,
      index: true, // Added index for date filtering
    },
    rejectedDate: {
      type: Date,
    },
    remarks: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

// ✅ ADD THESE COMPOUND INDEXES FOR BETTER PERFORMANCE
DepositSchema.index({ status: 1, createdAt: -1 });
DepositSchema.index({ user: 1, createdAt: -1 });
DepositSchema.index({ user: 1, status: 1, createdAt: -1 });
DepositSchema.index({ account: 1, status: 1 });
DepositSchema.index({ account: 1, status: 1, approvedDate: -1 });
DepositSchema.index({ status: 1, approvedDate: -1 });
DepositSchema.index({ paymentType: 1, status: 1 });
DepositSchema.index({ requestedDate: -1, status: 1 });
// Admin deposit list defaults to sorting by updatedAt (latest activity first) —
// without this, that sort is unindexed and Mongo has to sort in memory.
DepositSchema.index({ updatedAt: -1 });
DepositSchema.index({ status: 1, updatedAt: -1 });

// ✅ Add text index for search functionality
DepositSchema.index({
  accountNumber: "text",
  "user.firstName": "text",
  "user.lastName": "text",
  "user.email": "text",
});

module.exports = mongoose.model("Deposit", DepositSchema);

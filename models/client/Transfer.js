const mongoose = require("mongoose");

const TransferSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    fromAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    toAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Completed", "Failed"],
      default: "Completed",
    },
  },
  { timestamps: true },
);

TransferSchema.index({ user: 1, createdAt: -1 });
TransferSchema.index({ user: 1, status: 1, createdAt: -1 });
TransferSchema.index({ status: 1, createdAt: -1 });
TransferSchema.index({ fromAccount: 1, createdAt: -1 });
TransferSchema.index({ toAccount: 1, createdAt: -1 });
TransferSchema.index({ fromAccount: 1, status: 1, createdAt: -1 });
TransferSchema.index({ toAccount: 1, status: 1, createdAt: -1 });
TransferSchema.index({ fromAccount: 1, toAccount: 1, createdAt: -1 });

module.exports = mongoose.model("Transfer", TransferSchema);

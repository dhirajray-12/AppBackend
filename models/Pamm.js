// Backend/models/Pamm.js
// A PAMM fund: one client's existing MT5 Account, designated by an admin as
// a pooled trading account that other clients can invest real money into.
// Value is tracked with NAV-per-unit accounting (like a mutual fund) so
// pooled P&L is allocated fairly across investors who joined at different
// times. See services/pammSettlementService.js for the valuation/fee logic.
const mongoose = require("mongoose");

const PammSchema = new mongoose.Schema(
  {
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Annualized management fee (%), prorated by elapsed days at each
    // settlement. e.g. 2 = 2% per year of AUM.
    managementFeePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    managementFeeFrequency: {
      type: String,
      enum: ["weekly", "monthly", "quarterly"],
      default: "monthly",
    },
    // Performance fee (%) taken on new profit above each investor's own
    // high-water mark, evaluated at every settlement run.
    performanceFeePercent: {
      type: Number,
      default: 20,
      min: 0,
      max: 100,
    },
    minInvestment: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "closed"],
      default: "active",
      index: true,
    },
    navPerUnit: {
      type: Number,
      default: 100,
      min: 0,
    },
    totalUnits: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Cached AUM (navPerUnit * totalUnits) so list views don't need to
    // recompute it; refreshed on every investment/redemption/settlement.
    aum: {
      type: Number,
      default: 0,
    },
    totalInvestors: {
      type: Number,
      default: 0,
    },
    lastSettlementAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

PammSchema.index({ status: 1, createdAt: -1 });
PammSchema.index({ manager: 1, createdAt: -1 });

module.exports = mongoose.models.Pamm || mongoose.model("Pamm", PammSchema);

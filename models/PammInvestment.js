// Backend/models/PammInvestment.js
// One investor's position in a PAMM fund. Kept as units (NAV-per-unit
// accounting) rather than a raw cash balance so pooled profit/loss is
// allocated fairly against everyone else in the fund.
const mongoose = require("mongoose");

const PammInvestmentSchema = new mongoose.Schema(
  {
    pamm: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Pamm",
      required: true,
      index: true,
    },
    investor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // The investor's own MT5 account that funded this position and that
    // redemptions/profit are paid back out to.
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    units: {
      type: Number,
      default: 0,
      min: 0,
    },
    principalInvested: {
      type: Number,
      default: 0,
      min: 0,
    },
    principalRedeemed: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Per-investor high-water mark (the NAV at which performance fee was
    // last charged, or the NAV at join time) — fair since investors join
    // at different NAVs.
    hwmNav: {
      type: Number,
      required: true,
    },
    totalFeesPaid: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
      index: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// One active position per (fund, investor, account) — further investments
// top the same position up instead of splitting it.
PammInvestmentSchema.index({ pamm: 1, investor: 1, account: 1 });
PammInvestmentSchema.index({ investor: 1, status: 1, createdAt: -1 });
PammInvestmentSchema.index({ pamm: 1, status: 1 });

module.exports =
  mongoose.models.PammInvestment ||
  mongoose.model("PammInvestment", PammInvestmentSchema);

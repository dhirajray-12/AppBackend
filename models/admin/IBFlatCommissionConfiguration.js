// backend/models/admin/IBFlatCommissionConfiguration.js
const mongoose = require("mongoose");

// Config for the "Normal" (flat per-level) commission mode: admin sets a
// fixed bonus-per-lot for each upline level in a group; every IB at that
// depth earns bonusPerLot * volume, with no ceiling or delegation involved.
// Kept as a separate model/collection from IBAdminConfiguration (the
// ceiling/waterfall config) so the two shapes are never mixed or misread.
const IBFlatCommissionConfigurationSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: [true, "Group ID is required"],
    },
    level: {
      type: Number,
      required: [true, "Level number is required"],
      min: 1,
      max: 10,
    },
    bonusPerLot: {
      type: Number,
      required: [true, "Bonus amount per lot is required"],
      min: 0,
    },
    defaultTimeInSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

IBFlatCommissionConfigurationSchema.index(
  { groupId: 1, level: 1 },
  { unique: true },
);

module.exports = mongoose.model(
  "IBFlatCommissionConfiguration",
  IBFlatCommissionConfigurationSchema,
);

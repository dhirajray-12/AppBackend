// backend/models/Group.js
const mongoose = require("mongoose");

const GroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please add a name"],
      unique: true,
      trim: true,
    },
    value: {
      type: String,
      required: [true, "Please add a value"],
      trim: true,
    },
    description: {
      type: String,
      required: [true, "Please add a description"],
      trim: true,
    },
    leverages: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Leverage",
        required: [true, "Please add leverage"],
      },
    ],
    platforms: {
      type: String,
      default: "",
      trim: true,
    },

    active: {
      type: Boolean,
      default: true,
    },

    // Which IB commission calculation model this group uses.
    // 'waterfall' = ceiling-based per-user delegation (IBAdminConfiguration.maximumCommission)
    // 'flat' = flat per-level bonusPerLot table (IBFlatCommissionConfiguration)
    commissionMode: {
      type: String,
      enum: ["waterfall", "flat"],
      default: "waterfall",
    },
  },

  { timestamps: true }
);

GroupSchema.index({ value: 1 }, { unique: true });
GroupSchema.index({ active: 1, createdAt: -1 });

module.exports = mongoose.model("Group", GroupSchema);

// backend/models/IBConfiguration.js
const mongoose = require("mongoose");

const IBAdminConfigurationSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      required: [true, "Group ID is required"],
      unique: true,
    },
    // Ceiling per lot that no root IB trading in this group may exceed.
    maximumCommission: {
      type: Number,
      required: [true, "Maximum commission per lot is required"],
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

module.exports = mongoose.model(
  "IBAdminConfiguration",
  IBAdminConfigurationSchema,
);

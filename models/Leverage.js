// backend/models/Leverage.js
const mongoose = require("mongoose");

const LeverageSchema = new mongoose.Schema(
  {
    value: {
      type: String,
      required: [true, "Please add a value"],
      min: [1, "Leverage value must be greater than 1"],
    },
    name: {
      type: String,
      required: [true, "Please add a name"],
      trim: true,
      unique: true,
    },
    active: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);
// Index for faster queries
LeverageSchema.index({ value: 1 });
module.exports = mongoose.model("Leverage", LeverageSchema);

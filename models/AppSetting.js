const mongoose = require("mongoose");

const BillingSuspensionSchema = new mongoose.Schema(
  {
    managedAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    paymentDueDate: {
      type: Date,
      default: null,
    },
    dueReminderDays: {
      type: Number,
      default: 3,
      min: 0,
      max: 60,
    },
    gracePeriodDays: {
      type: Number,
      default: 2,
      min: 0,
      max: 60,
    },
    maintenanceMessage: {
      type: String,
      trim: true,
      default:
        "Platform access is temporarily unavailable because the admin account is suspended due to payment.",
    },
    adminSuspendedMessage: {
      type: String,
      trim: true,
      default:
        "Your admin access has been suspended due to pending payment. Please contact the superadmin.",
    },
    isManuallySuspended: {
      type: Boolean,
      default: false,
    },
    manualReason: {
      type: String,
      trim: true,
      default: "",
    },
    lastDueReminderSentFor: {
      type: String,
      default: null,
    },
    lastGraceReminderSentFor: {
      type: String,
      default: null,
    },
    lastSuspensionNotifiedFor: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

const ThemeSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["light", "dark"],
      default: "dark",
    },
    accentColor: {
      type: String,
      trim: true,
      default: "#38bdf8",
    },
  },
  { _id: false },
);

// Admin-only operational config for the Risk & Exposure dashboard widget -
// deliberately kept separate from the billing/theme fields above, which
// flow through suspensionService.buildAccessPayload on every authenticated
// request (a cached, performance-sensitive path shared with login/session
// checks). Thresholds are read directly by the dashboard controller
// instead, off that hot path.
const RiskThresholdsSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: false,
    },
    maxFloatingLossUsd: {
      type: Number,
      default: 5000,
      min: 0,
    },
    maxSymbolNetLots: {
      type: Number,
      default: 50,
      min: 0,
    },
  },
  { _id: false },
);

const AppSettingSchema = new mongoose.Schema(
  {
    serverName: {
      type: String,
      trim: true,
      default: "Aon ltd.",
    },
    // IANA timezone name (e.g. "Asia/Kolkata"). Superadmin-controlled — every
    // date the API returns is re-expressed in this zone's offset by
    // middlewares/timezoneResponseMiddleware.js, and export/report controllers
    // use it via utils/timezoneUtils.formatDateForDisplay.
    timezone: {
      type: String,
      trim: true,
      default: "UTC",
    },
    billingSuspension: {
      type: BillingSuspensionSchema,
      default: () => ({}),
    },
    theme: {
      type: ThemeSchema,
      default: () => ({}),
    },
    riskThresholds: {
      type: RiskThresholdsSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("AppSetting", AppSettingSchema);

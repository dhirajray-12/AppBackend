const mongoose = require("mongoose");

const DeviceSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["client", "admin", "superadmin", "agent"],
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    deviceId: {
      type: String,
      required: true,
      index: true,
    },
    deviceName: {
      type: String,
      default: "Unknown device",
      trim: true,
    },
    deviceType: {
      type: String,
      enum: ["desktop", "mobile", "tablet", "bot", "unknown"],
      default: "unknown",
      index: true,
    },
    browser: {
      type: String,
      default: "Unknown browser",
    },
    os: {
      type: String,
      default: "Unknown OS",
    },
    userAgent: {
      type: String,
      default: "",
    },
    ipAddress: {
      type: String,
      default: "",
      index: true,
    },
    location: {
      country: { type: String, default: "" },
      region: { type: String, default: "" },
      city: { type: String, default: "" },
      label: { type: String, default: "Unknown" },
      source: { type: String, default: "ip" },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
    },
    isTrusted: {
      type: Boolean,
      default: false,
      index: true,
    },
    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    blockedAt: Date,
    blockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    markSafeAt: Date,
    markSafeBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    forcedLogoutAt: Date,
    forcedLogoutBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    loggedInAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenExpires: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "logged_out", "forced_logout", "blocked", "expired"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

DeviceSessionSchema.index({ user: 1, deviceId: 1, lastActiveAt: -1 });
DeviceSessionSchema.index({ user: 1, status: 1, isBlocked: 1, lastActiveAt: -1 });
DeviceSessionSchema.index({ user: 1, role: 1, lastActiveAt: -1 });
DeviceSessionSchema.index({ user: 1, sessionId: 1 });
DeviceSessionSchema.index({ role: 1, lastActiveAt: -1, user: 1, deviceId: 1 });

module.exports = mongoose.model("DeviceSession", DeviceSessionSchema);

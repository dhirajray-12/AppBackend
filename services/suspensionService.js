const AppSetting = require("../models/AppSetting");
const User = require("../models/User");
const cacheService = require("./cacheService");
const { isValidTimezone, DEFAULT_TIMEZONE } = require("../utils/timezoneUtils");

const ACCESS_PAYLOAD_CACHE_KEY = "suspension:accessPayload";
const ACCESS_PAYLOAD_CACHE_TTL = 15; // seconds — billing suspension state changes rarely

const DEFAULT_SERVER_NAME = "Aon ltd.";
const DEFAULT_THEME = { mode: "dark", accentColor: "#38bdf8" };
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_MAINTENANCE_MESSAGE =
  "Platform access is temporarily unavailable because the admin account is suspended due to payment.";
const DEFAULT_ADMIN_SUSPENDED_MESSAGE =
  "Your admin access has been suspended due to pending payment. Please contact the superadmin.";

const normalizeDateOnly = (input) => {
  if (!input) {
    return null;
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const getDateKey = (input) => {
  const date = normalizeDateOnly(input);
  return date ? date.toISOString().slice(0, 10) : null;
};

const getDayDifference = (fromDate, toDate) => {
  const start = normalizeDateOnly(fromDate);
  const end = normalizeDateOnly(toDate);

  if (!start || !end) {
    return null;
  }

  return Math.floor((end.getTime() - start.getTime()) / 86400000);
};

const getDefaultBillingSuspension = () => ({
  managedAdminId: null,
  paymentDueDate: null,
  dueReminderDays: 3,
  gracePeriodDays: 2,
  maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
  adminSuspendedMessage: DEFAULT_ADMIN_SUSPENDED_MESSAGE,
  isManuallySuspended: false,
  manualReason: "",
  lastDueReminderSentFor: null,
  lastGraceReminderSentFor: null,
  lastSuspensionNotifiedFor: null,
});

const normalizeBillingSuspension = (billingSuspension = {}) => {
  const source =
    billingSuspension && typeof billingSuspension.toObject === "function"
      ? billingSuspension.toObject()
      : billingSuspension || {};

  return {
    ...getDefaultBillingSuspension(),
    ...source,
    maintenanceMessage:
      source.maintenanceMessage?.trim() || DEFAULT_MAINTENANCE_MESSAGE,
    adminSuspendedMessage:
      source.adminSuspendedMessage?.trim() || DEFAULT_ADMIN_SUSPENDED_MESSAGE,
    manualReason: source.manualReason?.trim() || "",
  };
};

const normalizeTheme = (theme = {}) => {
  const source =
    theme && typeof theme.toObject === "function" ? theme.toObject() : theme || {};

  const mode = source.mode === "light" ? "light" : DEFAULT_THEME.mode;
  const accentColor = HEX_COLOR_PATTERN.test(source.accentColor || "")
    ? source.accentColor
    : DEFAULT_THEME.accentColor;

  return { mode, accentColor };
};

const getOrCreateAppSettings = async () => {
  let settings = await AppSetting.findOne();

  if (!settings) {
    settings = await AppSetting.create({
      serverName: DEFAULT_SERVER_NAME,
      billingSuspension: getDefaultBillingSuspension(),
      theme: { ...DEFAULT_THEME },
      timezone: DEFAULT_TIMEZONE,
    });
  }

  if (!settings.billingSuspension) {
    settings.billingSuspension = getDefaultBillingSuspension();
    await settings.save();
  }

  if (!settings.theme) {
    settings.theme = { ...DEFAULT_THEME };
    await settings.save();
  }

  if (!settings.timezone || !isValidTimezone(settings.timezone)) {
    settings.timezone = DEFAULT_TIMEZONE;
    await settings.save();
  }

  return settings;
};

const getManagedAdmin = async (managedAdminId) => {
  if (!managedAdminId) {
    return null;
  }

  return User.findOne({
    _id: managedAdminId,
    role: "admin",
  }).select("firstName lastName email role status");
};

const evaluateSuspensionState = ({ settings, managedAdmin, now = new Date() }) => {
  const billingSuspension = normalizeBillingSuspension(settings?.billingSuspension);
  const dueDate = normalizeDateOnly(billingSuspension.paymentDueDate);
  const dueDateKey = getDateKey(dueDate);
  const daysUntilDue = dueDate ? getDayDifference(now, dueDate) : null;
  const overdueDays =
    dueDate && daysUntilDue !== null && daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0;

  const manualReason = billingSuspension.manualReason || "Suspended manually by superadmin.";

  if (billingSuspension.isManuallySuspended) {
    return {
      isSuspended: true,
      reason: "manual",
      maintenanceMessage: billingSuspension.maintenanceMessage,
      adminMessage: manualReason,
      dueDate,
      dueDateKey,
      daysUntilDue,
      overdueDays,
      managedAdmin,
      reminders: {
        dueSoon: false,
        inGrace: false,
      },
    };
  }

  const dueReminderDays = Number(billingSuspension.dueReminderDays) || 0;
  const gracePeriodDays = Number(billingSuspension.gracePeriodDays) || 0;
  const dueSoon = dueDate && daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= dueReminderDays;
  const inGrace = overdueDays > 0 && overdueDays <= gracePeriodDays;
  const paymentOverdueSuspension = overdueDays > gracePeriodDays;

  return {
    isSuspended: paymentOverdueSuspension,
    reason: paymentOverdueSuspension ? "payment_overdue" : "active",
    maintenanceMessage: billingSuspension.maintenanceMessage,
    adminMessage: paymentOverdueSuspension
      ? billingSuspension.adminSuspendedMessage
      : billingSuspension.adminSuspendedMessage,
    dueDate,
    dueDateKey,
    daysUntilDue,
    overdueDays,
    managedAdmin,
    reminders: {
      dueSoon: !!dueSoon,
      inGrace: !!inGrace,
    },
  };
};

const sendPaymentLifecycleNotifications = async ({ io, settings, evaluation }) => {
  void io;
  void settings;
  void evaluation;
  return false;
};

// Tracks the last suspension state we broadcast, so periodic re-evaluation
// (e.g. the daily cron) only notifies clients when the computed state actually flips.
let lastBroadcastSuspensionKey = null;

const evaluateAndSyncSuspension = async ({
  io,
  settingsDoc,
  now = new Date(),
  broadcastIfChanged = false,
} = {}) => {
  const settings = settingsDoc || (await getOrCreateAppSettings());
  const managedAdmin = await getManagedAdmin(settings.billingSuspension?.managedAdminId);
  const evaluation = evaluateSuspensionState({ settings, managedAdmin, now });
  const changed = await sendPaymentLifecycleNotifications({
    io,
    settings,
    evaluation,
  });

  if (changed) {
    await settings.save();
  }

  if (broadcastIfChanged && io) {
    const stateKey = `${evaluation.isSuspended}:${evaluation.reason}`;
    if (stateKey !== lastBroadcastSuspensionKey) {
      lastBroadcastSuspensionKey = stateKey;
      io.emit("app_settings_updated", {
        type: "billing_suspension_state",
        currentState: {
          isSuspended: evaluation.isSuspended,
          reason: evaluation.reason,
          maintenanceMessage: evaluation.maintenanceMessage,
          adminMessage: evaluation.adminMessage,
        },
      });
      if (io.invalidateAllUsersCache) {
        io.invalidateAllUsersCache(["billingSuspension", "publicPlatformStatus"]);
      }
    }
  }

  return {
    settings,
    managedAdmin,
    evaluation,
  };
};

const buildAccessPayload = async ({ settingsDoc, io, now = new Date() } = {}) => {
  // The auth middleware calls this on every request with no settingsDoc.
  // Billing suspension state changes rarely, so serve it from a short-lived
  // cache instead of hitting AppSetting (+ the managed-admin lookup) per request.
  if (!settingsDoc) {
    const cached = await cacheService.get(ACCESS_PAYLOAD_CACHE_KEY);
    if (cached) return cached;
  }

  const { settings, managedAdmin, evaluation } = await evaluateAndSyncSuspension({
    settingsDoc,
    io,
    now,
  });

  const payload = {
    serverName: settings.serverName || DEFAULT_SERVER_NAME,
    theme: normalizeTheme(settings.theme?.toObject?.() || settings.theme),
    timezone: isValidTimezone(settings.timezone) ? settings.timezone : DEFAULT_TIMEZONE,
    billingSuspension: normalizeBillingSuspension(settings.billingSuspension?.toObject?.() || settings.billingSuspension),
    currentState: {
      isSuspended: evaluation.isSuspended,
      reason: evaluation.reason,
      reminders: evaluation.reminders,
      maintenanceMessage: evaluation.maintenanceMessage,
      adminMessage: evaluation.adminMessage,
      dueDate: evaluation.dueDate,
      dueDateKey: evaluation.dueDateKey,
      daysUntilDue: evaluation.daysUntilDue,
      overdueDays: evaluation.overdueDays,
      managedAdmin: managedAdmin
        ? {
            _id: managedAdmin._id,
            firstName: managedAdmin.firstName,
            lastName: managedAdmin.lastName,
            email: managedAdmin.email,
            status: managedAdmin.status,
          }
        : null,
    },
  };

  // Written unconditionally (even on the settingsDoc-provided path, e.g. right
  // after a superadmin edits the suspension policy) so the cache never serves
  // a stale state after a real change — it's always refreshed with the latest.
  await cacheService.set(ACCESS_PAYLOAD_CACHE_KEY, payload, ACCESS_PAYLOAD_CACHE_TTL);

  return payload;
};

module.exports = {
  DEFAULT_SERVER_NAME,
  DEFAULT_THEME,
  HEX_COLOR_PATTERN,
  DEFAULT_MAINTENANCE_MESSAGE,
  DEFAULT_ADMIN_SUSPENDED_MESSAGE,
  getOrCreateAppSettings,
  normalizeBillingSuspension,
  normalizeTheme,
  evaluateSuspensionState,
  evaluateAndSyncSuspension,
  buildAccessPayload,
};

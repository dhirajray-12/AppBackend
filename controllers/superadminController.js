const User = require("../models/User");
const {
  getOrCreateAppSettings,
  buildAccessPayload,
} = require("../services/suspensionService");

const listAdminsWithSuspensionStatus = async (req, res, next) => {
  try {
    // Admins list doesn't depend on settings/accessPayload, so fetch it
    // alongside the settings lookup instead of after.
    const [settings, admins] = await Promise.all([
      getOrCreateAppSettings(),
      User.find({ role: "admin" })
        .select("firstName lastName email status createdAt")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const io = req.app.get("io");
    const accessPayload = await buildAccessPayload({ settingsDoc: settings, io });
    const managedAdminId =
      accessPayload.billingSuspension.managedAdminId?.toString?.() ||
      accessPayload.billingSuspension.managedAdminId ||
      null;

    res.status(200).json({
      success: true,
      data: {
        ...accessPayload,
        admins: admins.map((admin) => ({
          ...admin,
          isManagedBillingAdmin: managedAdminId === admin._id.toString(),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateBillingSuspensionPolicy = async (req, res, next) => {
  try {
    const {
      managedAdminId,
      paymentDueDate,
      dueReminderDays,
      gracePeriodDays,
      maintenanceMessage,
      adminSuspendedMessage,
    } = req.body || {};

    if (!managedAdminId) {
      return res.status(400).json({
        success: false,
        message: "Managed admin is required",
      });
    }

    const admin = await User.findOne({ _id: managedAdminId, role: "admin" });
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Selected admin was not found",
      });
    }

    const settings = await getOrCreateAppSettings();
    const nextDueDate = paymentDueDate ? new Date(paymentDueDate) : null;

    if (paymentDueDate && Number.isNaN(nextDueDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Payment due date is invalid",
      });
    }

    settings.billingSuspension = {
      ...settings.billingSuspension.toObject(),
      managedAdminId,
      paymentDueDate: nextDueDate,
      dueReminderDays: Number(dueReminderDays ?? settings.billingSuspension.dueReminderDays ?? 3),
      gracePeriodDays: Number(gracePeriodDays ?? settings.billingSuspension.gracePeriodDays ?? 2),
      maintenanceMessage:
        typeof maintenanceMessage === "string"
          ? maintenanceMessage.trim()
          : settings.billingSuspension.maintenanceMessage,
      adminSuspendedMessage:
        typeof adminSuspendedMessage === "string"
          ? adminSuspendedMessage.trim()
          : settings.billingSuspension.adminSuspendedMessage,
      lastDueReminderSentFor: null,
      lastGraceReminderSentFor: null,
      lastSuspensionNotifiedFor: null,
    };

    await settings.save();
    const io = req.app.get("io");
    const payload = await buildAccessPayload({ settingsDoc: settings, io });

    if (io) {
      io.emit("app_settings_updated", {
        serverName: payload.serverName,
        billingSuspension: payload.billingSuspension,
        currentState: payload.currentState,
        updatedAt: new Date().toISOString(),
      });
    }

    res.status(200).json({
      success: true,
      message: "Billing suspension policy updated successfully",
      data: payload,
    });
  } catch (error) {
    next(error);
  }
};

const updateManualSuspension = async (req, res, next) => {
  try {
    const { isManuallySuspended, manualReason } = req.body || {};
    const settings = await getOrCreateAppSettings();

    settings.billingSuspension = {
      ...settings.billingSuspension.toObject(),
      isManuallySuspended: Boolean(isManuallySuspended),
      manualReason: typeof manualReason === "string" ? manualReason.trim() : "",
      lastSuspensionNotifiedFor: null,
    };

    await settings.save();
    const io = req.app.get("io");
    const payload = await buildAccessPayload({ settingsDoc: settings, io });

    if (io) {
      io.emit("app_settings_updated", {
        serverName: payload.serverName,
        billingSuspension: payload.billingSuspension,
        currentState: payload.currentState,
        updatedAt: new Date().toISOString(),
      });
    }

    res.status(200).json({
      success: true,
      message: isManuallySuspended
        ? "Manual suspension enabled"
        : "Manual suspension removed",
      data: payload,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listAdminsWithSuspensionStatus,
  updateBillingSuspensionPolicy,
  updateManualSuspension,
};

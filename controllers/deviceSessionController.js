const User = require("../models/User");
const DeviceSession = require("../models/DeviceSession");
const {
  buildSessionSummary,
  forceLogoutSession,
  getLatestSessionsForUser,
  markDeviceBlocked,
  markDeviceSafe,
} = require("../services/deviceSessionService");

const getSessionOr404 = async (userId, sessionId) => {
  return DeviceSession.findOne({ user: userId, sessionId });
};

// Notify the affected user (and admins) that their device/session list changed,
// and force-logout the specific tab if its session was revoked.
const emitDeviceSessionUpdate = (req, userId, { action, sessionId } = {}) => {
  const io = req.app.get("io");
  if (!io || !userId) return;

  io.to(`user_${userId}`).emit("deviceSessionUpdated", {
    action,
    sessionId,
    timestamp: new Date().toISOString(),
  });

  if (io.emitCacheInvalidation) {
    io.emitCacheInvalidation(userId, ["deviceSessions"]);
  }

  if (action === "force_logout" && sessionId) {
    io.to(`user_${userId}`).emit("sessionRevoked", { sessionId });
  }

  if (io.broadcastCacheInvalidation) {
    io.broadcastCacheInvalidation(["clientDeviceSessions"]);
  }
};

const formatSessionsResponse = (sessions, currentSessionId) =>
  sessions.map((session) => ({
    ...buildSessionSummary(session),
    isCurrentSession: session.sessionId === currentSessionId,
  }));

exports.getMyDeviceSessions = async (req, res, next) => {
  try {
    const sessions = await getLatestSessionsForUser(req.user.id);

    res.status(200).json({
      success: true,
      data: formatSessionsResponse(sessions, req.deviceSession?.sessionId),
    });
  } catch (error) {
    next(error);
  }
};

exports.updateMyDeviceTrust = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { isTrusted } = req.body;

    const session = await getSessionOr404(req.user.id, sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }

    session.isTrusted =
      typeof isTrusted === "boolean" ? isTrusted : !session.isTrusted;
    await session.save();

    emitDeviceSessionUpdate(req, req.user.id, {
      action: "trust",
      sessionId,
    });

    res.status(200).json({
      success: true,
      message: session.isTrusted
        ? "Device marked as trusted"
        : "Device removed from trusted devices",
      data: buildSessionSummary(session),
    });
  } catch (error) {
    next(error);
  }
};

exports.logoutMyDeviceSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const session = await forceLogoutSession({
      userId: req.user.id,
      sessionId,
      actorId: req.user.id,
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }

    emitDeviceSessionUpdate(req, req.user.id, {
      action: "force_logout",
      sessionId,
    });

    res.status(200).json({
      success: true,
      message: "Session logged out successfully",
      data: buildSessionSummary(session),
    });
  } catch (error) {
    next(error);
  }
};

exports.getClientDeviceSessions = async (req, res, next) => {
  try {
    const { clientId } = req.params;

    const client = await User.findById(clientId)
      .select("firstName lastName email role")
      .lean();

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const sessions = await getLatestSessionsForUser(clientId);

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: client._id,
          firstName: client.firstName,
          lastName: client.lastName,
          email: client.email,
          role: client.role,
        },
        sessions: formatSessionsResponse(sessions, null),
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateClientDeviceSession = async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    const { action, isTrusted } = req.body;

    const session = await getSessionOr404(clientId, sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }

    if (action === "block") {
      await markDeviceBlocked({
        userId: clientId,
        deviceId: session.deviceId,
        actorId: req.user.id,
      });
    } else if (action === "mark_safe") {
      await markDeviceSafe({
        userId: clientId,
        deviceId: session.deviceId,
        actorId: req.user.id,
      });
    } else if (action === "force_logout") {
      await forceLogoutSession({
        userId: clientId,
        sessionId,
        actorId: req.user.id,
      });
    } else if (action === "trust") {
      session.isTrusted =
        typeof isTrusted === "boolean" ? isTrusted : !session.isTrusted;
      await session.save();
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid device action",
      });
    }

    const updatedSessions = await getLatestSessionsForUser(clientId);

    emitDeviceSessionUpdate(req, clientId, { action, sessionId });

    res.status(200).json({
      success: true,
      message:
        action === "block"
          ? "Device blocked successfully"
          : action === "mark_safe"
            ? "Device marked safe successfully"
            : action === "force_logout"
              ? "Session logged out successfully"
              : updatedSessions.find((item) => item.sessionId === sessionId)
                    ?.isTrusted
                ? "Device marked as trusted"
                : "Device removed from trusted devices",
      data: formatSessionsResponse(updatedSessions, null),
    });
  } catch (error) {
    next(error);
  }
};

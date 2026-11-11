// Backend\middlewares\auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const DeviceSession = require("../models/DeviceSession");
const config = require("../config/config");
const {
  getDeviceMetadataFromRequest,
  shouldUpdateLastActive,
} = require("../utils/deviceSessionUtils");
const { buildAccessPayload } = require("../services/suspensionService");
const { ALL_PERMISSIONS } = require("../constants/permissions");

exports.protect = async (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  // Server-to-server auth: a trusted caller presents the shared API key
  // plus the target client's id instead of a user JWT.
  const apiKey = req.headers["x-api-key"];
  const targetUserId = req.headers["x-user-id"];

  if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        message: "x-user-id header is required when using x-api-key",
      });
    }

    try {
      const user = await User.findById(targetUserId).select("-password");

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      req.user = user;
      req.isApiKeyAuthenticated = true;
      return next();
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid x-user-id",
      });
    }
  }

  let token = req.cookies.auth_token; // Main token cookie (legacy)
  const activeRoleHeader = req.headers["x-active-role"];
  const activeRole = Array.isArray(activeRoleHeader)
    ? activeRoleHeader[0]
    : activeRoleHeader;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token) {
    if (
      activeRole &&
      ["client", "admin", "superadmin", "agent", "subadmin"].includes(
        activeRole,
      )
    ) {
      token = req.cookies[`auth_token_${activeRole}`];
    }
  }

  if (!token) {
    // Get the requested URL path
    const url = req.originalUrl || req.url;

    // Determine which role this endpoint belongs to
    let expectedRole = null;

    if (url.startsWith("/api/admin") || url.includes("/admin")) {
      expectedRole = "admin";
    } else if (
      url.startsWith("/api/superadmin") ||
      url.includes("/superadmin")
    ) {
      expectedRole = "superadmin";
    } else if (url.startsWith("/api/agent") || url.includes("/agent")) {
      expectedRole = "agent";
    } else if (url.startsWith("/api/client") || url.includes("/client")) {
      expectedRole = "client";
    }

    // First try to get token for the expected role
    if (expectedRole) {
      token = req.cookies[`auth_token_${expectedRole}`];
    }

    // If no role-specific token found, try all (fallback for general endpoints)
    if (!token) {
      const roleCookies = ["admin", "superadmin", "agent", "subadmin", "client"];

      for (const role of roleCookies) {
        const roleToken = req.cookies[`auth_token_${role}`];

        if (roleToken) {
          token = roleToken;
          break;
        }
      }
    }
  }
  // Check if token exists
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Not authorized Token  to access this route",
    });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);

    // CRITICAL FIX: Handle impersonation from token
    let userId = decoded.userId || decoded.id;

    // Check if this is an impersonation token
    if (decoded.impersonatedBy) {
      console.log(
        `Impersonation detected: Admin ${decoded.impersonatedBy} impersonating user ${userId}`,
      );
      // You might want to log this for audit purposes
    }

    // These three lookups are independent of each other (none needs another's
    // result), so run them concurrently instead of paying three sequential
    // round trips on every authenticated request.
    const [user, accessPayload, deviceSession] = await Promise.all([
      User.findById(userId).select("-password"),
      buildAccessPayload({ io: req.app.get("io") }),
      decoded.sessionId
        ? DeviceSession.findOne({ user: userId, sessionId: decoded.sessionId })
        : Promise.resolve(null),
    ]);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.role !== "superadmin" && accessPayload.currentState.isSuspended) {
      return res.status(423).json({
        success: false,
        message:
          user.role === "admin" ||
          user.role === "agent" ||
          user.role === "subadmin"
            ? accessPayload.currentState.adminMessage
            : accessPayload.currentState.maintenanceMessage,
        suspension: accessPayload.currentState,
      });
    }

    if (decoded.sessionId) {
      if (!deviceSession) {
        return res.status(401).json({
          success: false,
          message: "Session not found. Please log in again.",
        });
      }

      if (
        decoded.deviceId &&
        deviceSession.deviceId &&
        deviceSession.deviceId !== decoded.deviceId
      ) {
        return res.status(401).json({
          success: false,
          message: "Session device mismatch. Please log in again.",
        });
      }

      if (deviceSession.isBlocked || deviceSession.status === "blocked") {
        return res.status(403).json({
          success: false,
          message:
            "This device has been blocked. An administrator must mark it safe before you can use it again.",
        });
      }

      if (
        deviceSession.status === "forced_logout" ||
        deviceSession.status === "logged_out" ||
        deviceSession.status === "expired"
      ) {
        return res.status(401).json({
          success: false,
          message: "Your session is no longer active. Please log in again.",
        });
      }

      if (shouldUpdateLastActive(deviceSession.lastActiveAt)) {
        getDeviceMetadataFromRequest(req)
          .then((metadata) =>
            DeviceSession.findByIdAndUpdate(deviceSession._id, {
              $set: {
                lastActiveAt: new Date(),
                ipAddress: metadata.ipAddress,
                location: metadata.location,
                userAgent: metadata.userAgent,
                browser: metadata.browser,
                os: metadata.os,
                deviceType: metadata.deviceType,
                deviceName: metadata.deviceName || deviceSession.deviceName,
              },
            }),
          )
          .catch((sessionUpdateError) => {
            console.error("Failed to update device session activity:", sessionUpdateError);
          });
      }
    }

    if (
      activeRole &&
      ["client", "admin", "superadmin", "agent", "subadmin"].includes(
        activeRole,
      ) &&
      user.role !== activeRole &&
      !decoded.impersonatedBy
    ) {
      return res.status(403).json({
        success: false,
        message: "Active role does not match the authenticated session",
      });
    }

    // Add impersonation flag to request if needed
    if (decoded.impersonatedBy) {
      req.isImpersonating = true;
      req.impersonatedBy = decoded.impersonatedBy;
    }

    req.user = user;
    req.deviceSession = deviceSession;
    req.suspensionState = accessPayload.currentState;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: error.message,
    });
  }
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role ${req.user.role} is not authorized to access this route`,
      });
    }
    next();
  };
};

// Chain after `authorize`. Fails fast at route-definition time if
// `permissionKey` is not a recognized permission (catches typos).
// At request time: non-subadmin roles always pass; subadmins must have
// the given key in req.user.permissions.
exports.authorizePermission = (permissionKey) => {
  if (!ALL_PERMISSIONS.includes(permissionKey)) {
    throw new Error(
      `authorizePermission: unknown permission key "${permissionKey}"`,
    );
  }

  return (req, res, next) => {
    if (req.user.role !== "subadmin") {
      return next();
    }

    if (!(req.user.permissions || []).includes(permissionKey)) {
      return res.status(403).json({
        success: false,
        message: `Missing permission: ${permissionKey}`,
        code: "PERMISSION_DENIED",
      });
    }

    next();
  };
};

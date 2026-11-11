const mongoose = require("mongoose");
const DeviceSession = require("../models/DeviceSession");

const buildSessionSummary = (session) => ({
  id: session._id,
  sessionId: session.sessionId,
  deviceId: session.deviceId,
  deviceName: session.deviceName,
  deviceType: session.deviceType,
  browser: session.browser,
  os: session.os,
  ipAddress: session.ipAddress,
  location: session.location?.label || "Unknown",
  locationDetails: session.location || {
    city: "",
    region: "",
    country: "",
    label: "Unknown",
    source: "ip",
    latitude: null,
    longitude: null,
    accuracy: null,
  },
  userAgent: session.userAgent,
  isTrusted: !!session.isTrusted,
  isBlocked: !!session.isBlocked,
  status: session.status,
  lastActiveAt: session.lastActiveAt,
  loggedInAt: session.loggedInAt,
  forcedLogoutAt: session.forcedLogoutAt,
  blockedAt: session.blockedAt,
});

const buildLatestSessionsPipeline = ({
  userId,
  role,
  limit,
  includeUser = false,
}) => {
  const match = {};

  if (userId) {
    match.user = new mongoose.Types.ObjectId(userId);
  }

  if (role) {
    match.role = role;
  }

  const pipeline = [
    { $match: match },
    { $sort: { lastActiveAt: -1, updatedAt: -1, _id: -1 } },
    {
      $group: {
        _id: {
          user: "$user",
          deviceId: "$deviceId",
        },
        session: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$session" } },
    { $sort: { lastActiveAt: -1, updatedAt: -1, _id: -1 } },
  ];

  if (includeUser) {
    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
          pipeline: [
            {
              $project: {
                firstName: 1,
                lastName: 1,
                email: 1,
                role: 1,
              },
            },
          ],
        },
      },
      {
        $unwind: {
          path: "$user",
          preserveNullAndEmptyArrays: false,
        },
      },
    );
  }

  if (typeof limit === "number" && limit > 0) {
    pipeline.push({ $limit: limit });
  }

  return pipeline;
};

const getLatestSessionsForUser = async (userId) => {
  return DeviceSession.aggregate(buildLatestSessionsPipeline({ userId }));
};

const getLatestClientSessionsOverview = async (limit) => {
  return DeviceSession.aggregate(
    buildLatestSessionsPipeline({
      role: "client",
      limit,
      includeUser: true,
    }),
  );
};

const getBlockedDeviceRecord = async (userId, deviceId) => {
  return DeviceSession.findOne({
    user: userId,
    deviceId,
    isBlocked: true,
  })
    .sort({ updatedAt: -1 })
    .lean();
};

const markDeviceBlocked = async ({ userId, deviceId, actorId }) => {
  const now = new Date();

  await DeviceSession.updateMany(
    { user: userId, deviceId },
    {
      $set: {
        isBlocked: true,
        blockedAt: now,
        blockedBy: actorId || null,
        status: "blocked",
        forcedLogoutAt: now,
        forcedLogoutBy: actorId || null,
      },
    },
  );
};

const markDeviceSafe = async ({ userId, deviceId, actorId }) => {
  const now = new Date();

  await DeviceSession.updateMany(
    { user: userId, deviceId },
    {
      $set: {
        isBlocked: false,
        blockedAt: null,
        blockedBy: null,
        markSafeAt: now,
        markSafeBy: actorId || null,
      },
    },
  );

  await DeviceSession.updateMany(
    { user: userId, deviceId, status: "blocked" },
    {
      $set: {
        status: "logged_out",
      },
    },
  );
};

const forceLogoutSession = async ({ userId, sessionId, actorId }) => {
  const now = new Date();

  return DeviceSession.findOneAndUpdate(
    { user: userId, sessionId },
    {
      $set: {
        status: "forced_logout",
        forcedLogoutAt: now,
        forcedLogoutBy: actorId || null,
        refreshTokenHash: null,
        refreshTokenExpires: null,
      },
    },
    { new: true },
  );
};

module.exports = {
  buildSessionSummary,
  forceLogoutSession,
  getBlockedDeviceRecord,
  getLatestClientSessionsOverview,
  getLatestSessionsForUser,
  markDeviceBlocked,
  markDeviceSafe,
};

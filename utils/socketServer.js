// Backend/utils/socketServer.js (Integrated Chat + Notifications)
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const User = require("../models/User");
const Ticket = require("../models/Ticket");
const Message = require("../models/Message");
const NotificationService = require("../services/notificationService");
const NotificationTriggers = require("../services/notificationTriggers");
const mt5AccountWebSocketService = require("../services/mt5AccountWebSocketService");
const marketPriceFeedService = require("../services/marketPriceFeedService");
const {
  placeTradeCore,
  closeTradeCore,
  modifyTradeCore,
  buildSocketErrorPayload,
} = require("../controllers/client/liveTradingController");
const { normalizeAttachmentAssetFields } = require("./assetPaths");

const DEFAULT_DEV_SOCKET_ORIGINS = [
  "https://dcrm.testcrm.co.in",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

const SOCKET_ALLOWED_ORIGINS = Array.from(
  new Set(
    [
      ...(process.env.ALLOWED_ORIGINS || "").split(","),
      process.env.CLIENT_URL || "",
      ...(process.env.NODE_ENV !== "production"
        ? DEFAULT_DEV_SOCKET_ORIGINS
        : []),
    ]
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
);

const formatSocketUser = (user) => ({
  _id: user._id,
  firstname: user.firstName || user.firstname || "",
  lastname: user.lastName || user.lastname || "",
  email: user.email,
  role: user.role,
});

const extractSocketToken = (socket) => {
  const authToken =
    socket.handshake.auth?.token || socket.handshake.headers?.authorization;

  if (typeof authToken === "string" && authToken.startsWith("Bearer ")) {
    return authToken.slice(7);
  }

  const cookieHeader = socket.handshake.headers?.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((cookiePart) => {
      const [name, ...value] = cookiePart.trim().split("=");
      return [name, decodeURIComponent(value.join("=") || "")];
    }),
  );

  const activeRoleHeader = socket.handshake.headers?.["x-active-role"];
  const activeRoleAuth = socket.handshake.auth?.activeRole;
  const activeRoleQuery = socket.handshake.query?.activeRole;
  const activeRole = Array.isArray(activeRoleHeader)
    ? activeRoleHeader[0]
    : activeRoleHeader || activeRoleAuth || activeRoleQuery;

  if (
    activeRole &&
    ["client", "admin", "superadmin", "agent"].includes(activeRole) &&
    cookies[`auth_token_${activeRole}`]
  ) {
    return cookies[`auth_token_${activeRole}`];
  }

  return (
    cookies.auth_token ||
    cookies.auth_token_client ||
    cookies.auth_token_admin ||
    cookies.auth_token_superadmin ||
    cookies.auth_token_agent ||
    null
  );
};

/**
 * Set up WebSocket server for real-time chat and notifications
 * @param {Object} server - HTTP server instance
 */
const setupWebSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || SOCKET_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Create notification service instances
  const notificationService = new NotificationService(io);
  const notificationTriggers = new NotificationTriggers(io);

  // Attach services to io for access in other parts of the app
  io.notificationService = notificationService;
  io.notificationTriggers = notificationTriggers;

  // Authentication middleware for Socket.io - Modified to work with userId
  io.use(async (socket, next) => {
    try {
      const token = extractSocketToken(socket);
      const requestedUserId = socket.handshake.query.userId;
      const requestedActiveRole =
        socket.handshake.auth?.activeRole || socket.handshake.query?.activeRole;

      if (!token) {
        return next(new Error("Authentication error: Token required"));
      }

      const decoded = jwt.verify(token, config.JWT_SECRET);
      const resolvedUserId = decoded.userId || decoded.id;

      if (!resolvedUserId) {
        return next(new Error("Authentication error: Invalid token payload"));
      }

      if (
        requestedUserId &&
        requestedUserId.toString() !== resolvedUserId.toString()
      ) {
        return next(new Error("Authentication error: User mismatch"));
      }

      const user = await User.findById(resolvedUserId).select("-password");

      if (!user) {
        console.error(
          "Authentication error: User not found with ID:",
          resolvedUserId,
        );
        return next(new Error("Authentication error: User not found"));
      }

      // Attach the user to the socket
      socket.user = user;
      socket.userId = user._id.toString(); // For notification compatibility

      if (
        requestedActiveRole &&
        requestedActiveRole !== user.role &&
        !decoded.impersonatedBy
      ) {
        return next(new Error("Authentication error: Active role mismatch"));
      }

      console.log(
        `Socket authenticated: ${user.firstName} ${user.lastName} (ID: ${user._id})`,
      );
      next();
    } catch (error) {
      console.error("Socket authentication error:", error);
      return next(new Error("Authentication error: " + error.message));
    }
  });

  // Handle connections
  io.on("connection", (socket) => {
    console.log(
      `✅ User connected: ${socket.user.firstName} ${socket.user.lastName} (Role: ${socket.user.role})`,
    );
    // Join user to their personal notification room
    socket.join(`user_${socket.userId}`);
    console.log(
      `📢 User joined personal notification room: user_${socket.userId}`,
    );

    // Tell the MT5 feed to start streaming this user's accounts —
    // see setUserOnline/onOnlineSetChanged in mt5AccountWebSocketService.
    mt5AccountWebSocketService.setUserOnline(socket.userId);

    // Join admin users to admin notification room
    if (["admin", "superadmin"].includes(socket.user.role)) {
      socket.join("admin_room");
      console.log(
        `👑 Admin joined admin notification room: ${socket.user.firstName}`,
      );
    }

    if (["admin", "superadmin", "agent"].includes(socket.user.role)) {
      socket.join("support_room");
      io.emit("agentOnline", { userId: socket.userId, role: socket.user.role });
    } else {
      const supportRoom = io.sockets.adapter.rooms.get("support_room");
      if (supportRoom && supportRoom.size > 0) {
        socket.emit("agentOnline", { count: supportRoom.size });
      }
    }

    // Handle notification events
    socket.on("markNotificationAsRead", async (data) => {
      try {
        const { notificationId } = data;
        await notificationService.markAsRead(notificationId, socket.userId);
        console.log(
          `✅ Notification marked as read: ${notificationId} for user ${socket.userId}`,
        );
      } catch (error) {
        console.error("Error marking notification as read:", error);
        socket.emit("error", {
          message: "Failed to mark notification as read",
        });
      }
    });

    socket.on("markAllNotificationsAsRead", async () => {
      try {
        await notificationService.markAllAsRead(socket.userId);
        console.log(
          `✅ All notifications marked as read for user: ${socket.userId}`,
        );
      } catch (error) {
        console.error("Error marking all notifications as read:", error);
        socket.emit("error", {
          message: "Failed to mark all notifications as read",
        });
      }
    });

    socket.on("deleteNotification", async (data) => {
      try {
        const { notificationId } = data;
        await notificationService.deleteNotification(
          notificationId,
          socket.userId,
        );
        console.log(`🗑️ Notification deleted: ${notificationId}`);
      } catch (error) {
        console.error("Error deleting notification:", error);
        socket.emit("error", { message: "Failed to delete notification" });
      }
    });
    // Join ticket room for chat
    socket.on("joinTicket", async (data) => {
      const ticketId = data.ticketId;

      if (!ticketId) {
        socket.emit("error", { message: "Ticket ID is required" });
        return;
      }

      try {
        const ticket = await Ticket.findById(ticketId).select("createdBy");

        if (!ticket) {
          socket.emit("error", { message: "Ticket not found" });
          return;
        }

        if (
          socket.user.role === "client" &&
          ticket.createdBy.toString() !== socket.user._id.toString()
        ) {
          socket.emit("error", {
            message: "Not authorized to access this ticket",
          });
          return;
        }
      } catch (error) {
        socket.emit("error", { message: "Failed to join ticket room" });
        return;
      }

      socket.join(`ticket:${ticketId}`);
      console.log(
        `📢 User ${socket.user.firstName} joined ticket room: ${ticketId}`,
      );

      // Send confirmation
      socket.emit("joinedTicket", { ticketId });
    });

    // Leave ticket room
    socket.on("leaveTicket", (data) => {
      const ticketId = data.ticketId;

      if (!ticketId) {
        socket.emit("error", { message: "Ticket ID is required" });
        return;
      }

      socket.leave(`ticket:${ticketId}`);
      console.log(
        `👋 User ${socket.user.firstName} left ticket room: ${ticketId}`,
      );
    });

    // Handle new message in ticket
    socket.on("sendMessage", async (data) => {
      try {
        // Validate required fields
        if (!data.ticketId || !data.content) {
          socket.emit("error", {
            message: "Ticket ID and content are required",
          });
          return;
        }

        const ticket = await Ticket.findById(data.ticketId);
        if (!ticket) {
          socket.emit("error", { message: "Ticket not found" });
          return;
        }

        if (
          socket.user.role === "client" &&
          ticket.createdBy.toString() !== socket.user._id.toString()
        ) {
          socket.emit("error", {
            message: "Not authorized to access this ticket",
          });
          return;
        }

        if (ticket.status === "closed" || ticket.status === "resolved") {
          socket.emit("error", {
            message: "Cannot add message to a closed ticket",
          });
          return;
        }

        const message = await Message.create({
          ticketId: ticket._id,
          sender: socket.user._id,
          content: data.content.trim(),
          attachments: data.attachmentId ? [data.attachmentId] : [],
        });

        ticket.messages.push(message._id);
        if (socket.user.role !== "client" && ticket.status === "new") {
          ticket.status = "inProgress";
        }
        ticket.updatedAt = Date.now();
        await ticket.save();

        const populatedMessage = await Message.findById(message._id)
          .populate("sender", "firstName lastName email role")
          .populate("attachments")
          .lean();

        const messagePayload = {
          ...populatedMessage,
          sender: populatedMessage?.sender
            ? formatSocketUser(populatedMessage.sender)
            : formatSocketUser(socket.user),
          createdAt: populatedMessage?.createdAt
            ? new Date(populatedMessage.createdAt).toISOString()
            : new Date().toISOString(),
          attachments: Array.isArray(populatedMessage?.attachments)
            ? populatedMessage.attachments.map(normalizeAttachmentAssetFields)
            : populatedMessage?.attachments,
        };

        io.to(`ticket:${data.ticketId}`).emit("newMessage", {
          ticketId: data.ticketId,
          message: messagePayload,
          status: ticket.status,
        });

        console.log(
          `💬 Message sent to ticket ${data.ticketId} by ${socket.user.firstName}`,
        );

        // Send confirmation to sender
        socket.emit("messageSent", {
          success: true,
          messageId: Date.now().toString(),
          ticketId: data.ticketId,
        });
      } catch (error) {
        console.error("Error handling sendMessage:", error);
        socket.emit("error", {
          message: "Failed to send message: " + error.message,
        });
      }
    });

    // Live symbol-price subscriptions — see services/marketPriceFeedService.js.
    // The feed talks to upstream as a single fixed broker group
    // (MARKET_PRICE_GROUP in that file), so this is symbol-only - no
    // account/group lookup needed here. Tracked per-socket so disconnect()
    // below can clean up without the client needing to explicitly
    // unsubscribe first (a dropped connection, not just a normal screen
    // close, must still release its subscriptions).
    socket.marketSymbols = new Set();

    socket.on("market:subscribe", (data) => {
      const symbol = data?.symbol;
      if (!symbol || typeof symbol !== "string") return;
      if (socket.marketSymbols.has(symbol)) return; // already subscribed on this socket
      socket.join(`market:${symbol}`);
      socket.marketSymbols.add(symbol);
      marketPriceFeedService.addSubscriber(symbol);
    });

    socket.on("market:unsubscribe", (data) => {
      const symbol = data?.symbol;
      if (!symbol || !socket.marketSymbols.has(symbol)) return;
      socket.leave(`market:${symbol}`);
      socket.marketSymbols.delete(symbol);
      marketPriceFeedService.removeSubscriber(symbol);
    });

    // Buy/Sell/Close/modify-SL-TP over the already-open, already-
    // authenticated socket instead of a fresh HTTP request per action —
    // same validation/bridge-call/optimistic-cache logic as
    // POST /api/trading/live/place|close|modify (see
    // liveTradingController.js's placeTradeCore/closeTradeCore/
    // modifyTradeCore, shared by both paths), just without paying a new
    // TCP/TLS handshake + CORS preflight + auth-cookie re-check on every
    // tap of Buy/Sell/Close. The REST endpoints stay in place unchanged
    // for any caller that isn't holding a live socket.
    socket.on("trade:place", async (data, callback) => {
      try {
        const result = await placeTradeCore(io, socket.userId, data || {});
        callback?.({ ...result.json, status: result.status });
      } catch (error) {
        callback?.(buildSocketErrorPayload(error));
      }
    });

    socket.on("trade:close", async (data, callback) => {
      try {
        const result = await closeTradeCore(io, socket.userId, data || {});
        callback?.({ ...result.json, status: result.status });
      } catch (error) {
        callback?.(buildSocketErrorPayload(error));
      }
    });

    socket.on("trade:modify", async (data, callback) => {
      try {
        const result = await modifyTradeCore(io, socket.userId, data || {});
        callback?.({ ...result.json, status: result.status });
      } catch (error) {
        callback?.(buildSocketErrorPayload(error));
      }
    });

    // Handle typing indicator
    socket.on("typing", (data) => {
      if (!data.ticketId) return;

      socket.to(`ticket:${data.ticketId}`).emit("userTyping", {
        user: `${socket.user.firstName} ${socket.user.lastName}`,
        userId: socket.user._id,
        isTyping: data.isTyping,
      });
    });
    // Handle disconnection
    socket.on("disconnect", () => {
      console.log(
        `❌ User disconnected: ${socket.user.firstName} ${socket.user.lastName} (ID: ${socket.userId})`,
      );

      // Release every symbol this socket was subscribed to — a dropped
      // connection (app closed, network loss) never fires market:unsubscribe
      // itself, so without this the shared upstream subscription would leak
      // symbols nobody is actually watching anymore.
      for (const symbol of socket.marketSymbols) {
        marketPriceFeedService.removeSubscriber(symbol);
      }
      socket.marketSymbols.clear();

      // Only stop this user's MT5 stream once their last socket (across
      // every open tab/device) is gone — io.isUserOnline() checks the
      // user_<id> room, which this socket has already left by the time
      // 'disconnect' fires.
      if (!io.isUserOnline(socket.userId)) {
        mt5AccountWebSocketService.setUserOffline(socket.userId);
      }

      if (["admin", "superadmin", "agent"].includes(socket.user.role)) {
        const supportRoom = io.sockets.adapter.rooms.get("support_room");
        if (!supportRoom || supportRoom.size === 0) {
          io.emit("agentOffline", {
            userId: socket.userId,
            role: socket.user.role,
          });
        }
      }
    });

    // Send welcome message (for both notification and chat systems)
    socket.emit("connected", {
      message: "Connected to notification and chat service",
      userId: socket.userId,
      user: {
        id: socket.user._id,
        name: `${socket.user.firstName} ${socket.user.lastName}`,
        email: socket.user.email,
        role: socket.user.role,
      },
      timestamp: new Date(),
    });
    // Admin can join special admin rooms for notifications
    if (["admin", "superadmin"].includes(socket.user.role)) {
      socket.on("joinAdminRoom", (roomType) => {
        if (!roomType) return;
        socket.join(`admin_${roomType}`);
        console.log(
          `👑 Admin ${socket.user.firstName} joined admin room: ${roomType}`,
        );
      });

      socket.on("leaveAdminRoom", (roomType) => {
        if (!roomType) return;
        socket.leave(`admin_${roomType}`);
        console.log(
          `👑 Admin ${socket.user.firstName} left admin room: ${roomType}`,
        );
      });
    }
    // Get online users count for a ticket
    socket.on("getTicketOnlineUsers", (ticketId) => {
      if (!ticketId) return;

      const room = io.sockets.adapter.rooms.get(`ticket:${ticketId}`);
      const onlineCount = room ? room.size : 0;
      socket.emit("ticketOnlineUsers", { ticketId, count: onlineCount });
    });

    // Get notification count
    socket.on("getNotificationCount", async () => {
      try {
        const Notification = require("../models/Notification");
        const unreadCount = await Notification.countDocuments({
          recipient: socket.userId,
          read: false,
        });
        socket.emit("notificationCount", { count: unreadCount });
        console.log(
          `📊 Notification count for ${socket.user.firstName}: ${unreadCount}`,
        );
      } catch (error) {
        console.error("Error getting notification count:", error);
        socket.emit("error", { message: "Failed to get notification count" });
      }
    });

    // Health check
    socket.on("ping", () => {
      socket.emit("pong", { timestamp: new Date() });
    });
  });
  // Function to send notification to specific user
  io.sendNotificationToUser = (userId, notification) => {
    if (!userId || !notification) return;
    io.to(`user_${userId}`).emit("newNotification", notification);
    console.log(`📢 Notification sent to user ${userId}`);
  };

  // Function to send notification to all admins
  io.sendNotificationToAdmins = (notification) => {
    if (!notification) return;
    io.to("admin_room").emit("newNotification", notification);
    console.log(`📢 Notification sent to all admins`);
  };

  // Function to send message to ticket room
  io.sendMessageToTicket = (ticketId, message) => {
    if (!ticketId || !message) return;
    io.to(`ticket:${ticketId}`).emit("newMessage", message);
    console.log(`💬 Message sent to ticket room: ${ticketId}`);
  };

  // Function to broadcast system notification
  io.broadcastSystemNotification = (notification) => {
    if (!notification) return;
    io.emit("systemNotification", notification);
    console.log(`📢 System notification broadcasted`);
  };

  // Function to check if user is online
  io.isUserOnline = (userId) => {
    const userRoom = io.sockets.adapter.rooms.get(`user_${userId}`);
    return userRoom && userRoom.size > 0;
  };

  // Function to get online users in a ticket
  io.getTicketOnlineUsers = (ticketId) => {
    const room = io.sockets.adapter.rooms.get(`ticket:${ticketId}`);
    return room ? Array.from(room) : [];
  };

  // Function to emit entity updates to specific users
  io.emitEntityUpdate = (userId, entityType, entityId, action, data) => {
    io.to(`user_${userId}`).emit(`${entityType}_${action}`, {
      id: entityId,
      action,
      data,
      timestamp: new Date().toISOString(),
    });
  };

  // Function to broadcast to all admins
  io.broadcastToAdmins = (event, data) => {
    io.to("admin_room").emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  };

  // Function to emit deposit status update
  io.emitDepositUpdate = (deposit, previousStatus) => {
    const userId = deposit.user?._id || deposit.user;
    const payload = {
      id: deposit._id,
      data: {
        ...deposit,
        previousStatus,
      },
      previousStatus,
    };

    if (userId) {
      io.to(`user_${userId}`).emit("deposit_updated", {
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }

    // Also notify admins
    io.broadcastToAdmins("deposit_updated", payload);
  };

  // Function to emit withdrawal status update
  io.emitWithdrawalUpdate = (withdrawal, previousStatus) => {
    const userId = withdrawal.user?._id || withdrawal.user;
    const payload = {
      id: withdrawal._id,
      data: withdrawal,
      previousStatus,
    };

    if (userId) {
      io.to(`user_${userId}`).emit("withdrawal_updated", {
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }

    io.broadcastToAdmins("withdrawal_updated", payload);
  };

  // Function to emit account update
  io.emitAccountUpdate = (userId, account, action = "updated") => {
    io.emitEntityUpdate(userId, "account", account._id, action, account);
  };
  // Add these methods to the existing socketServer.js file

  // Store for cache invalidation tracking
  const cacheInvalidationStore = new Map();

  // Function to emit cache invalidation to specific user
  io.emitCacheInvalidation = (userId, queryKeys) => {
    const keys = Array.isArray(queryKeys) ? queryKeys : [queryKeys];
    io.to(`user_${userId}`).emit("cache_invalidate", {
      keys,
      timestamp: new Date().toISOString(),
    });
  };

  // Function to broadcast cache invalidation to all admins
  io.broadcastCacheInvalidation = (queryKeys) => {
    const keys = Array.isArray(queryKeys) ? queryKeys : [queryKeys];
    io.to("admin_room").emit("cache_invalidate", {
      keys,
      timestamp: new Date().toISOString(),
    });
  };

  // Function to broadcast a group's commissionMode change to every connected
  // client — the set of users affected (whole group) isn't known at the
  // socket layer, so this goes out globally like other system-wide events.
  io.broadcastGroupCommissionModeUpdate = (groupId, commissionMode) => {
    io.emit("group_commissionMode_updated", {
      groupId,
      commissionMode,
      timestamp: new Date().toISOString(),
    });
  };

  // Function to invalidate cache for all users (for system-wide changes)
  io.invalidateAllUsersCache = (queryKeys) => {
    const keys = Array.isArray(queryKeys) ? queryKeys : [queryKeys];
    io.emit("cache_invalidate", {
      keys,
      timestamp: new Date().toISOString(),
      global: true,
    });
  };
  console.log("✅ WebSocket server initialized with userId authentication");
  return io;
};

module.exports = setupWebSocket;

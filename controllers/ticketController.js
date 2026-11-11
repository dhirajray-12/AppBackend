// backend/controllers/ticketController.js - SUPER FAST VERSION
const Ticket = require("../models/Ticket");
const Message = require("../models/Message");
const Attachment = require("../models/Attachment");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { createAttachment } = require("../utils/fileUtils");
const cacheService = require("../services/cacheService");
const mongoose = require("mongoose");
const {
  normalizeTicketAssetFields,
  normalizeAttachmentAssetFields,
} = require("../utils/assetPaths");

// Cache keys
const CACHE_KEYS = {
  TICKETS_LIST: (userId, role, filters) =>
    `tickets:list:${userId}:${role}:${JSON.stringify(filters)}`,
  SINGLE_TICKET: (id) => `tickets:single:${id}`,
  TICKET_STATS: "tickets:stats",
  CLIENT_TICKET_STATS: (clientId) => `tickets:client:stats:${clientId}`,
  CLIENT_TICKETS: (clientId) => `tickets:client:list:${clientId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  TICKETS_LIST: 30, // 30 seconds
  SINGLE_TICKET: 60, // 1 minute
  TICKET_STATS: 300, // 5 minutes
  CLIENT_TICKET_STATS: 60, // 1 minute
  CLIENT_TICKETS: 30, // 30 seconds
};

const normalizeSocketUser = (user) => {
  if (!user) return undefined;

  return {
    ...user,
    firstname: user.firstName || user.firstname || "",
    lastname: user.lastName || user.lastname || "",
  };
};

const toObjectIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  return value.toString();
};
// @desc    Create a new ticket
// @route   POST /api/tickets
// @access  Private
exports.createTicket = async (req, res, next) => {
  try {
    const { subject, category, description, clientId } = req.body;

    // Determine the creator ID
    let creatorId;
    if (
      clientId &&
      (req.user.role === "admin" || req.user.role === "superadmin")
    ) {
      creatorId = clientId;
    } else {
      creatorId = req.user._id;
    }

    // Generate ticket number efficiently
    const count = await Ticket.countDocuments();
    const ticketNumber = `T-${(10001 + count).toString()}`;

    // Create ticket
    const ticket = new Ticket({
      ticketNumber,
      subject,
      description,
      category,
      createdBy: creatorId,
      status: "new",
    });

    if (req.user.role === "admin" || req.user.role === "superadmin") {
      ticket.assignedTo = req.user._id;
    }

    if (req.file) {
      const attachment = await createAttachment(req.file, req.user._id);
      ticket.attachments.push(attachment._id);
    }

    await ticket.save();

    // Create initial message
    const message = new Message({
      ticketId: ticket._id,
      sender: req.user._id,
      content: description,
    });

    if (req.file) {
      const attachment = await Attachment.findOne({
        uploadedBy: req.user._id,
        fileName: req.file.originalname,
      }).sort({ createdAt: -1 });

      if (attachment) {
        message.attachments.push(attachment._id);
      }
    }

    await message.save();
    ticket.messages.push(message._id);
    await ticket.save();

    // Populate for response
    await ticket.populate("createdBy", "firstName lastName email");

    // Invalidate relevant caches
    await invalidateTicketCaches(creatorId);

    // Trigger notifications (non-blocking)
    if (req.notificationTriggers) {
      req.notificationTriggers
        .handleTicketUpdate(ticket.toObject(), "created")
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(201).json({
      success: true,
      data: normalizeTicketAssetFields(ticket.toObject()),
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get all tickets (filtered by user role)
// @route   GET /api/tickets
// @access  Private
exports.getTickets = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.role;
    const { status, category, search, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const filters = {
      status,
      category,
      search,
      page: pageNum,
      limit: limitNum,
    };
    const cacheKey = CACHE_KEYS.TICKETS_LIST(userId, userRole, filters);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        total: cached.total,
        page: cached.page,
        pages: cached.pages,
        data: cached.data,
        fromCache: true,
      });
    }

    // Build query
    const query = {};
    if (userRole === "client") {
      query.createdBy = userId;
    }
    if (status && status !== "all") {
      query.status = status;
    }
    if (category && category !== "all") {
      query.category = category;
    }
    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { subject: searchRegex },
        { description: searchRegex },
        { ticketNumber: searchRegex },
      ];
    }

    // Run queries in parallel
    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate("createdBy", "firstName lastName email")
        .populate("assignedTo", "firstName lastName email")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Ticket.countDocuments(query),
    ]);

    const normalizedTickets = tickets.map(normalizeTicketAssetFields);
    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      count: normalizedTickets.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: normalizedTickets,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.TICKETS_LIST);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Get a single ticket
// @route   GET /api/tickets/:id
// @access  Private
exports.getTicketById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const userRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket ID format",
      });
    }

    const cacheKey = CACHE_KEYS.SINGLE_TICKET(id);

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached && (cached.createdBy._id === userId || userRole !== "client")) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const ticket = await Ticket.findById(id)
      .populate("createdBy", "firstName lastName email")
      .populate("assignedTo", "firstName lastName email")
      .populate({
        path: "messages",
        populate: [
          { path: "sender", select: "firstName lastName email role" },
          {
            path: "attachments",
            select: "fileName fileSize fileType filePath",
          },
        ],
      })
      .populate("attachments")
      .lean();

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    // Check authorization
    if (
      userRole === "client" &&
      ticket.createdBy._id.toString() !== userId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to access this ticket",
      });
    }

    const normalizedTicket = normalizeTicketAssetFields(ticket);

    await cacheService.set(cacheKey, normalizedTicket, CACHE_TTL.SINGLE_TICKET);

    res.status(200).json({
      success: true,
      data: normalizedTicket,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Update a ticket
// @route   PUT /api/tickets/:id
// @access  Private (Admin, SuperAdmin, and Agent)
exports.updateTicket = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket ID format",
      });
    }

    let ticket = await Ticket.findById(id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    const oldStatus = ticket.status;
    const oldAssignedTo = ticket.assignedTo;

    // Update ticket
    ticket = await Ticket.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    // Invalidate caches
    await invalidateTicketCaches(ticket.createdBy, id);

    const io = req.app.get("io");
    if (io) {
      await ticket.populate("createdBy", "firstName lastName email role");
      await ticket.populate("assignedTo", "firstName lastName email role");

      const liveTicketUpdate = {
        ticketId: ticket._id.toString(),
        status: ticket.status,
        updatedAt: ticket.updatedAt
          ? new Date(ticket.updatedAt).toISOString()
          : new Date().toISOString(),
        assignedTo: normalizeSocketUser(ticket.assignedTo),
        createdBy: normalizeSocketUser(ticket.createdBy),
      };

      io.to(`ticket:${ticket._id}`).emit("ticketUpdated", liveTicketUpdate);
      io.to(`user_${ticket.createdBy._id.toString()}`).emit(
        "ticketUpdated",
        liveTicketUpdate,
      );
    }

    // Trigger notifications if status changed
    if (oldStatus !== ticket.status && req.notificationTriggers) {
      await ticket.populate("createdBy", "firstName lastName email");
      req.notificationTriggers
        .handleTicketUpdate(ticket.toObject(), "status changed")
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(200).json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Add a message to a ticket
// @route   POST /api/tickets/:id/messages
// @access  Private
exports.addMessage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket ID format",
      });
    }

    const ticket = await Ticket.findById(id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    // Check authorization
    if (
      req.user.role === "client" &&
      ticket.createdBy.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to access this ticket",
      });
    }

    if (ticket.status === "closed") {
      return res.status(400).json({
        success: false,
        message: "Cannot add messages to a closed ticket",
      });
    }

    // Create message
    const message = new Message({
      ticketId: ticket._id,
      sender: req.user._id,
      content,
    });

    if (req.file) {
      const attachment = await createAttachment(req.file, req.user._id);
      message.attachments.push(attachment._id);
    }

    await message.save();

    // Update ticket
    ticket.messages.push(message._id);
    ticket.updatedAt = Date.now();
    await ticket.save();

    // Populate for response
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "firstName lastName email role")
      .populate("attachments")
      .lean();

    const liveMessage = {
      ...populatedMessage,
      sender: populatedMessage?.sender
        ? {
            ...populatedMessage.sender,
            firstname:
              populatedMessage.sender.firstName ||
              populatedMessage.sender.firstname ||
              "",
            lastname:
              populatedMessage.sender.lastName ||
              populatedMessage.sender.lastname ||
              "",
          }
        : undefined,
      createdAt: populatedMessage?.createdAt
        ? new Date(populatedMessage.createdAt).toISOString()
        : new Date().toISOString(),
      attachments: Array.isArray(populatedMessage?.attachments)
        ? populatedMessage.attachments.map(normalizeAttachmentAssetFields)
        : populatedMessage?.attachments,
    };

    const io = req.app.get("io");
    if (io) {
      io.to(`ticket:${ticket._id}`).emit("newMessage", {
        ticketId: ticket._id.toString(),
        message: liveMessage,
        status: ticket.status,
      });
    }

    // Invalidate caches
    await invalidateTicketCaches(ticket.createdBy, id);

    // Trigger notifications
    if (req.notificationTriggers) {
      await ticket.populate("createdBy", "firstName lastName email");
      req.notificationTriggers
        .handleTicketMessageAdded(populatedMessage, ticket.toObject())
        .catch((err) => console.error("Notification error:", err));
    }

    res.status(201).json({
      success: true,
      data: liveMessage,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get ticket statistics
// @route   GET /api/tickets/stats
// @access  Private (Admin only)
exports.getTicketStats = async (req, res, next) => {
  try {
    const cacheKey = CACHE_KEYS.TICKET_STATS;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setMonth(oneYearAgo.getMonth() - 12);

    // Run aggregations in parallel
    const [statusCounts, monthlyTrends] = await Promise.all([
      Ticket.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]),
      Ticket.aggregate([
        { $match: { createdAt: { $gte: oneYearAgo } } },
        {
          $group: {
            _id: {
              month: { $month: "$createdAt" },
              year: { $year: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    // Initialize stats object
    const stats = {
      totalTickets: 0,
      newTickets: 0,
      openTickets: 0,
      inProgressTickets: 0,
      resolvedTickets: 0,
      closedTickets: 0,
      trends: monthlyTrends.map((item) => ({
        date: `${item._id.year}-${item._id.month}`,
        count: item.count,
      })),
    };

    for (const stat of statusCounts) {
      stats.totalTickets += stat.count;
      switch (stat._id) {
        case "new":
          stats.newTickets = stat.count;
          break;
        case "open":
          stats.openTickets = stat.count;
          break;
        case "inProgress":
          stats.inProgressTickets = stat.count;
          break;
        case "resolved":
          stats.resolvedTickets = stat.count;
          break;
        case "closed":
          stats.closedTickets = stat.count;
          break;
      }
    }

    await cacheService.set(cacheKey, stats, CACHE_TTL.TICKET_STATS);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get ticket statistics for a specific client
// @route   GET /api/tickets/client/:clientId/stats
// @access  Private (Admin only)
exports.getClientTicketStats = async (req, res, next) => {
  try {
    const { clientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid client ID format",
      });
    }

    const cacheKey = CACHE_KEYS.CLIENT_TICKET_STATS(clientId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [totalTickets, openTickets, closedTickets] = await Promise.all([
      Ticket.countDocuments({ createdBy: clientId }),
      Ticket.countDocuments({
        createdBy: clientId,
        status: { $in: ["new", "open", "inProgress"] },
      }),
      Ticket.countDocuments({ createdBy: clientId, status: "closed" }),
    ]);

    const stats = { totalTickets, openTickets, closedTickets };

    await cacheService.set(cacheKey, stats, CACHE_TTL.CLIENT_TICKET_STATS);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Get all tickets for a specific client
// @route   GET /api/tickets/client/:clientId/all
// @access  Private (Admin only)
exports.getClientTickets = async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid client ID format",
      });
    }

    const cacheKey = CACHE_KEYS.CLIENT_TICKETS(clientId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        count: cached.count,
        total: cached.total,
        page: cached.page,
        pages: cached.pages,
        data: cached.data,
        fromCache: true,
      });
    }

    const [tickets, total] = await Promise.all([
      Ticket.find({ createdBy: clientId })
        .populate("createdBy", "firstName lastName email")
        .populate("assignedTo", "firstName lastName email")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Ticket.countDocuments({ createdBy: clientId }),
    ]);

    const normalizedTickets = tickets.map(normalizeTicketAssetFields);
    const totalPages = Math.ceil(total / limitNum);

    const response = {
      success: true,
      count: normalizedTickets.length,
      total,
      page: pageNum,
      pages: totalPages,
      data: normalizedTickets,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.CLIENT_TICKETS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// Invalidate ticket-related caches
const invalidateTicketCaches = async (userId, ticketId = null) => {
  const normalizedUserId = toObjectIdString(userId);
  const promises = [
    cacheService.deletePattern(`tickets:list:${normalizedUserId}:*`),
    cacheService.deletePattern(CACHE_KEYS.TICKET_STATS),
    cacheService.deletePattern(CACHE_KEYS.CLIENT_TICKET_STATS(normalizedUserId)),
    cacheService.deletePattern(`tickets:client:list:${normalizedUserId}*`),
  ];

  if (ticketId) {
    promises.push(
      cacheService.deletePattern(CACHE_KEYS.SINGLE_TICKET(ticketId)),
    );
  }

  await Promise.all(promises);
  console.log(`🗑️ Ticket caches invalidated for user: ${normalizedUserId}`);
};

// Export cache invalidation function
exports.invalidateTicketCaches = invalidateTicketCaches;

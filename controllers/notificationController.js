// Backend/controllers/notificationController.js - SUPER FAST VERSION
const NotificationService = require("../services/notificationService");
const Notification = require("../models/Notification");
const User = require("../models/User");
const mongoose = require("mongoose");

class NotificationController {
  constructor() {
    this.getNotifications = this.getNotifications.bind(this);
    this.getUnreadCount = this.getUnreadCount.bind(this);
    this.markAsRead = this.markAsRead.bind(this);
    this.markAllAsRead = this.markAllAsRead.bind(this);
    this.deleteNotification = this.deleteNotification.bind(this);
    this.getRecentNotifications = this.getRecentNotifications.bind(this);
    this.getNotificationSummary = this.getNotificationSummary.bind(this);
  }

  // Get user notifications
  async getNotifications(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const userId = req.user._id;
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);

      // Get io instance from app
      const io = req.app.get("io");
      if (!io || !io.notificationService) {
        return res.status(500).json({
          success: false,
          message: "Notification service not available",
        });
      }

      const result = await io.notificationService.getUserNotifications(
        userId,
        pageNum,
        limitNum,
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  // Get unread count
  async getUnreadCount(req, res, next) {
    try {
      const userId = req.user._id;
      // Use lean() for better performance
      const unreadCount = await Notification.countDocuments({
        recipient: userId,
        read: false,
      });

      res.status(200).json({
        success: true,
        data: { unreadCount },
      });
    } catch (error) {
      next(error);
    }
  }

  // Mark notification as read
  async markAsRead(req, res, next) {
    try {
      const { notificationId } = req.params;
      const userId = req.user._id;

      if (!mongoose.Types.ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID format",
        });
      }

      // Get io instance from app
      const io = req.app.get("io");
      if (!io || !io.notificationService) {
        return res.status(500).json({
          success: false,
          message: "Notification service not available",
        });
      }

      const notification = await io.notificationService.markAsRead(
        notificationId,
        userId,
      );

      if (!notification) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      // Invalidate unread count cache
      await this.invalidateNotificationCaches(userId);

      res.status(200).json({
        success: true,
        message: "Notification marked as read",
      });
    } catch (error) {
      next(error);
    }
  }

  // Mark all notifications as read
  async markAllAsRead(req, res, next) {
    try {
      const userId = req.user._id;

      // Get io instance from app
      const io = req.app.get("io");
      if (!io || !io.notificationService) {
        return res.status(500).json({
          success: false,
          message: "Notification service not available",
        });
      }

      await io.notificationService.markAllAsRead(userId);

      // Invalidate all notification caches for this user
      await this.invalidateNotificationCaches(userId);

      res.status(200).json({
        success: true,
        message: "All notifications marked as read",
      });
    } catch (error) {
      next(error);
    }
  }

  // Delete notification
  async deleteNotification(req, res, next) {
    try {
      const { notificationId } = req.params;
      const userId = req.user._id;

      if (!mongoose.Types.ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID format",
        });
      }

      // Get io instance from app
      const io = req.app.get("io");
      if (!io || !io.notificationService) {
        return res.status(500).json({
          success: false,
          message: "Notification service not available",
        });
      }

      const notification = await io.notificationService.deleteNotification(
        notificationId,
        userId,
      );

      if (!notification) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      // Invalidate caches
      await this.invalidateNotificationCaches(userId);

      res.status(200).json({
        success: true,
        message: "Notification deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  }

  // Get recent notifications for dashboard (lightweight)
  async getRecentNotifications(req, res, next) {
    try {
      const userId = req.user._id;
      const { limit = 5 } = req.query;
      const limitNum = parseInt(limit);

      const notifications = await Notification.find({ recipient: userId })
        .sort({ createdAt: -1 })
        .limit(limitNum)
        .select("title message type read createdAt")
        .lean();

      res.status(200).json({
        success: true,
        data: notifications,
      });
    } catch (error) {
      next(error);
    }
  }

  // Get notification summary for dashboard
  async getNotificationSummary(req, res, next) {
    try {
      const userId = req.user._id;
      const [unreadCount, totalCount, byType] = await Promise.all([
        Notification.countDocuments({ recipient: userId, read: false }),
        Notification.countDocuments({ recipient: userId }),
        Notification.aggregate([
          { $match: { recipient: new mongoose.Types.ObjectId(userId) } },
          { $group: { _id: "$type", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]),
      ]);

      const summary = {
        unreadCount,
        totalCount,
        topTypes: byType.map((t) => ({ type: t._id, count: t.count })),
      };

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      next(error);
    }
  }

  // Invalidate notification caches for a user
  async invalidateNotificationCaches(userId) {
    return userId;
  }
}

module.exports = new NotificationController();

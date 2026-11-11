// Backend/services/notificationService.js (Updated to work with integrated socket)
const Notification = require("../models/Notification");
const User = require("../models/User");
const emailService = require("./notificationEmailService");
const { notificationEmailTemplate } = require("../utils/emailTemplates");

class NotificationService {
  constructor(io) {
    this.io = io;
  }

  // Create and send notification
  async createNotification({
    recipients,
    title,
    message,
    type,
    priority = "medium",
    data = {},
    relatedModel,
    relatedId,
    sendEmail = true,
  }) {
    try {
      const notifications = [];

      // Ensure recipients is an array
      const recipientIds = Array.isArray(recipients)
        ? recipients
        : [recipients];

      for (const recipientId of recipientIds) {
        const notification = await Notification.create({
          recipient: recipientId,
          title,
          message,
          type,
          priority,
          data,
          relatedModel,
          relatedId,
        });

        await notification.populate("recipient", "firstName lastName email");
        notifications.push(notification);

        // Send real-time notification via WebSocket
        this.sendRealTimeNotification(recipientId, notification);

        // Send email notification
        if (sendEmail) {
          this.sendEmailNotification(notification);
        }
      }

      return notifications;
    } catch (error) {
      console.error("Error creating notification:", error);
      throw error;
    }
  }

  // Send real-time notification via WebSocket (Updated for integrated socket)
  sendRealTimeNotification(userId, notification) {
    try {
      if (this.io) {
        // Use the utility function we added to the socket server
        if (this.io.sendNotificationToUser) {
          this.io.sendNotificationToUser(userId, {
            id: notification._id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            priority: notification.priority,
            data: notification.data,
            timeAgo: notification.timeAgo,
            createdAt: notification.createdAt,
          });
        } else {
          // Fallback to direct room emission
          this.io.to(`user_${userId}`).emit("newNotification", {
            id: notification._id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            priority: notification.priority,
            data: notification.data,
            timeAgo: notification.timeAgo,
            createdAt: notification.createdAt,
          });
        }
      }
    } catch (error) {
      console.error("Error sending real-time notification:", error);
    }
  }

  // Send email notification
  async sendEmailNotification(notification) {
    try {
      if (!notification.recipient.email) return;

      const emailTemplate = this.getEmailTemplate(notification);

      await emailService.sendEmail({
        to: notification.recipient.email,
        subject: notification.title,
        html: emailTemplate,
      });

      // Mark email as sent
      await Notification.findByIdAndUpdate(notification._id, {
        emailSent: true,
        emailSentAt: new Date(),
      });
    } catch (error) {
      console.error("Error sending email notification:", error);
    }
  }

  // Get notification for specific user
  async getUserNotifications(userId, page = 1, limit = 20) {
    try {
      const skip = (page - 1) * limit;

      // These three queries are independent of each other — run them
      // concurrently instead of paying three sequential round trips.
      const [notifications, total, unreadCount] = await Promise.all([
        Notification.find({ recipient: userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("recipient", "firstName lastName"),
        Notification.countDocuments({ recipient: userId }),
        Notification.countDocuments({ recipient: userId, read: false }),
      ]);

      return {
        notifications,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total,
          limit,
        },
        unreadCount,
      };
    } catch (error) {
      console.error("Error getting user notifications:", error);
      throw error;
    }
  }

  // Mark notification as read
  async markAsRead(notificationId, userId) {
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipient: userId },
        { read: true, readAt: new Date() },
        { new: true }
      );

      if (notification && this.io) {
        // Send real-time update
        this.io.to(`user_${userId}`).emit("notificationRead", {
          notificationId: notification._id,
        });
      }

      return notification;
    } catch (error) {
      console.error("Error marking notification as read:", error);
      throw error;
    }
  }

  // Mark all notifications as read for a user
  async markAllAsRead(userId) {
    try {
      await Notification.updateMany(
        { recipient: userId, read: false },
        { read: true, readAt: new Date() }
      );

      // Send real-time update
      if (this.io) {
        this.io.to(`user_${userId}`).emit("allNotificationsRead");
      }

      return true;
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      throw error;
    }
  }

  // Delete notification
  async deleteNotification(notificationId, userId) {
    try {
      const notification = await Notification.findOneAndDelete({
        _id: notificationId,
        recipient: userId,
      });

      if (notification && this.io) {
        // Send real-time update
        this.io.to(`user_${userId}`).emit("notificationDeleted", {
          notificationId: notification._id,
        });
      }

      return notification;
    } catch (error) {
      console.error("Error deleting notification:", error);
      throw error;
    }
  }

  // Get email template for different notification types
  getEmailTemplate(notification) {
    return notificationEmailTemplate(notification);
  }
  // Clean up old notifications (keep last 90 days)
  async cleanupOldNotifications(daysToKeep = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await Notification.deleteMany({
        createdAt: { $lt: cutoffDate },
      });

      return result.deletedCount;
    } catch (error) {
      console.error("Error cleaning up old notifications:", error);
      throw error;
    }
  }

  // Get all admin users
  async getAdminUsers() {
    try {
      return await User.find({
        role: { $in: ["admin", "superadmin"] },
        status: "activated",
      }).select("_id");
    } catch (error) {
      console.error("Error getting admin users:", error);
      return [];
    }
  }
}

module.exports = NotificationService;

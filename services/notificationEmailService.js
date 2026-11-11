// Backend/services/emailService.js - Fixed
const nodemailer = require("nodemailer");
const config = require("../config/config");
const { getBranding } = require("../utils/emailTemplates");

class EmailService {
  constructor() {
    this.transporter = this.createTransporter();
  }

  createTransporter() {
    return nodemailer.createTransport({
      host: config.SMTP_HOST || "email-smtp.eu-north-1.amazonaws.com",
      port: config.SMTP_PORT || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async sendEmail({ to, subject, html, attachments = [] }) {
    try {
      // Check if SMTP credentials are configured
      if (!config.SMTP_USER || !config.SMTP_PASS) {
        console.warn(
          "SMTP credentials not configured. Email will not be sent.",
        );
        return { success: false, message: "SMTP not configured" };
      }

      const mailOptions = {
        from: `"${getBranding().companyName}" <${getBranding().companyEmail}>`,
        to,
        subject,
        html,
        attachments,
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log("Email sent successfully:", result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error("Error sending email:", error);
      return { success: false, error: error.message };
    }
  }

  async verifyConnection() {
    try {
      if (!config.SMTP_USER || !config.SMTP_PASS) {
        console.warn(
          "SMTP credentials not configured. Email service unavailable.",
        );
        return false;
      }

      await this.transporter.verify();
      console.log("Email service is ready");
      return true;
    } catch (error) {
      console.error("Email service error:", error);
      return false;
    }
  }
}

module.exports = new EmailService();

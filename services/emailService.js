const nodemailer = require("nodemailer");
const config = require("../config/config");
const {
  getBranding,
  verificationEmailTemplate,
  passwordResetTemplate,
} = require("../utils/emailTemplates");

// Reuse a single pooled transporter so each send doesn't pay for a fresh
// TCP + TLS + auth handshake (that overhead is what made bulk sends slow).
let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
      pool: true,
      maxConnections: 20,
      maxMessages: 100,
    });
  }
  return transporter;
};

const sendEmail = async (options) => {
  // Define email options
  const { companyName, companyEmail } = getBranding();
  const mailOptions = {
    from: `"${companyName}" <${companyEmail}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    ...(options.attachments ? { attachments: options.attachments } : {}),
  };

  // Send email
  await getTransporter().sendMail(mailOptions);
};

const sendVerificationEmail = async (user, verificationToken) => {
  const verificationURL = `${config.SERVER_URL}/api/auth/verify-email/${verificationToken}`;

  await sendEmail({
    to: user.email,
    subject: `Verify Your Email Address - ${config.COMPANY_NAME}`,
    html: verificationEmailTemplate(
      user.firstName || user.firstname || "there",
      verificationURL,
    ),
  });
};

// Add new function
const sendPasswordResetEmail = async (user, resetToken) => {
  const resetURL = `${config.CLIENT_URL}/reset-password/${resetToken}`;

  console.log("Sending password reset email to:", user.email);
  await sendEmail({
    to: user.email,
    subject: `Password Reset - ${config.COMPANY_NAME}`,
    html: passwordResetTemplate(
      user.firstName || user.firstname || "there",
      resetURL,
    ),
  });
};

// Update module exports
module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};

const nodemailer = require('nodemailer');
const config = require('../config/config');
const { getBranding } = require("./emailTemplates");


/**
 * Send an email using nodemailer
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.message - Email content (HTML)
 * @returns {Promise} - Resolves when email is sent
 */
const sendEmail = async (options) => {
    // Create transporter
    const transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: false,
        auth: {
            user: config.SMTP_USER,
            pass: config.SMTP_PASS
        }
    });

    // Define email options
    const { companyName, companyEmail } = getBranding();
    const mailOptions = {
        from: `"${companyName}" <${companyEmail}>`,
        to: options.to,
        subject: options.subject,
        html: options.html
    };

    // Send email
    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;

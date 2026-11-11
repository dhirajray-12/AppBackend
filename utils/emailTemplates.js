const config = require("../config/config");

const getBranding = () => {
  const companyName = config.COMPANY_NAME || "Test CRM";
  const companyEmail = config.COMPANY_EMAIL || config.EMAIL_FROM || "";

  return {
    companyName,
    companyEmail,
  };
};

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatLabel = (value = "") =>
  String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const detailRow = (label, value, options = {}) => {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const {
    highlight = false,
    monospace = false,
  } = options;

  return `
    <tr>
      <td style="padding: 0 0 12px 0; width: 40%; font-size: 13px; line-height: 20px; color: #64748b; font-weight: 600; vertical-align: top;">
        ${escapeHtml(label)}
      </td>
      <td style="padding: 0 0 12px 12px; font-size: 14px; line-height: 20px; color: ${
        highlight ? "#0f172a" : "#1e293b"
      }; font-weight: ${highlight ? "700" : "500"}; font-family: ${
        monospace ? "'Courier New', monospace" : "Arial, sans-serif"
      }; vertical-align: top; word-break: break-word;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
};

const sectionCard = (title, rowsHtml) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
    <tr>
      <td style="padding: 22px 22px 10px 22px;">
        <div style="font-size: 16px; line-height: 24px; font-weight: 700; color: #0f172a;">${escapeHtml(
          title,
        )}</div>
      </td>
    </tr>
    <tr>
      <td style="padding: 0 22px 10px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rowsHtml}
        </table>
      </td>
    </tr>
  </table>
`;

const infoBox = (text, tone = "info") => {
  const palette = {
    info: {
      background: "#eff6ff",
      border: "#bfdbfe",
      color: "#1d4ed8",
    },
    warning: {
      background: "#fff7ed",
      border: "#fdba74",
      color: "#c2410c",
    },
    danger: {
      background: "#fef2f2",
      border: "#fca5a5",
      color: "#b91c1c",
    },
    success: {
      background: "#ecfdf5",
      border: "#86efac",
      color: "#047857",
    },
  }[tone];

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0; border-radius: 14px; border: 1px solid ${palette.border}; background: ${palette.background};">
      <tr>
        <td style="padding: 16px 18px; font-size: 14px; line-height: 22px; color: ${palette.color}; font-weight: 600;">
          ${escapeHtml(text)}
        </td>
      </tr>
    </table>
  `;
};

const actionButton = (label, url, accent = "#0f766e") => `
  <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 28px auto;">
    <tr>
      <td align="center" bgcolor="${accent}" style="border-radius: 999px;">
        <a
          href="${url}"
          style="display: inline-block; padding: 15px 28px; font-size: 15px; line-height: 20px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 999px;"
        >
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>
`;

const renderEmailLayout = ({
  preheader,
  eyebrow,
  title,
  greeting,
  intro,
  sections = "",
  callout = "",
  button = "",
  footerNote,
}) => {
  const { companyName, companyEmail } = getBranding();

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin: 0; padding: 0; min-width: 100%; background: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #1e293b;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
      ${escapeHtml(preheader || title)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #f8fafc; margin: 0; padding: 0;">
      <tr>
        <td align="center" style="padding: 24px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px; overflow: hidden;">
            <tr>
              <td style="padding: 0; background: linear-gradient(135deg, #0f766e 0%, #0f172a 100%);">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 28px 24px 24px 24px;">
                      <div style="font-size: 12px; line-height: 18px; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(255,255,255,0.74); font-weight: 700;">
                        ${escapeHtml(companyName)}
                      </div>
                      <div style="margin-top: 10px; font-size: 28px; line-height: 36px; color: #ffffff; font-weight: 700;">
                        ${escapeHtml(title)}
                      </div>
                      <div style="margin-top: 8px; font-size: 14px; line-height: 22px; color: rgba(255,255,255,0.82);">
                        ${escapeHtml(eyebrow)}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding: 28px 24px 8px 24px;">
                <div style="font-size: 20px; line-height: 28px; color: #0f172a; font-weight: 700; margin-bottom: 12px;">
                  ${escapeHtml(greeting)}
                </div>
                <div style="font-size: 15px; line-height: 25px; color: #475569; margin-bottom: 24px;">
                  ${escapeHtml(intro)}
                </div>
                ${button}
                ${callout}
                ${sections}
              </td>
            </tr>

            <tr>
              <td style="padding: 8px 24px 28px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #e2e8f0;">
                  <tr>
                    <td style="padding-top: 20px; font-size: 13px; line-height: 22px; color: #64748b;">
                      ${escapeHtml(
                        footerNote ||
                          `This is an automated message from ${companyName}. If you need help, contact ${companyEmail || "our support team"}.`,
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding-top: 10px; font-size: 12px; line-height: 20px; color: #94a3b8;">
                      © ${new Date().getFullYear()} ${escapeHtml(companyName)}. All rights reserved.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
};

const verificationEmailTemplate = (name, url) =>
  renderEmailLayout({
    preheader: "Verify your email address to complete registration.",
    eyebrow: "Email verification required",
    title: "Verify Your Email",
    greeting: `Hi ${name || "there"},`,
    intro:
      "Thank you for registering. Please confirm your email address to activate your access and finish setting up your account.",
    button: actionButton("Verify Email", url, "#0f766e"),
    callout: infoBox("This verification link will expire in 24 hours.", "warning"),
    sections: sectionCard(
      "What happens next",
      [
        detailRow("Step 1", "Open the verification link above."),
        detailRow("Step 2", "Your email will be marked as verified."),
        detailRow("Step 3", "You can continue using your account normally."),
      ].join(""),
    ),
    footerNote:
      "If you did not create this account, you can safely ignore this email.",
  });

const passwordResetTemplate = (name, url) =>
  renderEmailLayout({
    preheader: "Reset your password securely.",
    eyebrow: "Password reset request",
    title: "Reset Your Password",
    greeting: `Hi ${name || "there"},`,
    intro:
      "We received a request to reset your password. Use the button below to choose a new password securely.",
    button: actionButton("Reset Password", url, "#b91c1c"),
    callout: infoBox("This password reset link will expire in 10 minutes.", "danger"),
    sections: sectionCard(
      "Security reminder",
      [
        detailRow(
          "Important",
          "If you did not request a password reset, ignore this email and keep your current password.",
        ),
      ].join(""),
    ),
  });

const withdrawalOtpTemplate = ({
  userName,
  otp,
  account,
  amount,
  paymentMethod,
  isResend = false,
}) =>
  renderEmailLayout({
    preheader: "Use this OTP to verify your withdrawal request.",
    eyebrow: isResend ? "Withdrawal OTP resent" : "Withdrawal OTP verification",
    title: "Verify Your Withdrawal",
    greeting: `Hi ${userName || "there"},`,
    intro: isResend
      ? "Here is your new OTP for the pending withdrawal request."
      : "Use the one-time password below to verify your withdrawal request securely.",
    callout: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0; border-radius: 18px; border: 2px solid #99f6e4; background: #f0fdfa;">
        <tr>
          <td align="center" style="padding: 22px;">
            <div style="font-size: 12px; line-height: 18px; color: #0f766e; text-transform: uppercase; letter-spacing: 0.18em; font-weight: 700;">One-Time Password</div>
            <div style="margin-top: 8px; font-size: 34px; line-height: 40px; letter-spacing: 0.28em; font-weight: 700; color: #0f172a; font-family: 'Courier New', monospace;">
              ${escapeHtml(otp)}
            </div>
            <div style="margin-top: 10px; font-size: 13px; line-height: 20px; color: #0f766e; font-weight: 600;">This OTP will expire in 5 minutes.</div>
          </td>
        </tr>
      </table>
      ${infoBox(
        "If you did not request this withdrawal, contact support immediately and do not share this OTP with anyone.",
        "danger",
      )}
    `,
    sections: sectionCard(
      "Withdrawal details",
      [
        detailRow("Account", account, { monospace: true }),
        detailRow("Amount", `$${amount}`),
        detailRow("Payment method", paymentMethod),
        detailRow("Requested at", new Date().toLocaleString()),
      ].join(""),
    ),
  });

const notificationEmailTemplate = ({
  type,
  title,
  message,
  recipient,
  data = {},
}) => {
  const firstName = recipient?.firstname || recipient?.firstName || "";
  const lastName = recipient?.lastname || recipient?.lastName || "";
  const userName = `${firstName} ${lastName}`.trim() || "there";

  const palette = {
    account_created: { eyebrow: "Trading account update", accent: "#0f766e" },
    deposit_status: { eyebrow: "Deposit notification", accent: "#0369a1" },
    withdrawal_status: { eyebrow: "Withdrawal notification", accent: "#b45309" },
    transfer_success: { eyebrow: "Transfer notification", accent: "#0f766e" },
    ticket_update: { eyebrow: "Support notification", accent: "#7c3aed" },
    password_changed: { eyebrow: "Security notification", accent: "#b91c1c" },
    new_signup: { eyebrow: "Registration notification", accent: "#0f766e" },
    profile_update: { eyebrow: "Profile update", accent: "#475569" },
    kyc_status: { eyebrow: "KYC notification", accent: "#0f766e" },
  }[type] || { eyebrow: "Account notification", accent: "#0f766e" };

  let sections = "";
  let callout = "";

  switch (type) {
    case "account_created":
      sections = sectionCard(
        "Account details",
        [
          detailRow("MT5 account", data.mt5Account, { monospace: true }),
          detailRow("Account type", data.accountType),
          detailRow("Leverage", data.leverage),
          detailRow("Platform", data.platform),
          detailRow("Investor password", data.investorPassword, {
            monospace: true,
          }),
          detailRow("Master password", data.masterPassword, {
            monospace: true,
          }),
          detailRow("Server name", data.serverName),
        ].join(""),
      );
      break;

    case "deposit_status":
      sections = sectionCard(
        "Deposit details",
        [
          detailRow("Amount", data.amount ? `$${data.amount}` : undefined, {
            highlight: true,
          }),
          detailRow("Status", data.status, { highlight: true }),
          detailRow("Payment method", data.paymentMethod),
          detailRow("Remarks", data.remarks),
        ].join(""),
      );
      break;

    case "withdrawal_status":
      sections = sectionCard(
        "Withdrawal details",
        [
          detailRow("Amount", data.amount ? `$${data.amount}` : undefined, {
            highlight: true,
          }),
          detailRow("Status", data.status, { highlight: true }),
          detailRow("Remarks", data.remarks),
        ].join(""),
      );
      break;

    case "transfer_success":
      sections = sectionCard(
        "Transfer details",
        [
          detailRow("Amount", data.amount ? `$${data.amount}` : undefined, {
            highlight: true,
          }),
          detailRow("From account", data.fromAccount, { monospace: true }),
          detailRow("To account", data.toAccount, { monospace: true }),
        ].join(""),
      );
      break;

    case "ticket_update":
      sections = sectionCard(
        "Ticket details",
        [
          detailRow("Ticket number", data.ticketNumber, { monospace: true }),
          detailRow("Subject", data.subject),
          detailRow("Status", data.status),
          detailRow("Update type", formatLabel(data.updateType)),
          detailRow("Message", data.messagePreview),
        ].join(""),
      );
      break;

    case "password_changed":
      sections = sectionCard(
        "Security details",
        [
          detailRow("MT5 account", data.mt5Account, { monospace: true }),
          detailRow("Account type", data.accountType),
          detailRow(
            "Changed fields",
            Array.isArray(data.changedPasswords)
              ? data.changedPasswords.join(", ")
              : data.changedPasswords,
          ),
          detailRow("Platform", data.platform),
          detailRow("Date", data.changeDate),
          detailRow("Time", data.changeTime),
        ].join(""),
      );
      callout = infoBox(
        "If you did not make this password change, contact support immediately.",
        "danger",
      );
      break;

    case "new_signup":
      sections = sectionCard(
        "Registration details",
        [
          detailRow("Name", data.userName),
          detailRow("Email", data.email),
          detailRow("User type", data.isIBUser ? "IB Partner" : "Client"),
          detailRow("Referral code", data.referredBy),
          detailRow("Signup date", data.signupDate),
        ].join(""),
      );
      break;

    case "profile_update":
      sections = sectionCard(
        "Profile update details",
        [
          detailRow("Client name", data.clientName),
          detailRow("Client email", data.clientEmail),
          detailRow("Update date", data.updateDate),
        ].join(""),
      );
      break;

    case "kyc_status":
      sections = sectionCard(
        "KYC details",
        [
          detailRow("Status", formatLabel(data.status), { highlight: true }),
          detailRow("Submitted at", data.submittedAt),
          detailRow("Reviewed at", data.reviewedAt),
          detailRow("Review note", data.reason || data.remarks),
        ].join(""),
      );

      if (data.status === "rejected") {
        callout = infoBox(
          data.reason ||
            "Your KYC submission needs changes before it can be approved.",
          "danger",
        );
      } else if (data.status === "submitted") {
        callout = infoBox(
          "Your KYC documents were submitted successfully and are now under review.",
          "info",
        );
      } else if (data.status === "approved") {
        callout = infoBox(
          "Your KYC verification has been approved successfully.",
          "success",
        );
      }
      break;

    default:
      sections = sectionCard(
        "Details",
        detailRow("Notification", "Please check your account for more information."),
      );
      break;
  }

  return renderEmailLayout({
    preheader: title,
    eyebrow: palette.eyebrow,
    title,
    greeting: `Hi ${userName},`,
    intro: message,
    sections,
    callout,
    footerNote: undefined,
  }).replace(/#0f766e/g, palette.accent);
};

const customAdminEmailTemplate = ({ name, subject, bodyHtml }) =>
  renderEmailLayout({
    preheader: subject,
    eyebrow: "Message from our team",
    title: subject,
    greeting: `Hi ${name || "there"},`,
    intro: "",
    sections: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
        <tr>
          <td style="font-size: 15px; line-height: 25px; color: #1e293b;">
            ${bodyHtml}
          </td>
        </tr>
      </table>
    `,
  });

module.exports = {
  getBranding,
  escapeHtml,
  verificationEmailTemplate,
  passwordResetTemplate,
  withdrawalOtpTemplate,
  notificationEmailTemplate,
  customAdminEmailTemplate,
};

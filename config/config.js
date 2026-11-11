// backend/config/config.js
require("dotenv").config();

const config = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRE: process.env.JWT_EXPIRE || "30d",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRE: process.env.JWT_REFRESH_EXPIRE || "30d",
  EMAIL_SERVICE: process.env.EMAIL_SERVICE || "ses",
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM,
  COMPANY_NAME: process.env.COMPANY_NAME || "Test CRM",
  COMPANY_EMAIL: process.env.COMPANY_EMAIL || process.env.EMAIL_FROM,
  CLIENT_URL: process.env.CLIENT_URL,
  SERVER_URL: process.env.SERVER_URL,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  CLOUDINARY_URL: process.env.CLOUDINARY_URL,
  // Google Sign-In (see controllers/authController.js `google`) — the
  // OAuth client ID(s) an ID token's `aud` claim must match. Not required
  // at boot (validateConfig below doesn't fail without it) since Google
  // sign-in is optional: the endpoint itself returns a clear 503 if this
  // is unset, rather than the whole server refusing to start over a
  // feature that may not be configured yet. Accepts a comma-separated
  // list so the same backend can serve both an Android and a Web/iOS
  // OAuth client ID (Google issues a different client ID per platform).
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
};

const validateConfig = () => {
  const missing = [];

  if (!config.MONGO_URI) {
    missing.push("MONGO_URI");
  }

  if (!config.JWT_SECRET) {
    missing.push("JWT_SECRET");
  }

  if (!config.JWT_REFRESH_SECRET) {
    missing.push("JWT_REFRESH_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return config;
};

module.exports = {
  ...config,
  validateConfig,
};

// backend/middlewares/apiKeyAuth.js
const { AuthenticationError } = require("./errorHandler");

// Verifies a shared-secret API key sent via the x-api-key header.
// Used for server-to-server / internal endpoints that skip user JWT auth.
const apiKeyAuth = (req, res, next) => {
  const providedKey = req.headers["x-api-key"];

  if (!providedKey || providedKey !== process.env.INTERNAL_API_KEY) {
    return next(new AuthenticationError("Invalid or missing API key"));
  }

  next();
};

module.exports = apiKeyAuth;

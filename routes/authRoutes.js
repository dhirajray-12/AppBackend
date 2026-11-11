// backend/routes/authRoutes.js
const express = require("express");
const {
  signup,
  verifyEmail,
  login,
  adminSignup,
  agentSignup,
  forgotPassword,
  resetPassword,
  impersonateClient,
  checkVerificationStatus,
  resendVerificationEmail,
  checkUserRole,
  refreshToken,
  logout,
  getUserByPhone,
  google,
} = require("../controllers/authController");
const { validate, schemas } = require("../middlewares/validationMiddleware");
const { protect, authorize } = require("../middlewares/auth");
const apiKeyAuth = require("../middlewares/apiKeyAuth");

const router = express.Router();

router.post("/signup", validate(schemas.signup), signup);
router.post("/admin/signup", protect, authorize("superadmin"), adminSignup);
router.post(
  "/agent/signup",
  protect,
  authorize("admin", "superadmin"),
  validate(schemas.agentSignup),
  agentSignup,
);
router.get("/verify-email/:token", verifyEmail);
// GET so it's exempt from CSRF verification by definition; its only job is
// to let the frontend guarantee a csrf_token cookie exists (via the global
// ensureCsrfCookie middleware) before firing a mutating request.
router.get("/csrf-token", (req, res) => {
  res.status(200).json({ success: true });
});
(router.get("/me", protect, (req, res) => {
  res.status(200).json({
    ...req.user.toObject(),
    suspension: req.suspensionState || null,
  });
}),
  router.post("/check-verification-status", checkVerificationStatus));
router.post("/resend-verification", resendVerificationEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post(
  "/admin/impersonate/:clientId",
  protect,
  authorize("admin", "superadmin"),
  impersonateClient,
);

router.post("/login", validate(schemas.login), login); // Updated to handle role-based login
// Client-only "Continue with Google" — see the `google` controller's own
// doc comment. Not wrapped in `validate(schemas...)`: its only required
// field (idToken) is checked directly in the controller since there's no
// existing Joi schema for it and adding a whole schemas.google entry for
// one string field isn't worth the indirection.
router.post("/google", google);
router.post("/refresh", refreshToken);
router.post("/check-role", checkUserRole); // New endpoint to check user role
router.post(
  "/user-by-phone",
  apiKeyAuth,
  validate(schemas.getUserByPhone),
  getUserByPhone,
); // Requires x-api-key header instead of user JWT auth
router.post("/logout", protect, logout);

module.exports = router;

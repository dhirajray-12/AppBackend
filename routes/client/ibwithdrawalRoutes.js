// Backend/routes/client/ibwithdrawalRoutes.js (or ibWithdrawalRoutes.js)
const express = require("express");
const router = express.Router();
const {
  getProfileDetails,
  requestWithdrawal,
  getWithdrawalHistory,
  cancelWithdrawal,
} = require("../../controllers/client/ibWithdrawalController");
const { protect, authorize } = require("../../middlewares/auth");

// Debug logging
console.log("✓ IB Withdrawal Routes module loaded");

// Apply authentication middleware to all routes
router.use(protect);
router.use(authorize("client"));

// @route   GET /api/ibclients/withdrawals/profile-details
// @desc    Get user profile details for withdrawal form
// @access  Private (Client)
router.get(
  "/profile-details",
  (req, res, next) => {
    console.log("📥 Hit route: GET /api/ibclients/withdrawals/profile-details");
    next();
  },
  getProfileDetails
);

// @route   POST /api/ibclients/withdrawals/request
// @desc    Request IB commission withdrawal
// @access  Private (Client)
router.post(
  "/request",
  (req, res, next) => {
    console.log("📥 Hit route: POST /api/ibclients/withdrawals/request");
    next();
  },
  requestWithdrawal
);

// @route   GET /api/ibclients/withdrawals/history
// @desc    Get user's withdrawal history
// @access  Private (Client)
router.get(
  "/history",
  (req, res, next) => {
    console.log("📥 Hit route: GET /api/ibclients/withdrawals/history");
    next();
  },
  getWithdrawalHistory
);

// @route   DELETE /api/ibclients/withdrawals/:withdrawalId
// @desc    Cancel pending withdrawal request
// @access  Private (Client)
router.delete(
  "/:withdrawalId",
  (req, res, next) => {
    console.log(
      "📥 Hit route: DELETE /api/ibclients/withdrawals/:withdrawalId"
    );
    next();
  },
  cancelWithdrawal
);

module.exports = router;

// BACKEND\routes\copyCopierRoutes.js
const express = require("express");
const router = express.Router();
const {
  getMastersAndCopiers,
  getTradeHistory,
  getCopierDetails,
  unlinkCopier,
  checkOpenTrades,
} = require("../../controllers/client/copyCopierController");
const { protect, authorize } = require("../../middlewares/auth");

// Protect all routes
router.use(protect);
router.use(authorize("client", "admin"));

// @desc    Get all masters and their copiers
// @route   POST /api/copy-trading/masters-copiers
// @access  Private (Client only)
router.get("/masters-copiers", getMastersAndCopiers);

// @desc    Get trade history for copier accounts
// @route   POST /api/copy-trading/trade-history
// @access  Private (Client only)
router.post("/trade-history", getTradeHistory);

// @desc    Check if copier has open trades
// @route   POST /api/copy-trading/check-open-trades
// @access  Private (Client only)
router.post("/check-open-trades", checkOpenTrades);

// @desc    Get details for a specific copier account
// @route   GET /api/copy-trading/details/:mt5Account
// @access  Private (Client/Admin)
router.get("/details/:mt5Account", getCopierDetails);

// @desc    Unlink copier account
// @route   DELETE /api/copy-trading/unlink-copier
// @access  Private (Client only)
router.delete("/unlink-copier", unlinkCopier);

module.exports = router;

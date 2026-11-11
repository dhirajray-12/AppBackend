const express = require("express");
const router = express.Router();
const { protect } = require("../../middlewares/auth");
const {
  getAccountStatement,
  getConsolidatedStatement,
  getMonthlySummary,
  getYTDSummary,
  getTransactionHistory,
} = require("../../controllers/client/statementController");

// All routes require authentication
router.use(protect);

// Statement routes
router.get("/account/:accountId", getAccountStatement);
router.get("/consolidated", getConsolidatedStatement);
router.get("/monthly-summary", getMonthlySummary);
router.get("/ytd-summary", getYTDSummary);
router.get("/transaction-history", getTransactionHistory);

module.exports = router;

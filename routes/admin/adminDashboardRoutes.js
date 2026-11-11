// Backend/routes/admin/adminDashboardRoutes.js
const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getAdminDashboardStats,
  getRevenueChartData,
  getClientDistribution,
  getAccountsByType,
  getRecentTransactions,
  getDailyStats,
  getTopPerformingClients,
  getTodayPerformance,
  getClientDeviceSessionsOverview,
  getRiskExposure,
  getRiskThresholdsConfig,
  updateRiskThresholdsConfig,
} = require("../../controllers/admin/adminDashboardController");

// Protect all routes and authorize only admin/superadmin/subadmin
router.use(protect);
router.use(authorize("admin", "superadmin", "subadmin"));
router.use(authorizePermission(PERMISSIONS.DASHBOARD_VIEW));

/**
 * @route   GET /api/admin/dashboard/stats
 * @desc    Get admin dashboard overview statistics
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/stats", getAdminDashboardStats);

/**
 * @route   GET /api/admin/dashboard/revenue-chart
 * @desc    Get revenue chart data for last 12 months
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/revenue-chart", getRevenueChartData);

/**
 * @route   GET /api/admin/dashboard/client-distribution
 * @desc    Get client distribution by account type
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/client-distribution", getClientDistribution);

/**
 * @route   GET /api/admin/dashboard/client-distribution/:type
 * @desc    Get paginated accounts by account type
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/client-distribution/:type", getAccountsByType);

/**
 * @route   GET /api/admin/dashboard/recent-transactions
 * @desc    Get recent transactions for dashboard
 * @access  Private (Admin/SuperAdmin)
 * @query   limit - Number of transactions to return (default: 10)
 */
router.get("/recent-transactions", getRecentTransactions);

/**
 * @route   GET /api/admin/dashboard/daily-stats
 * @desc    Get daily statistics for the last 30 days
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/daily-stats", getDailyStats);

/**
 * @route   GET /api/admin/dashboard/top-clients
 * @desc    Get top performing clients by total deposits
 * @access  Private (Admin/SuperAdmin)
 * @query   limit - Number of clients to return (default: 10)
 */
router.get("/top-clients", getTopPerformingClients);
router.get("/today-performance", getTodayPerformance);
router.get("/device-sessions", getClientDeviceSessionsOverview);

/**
 * @route   GET /api/admin/dashboard/risk-exposure
 * @desc    Live floating P&L and per-symbol net exposure, aggregated from
 *          the warm open-trade cache. Scoped to currently-active traders
 *          (see openTradeSyncService) - not a full-book snapshot of every
 *          client, only whoever has viewed their trades in the last 60s.
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/risk-exposure", getRiskExposure);

/**
 * @route   GET/PUT /api/admin/dashboard/risk-thresholds
 * @desc    Configurable alert thresholds for the risk-exposure widget
 *          (max floating loss, max net lots per symbol). Off by default.
 * @access  Private (Admin/SuperAdmin)
 */
router.get("/risk-thresholds", getRiskThresholdsConfig);
router.put("/risk-thresholds", updateRiskThresholdsConfig);

module.exports = router;

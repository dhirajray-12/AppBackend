// Backend/routes/admin/revenueAnalyticsRoutes.js
const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getRevenueAnalytics,
  getRevenueTimeSeries,
} = require("../../controllers/admin/revenueAnalyticsController");

// Protect all routes and authorize only admin/superadmin/subadmin
router.use(protect);
router.use(authorize("admin", "superadmin", "subadmin"));
router.use(authorizePermission(PERMISSIONS.REVENUE_ANALYTICS_VIEW));

/**
 * @route   GET /api/admin/revenue-analytics
 * @desc    Get revenue analytics summary with time filter
 * @access  Private (Admin/SuperAdmin)
 * @query   days - Number of days to analyze (7, 14, 30, 60, 90)
 */
console.log("Hey, i am going to call below routes")
router.get("/", getRevenueAnalytics);

/**
 * @route   GET /api/admin/revenue-analytics/timeseries
 * @desc    Get time-series data for charts
 * @access  Private (Admin/SuperAdmin)
 * @query   days - Number of days to analyze (7, 14, 30, 60, 90)
 * @query   granularity - Data granularity (daily, weekly)
 */
router.get("/timeseries", getRevenueTimeSeries);

module.exports = router;

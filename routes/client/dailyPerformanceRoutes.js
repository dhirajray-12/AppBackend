// Backend/routes/client/dailyPerformanceRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/auth');
const {
    getDailyPerformanceTrends,
    getTodayPerformance
} = require('../../controllers/client/dailyPerformanceController');

// Apply authentication middleware to all routes
router.use(protect);

// @route   GET /api/daily-performance/trends
// @desc    Get daily performance trends for last X days
// @access  Private (Client)
// @params  days (optional, default: 30)
router.get('/trends', getDailyPerformanceTrends);

// @route   GET /api/daily-performance/today
// @desc    Get today's performance summary
// @access  Private (Client)
router.get('/today', getTodayPerformance);

module.exports = router;
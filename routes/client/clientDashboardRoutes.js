// Backend/routes/client/clientDashboardRoutes.js
const express = require('express');
const router = express.Router();
const {
    getDashboardOverview,
    getRecentTransactions,
    getActiveAccounts,
    getAccountPerformance,
    getIBCommissionStats
    // getTransactionHistory,
    // getAccountDetails
} = require('../../controllers/client/clientDashboardController');
const { protect } = require('../../middlewares/auth');
const {
    getMyDeviceSessions,
    updateMyDeviceTrust,
    logoutMyDeviceSession,
} = require('../../controllers/deviceSessionController');

// Apply authentication middleware to all routes
router.use(protect);

// @route   GET /api/client/dashboard/overview
// @desc    Get dashboard overview statistics
// @access  Private (Client)
router.get('/overview', getDashboardOverview);

// @route   GET /api/client/dashboard/transactions
// @desc    Get recent transactions
// @access  Private (Client)
router.get('/transactions', getRecentTransactions);

// @route   GET /api/client/dashboard/accounts
// @desc    Get active accounts with search and filter
// @access  Private (Client)
router.get('/accounts', getActiveAccounts);

// @route   GET /api/client/dashboard/performance
// @desc    Get account performance data
// @access  Private (Client)
router.get('/performance', getAccountPerformance);

// @route   GET /api/client/dashboard/devices
// @desc    Get current client's device sessions
// @access  Private
router.get('/devices', getMyDeviceSessions);

// @route   PATCH /api/client/dashboard/devices/:sessionId/trust
// @desc    Trust or untrust a device session
// @access  Private
router.patch('/devices/:sessionId/trust', updateMyDeviceTrust);

// @route   POST /api/client/dashboard/devices/:sessionId/logout
// @desc    Force logout one of the client's sessions
// @access  Private
router.post('/devices/:sessionId/logout', logoutMyDeviceSession);


module.exports = router;

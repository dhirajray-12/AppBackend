// Backend/routes/admin/ibWithdrawalRoutes.js
const express = require('express');
const router = express.Router();
const {
    getAllWithdrawals,
    getWithdrawalDetails,
    approveWithdrawal,
    rejectWithdrawal,
    getWithdrawalStats
} = require('../../controllers/admin/ibWithdrawalController');
const { protect, authorize, authorizePermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../constants/permissions');

// Apply authentication middleware to all routes
router.use(protect);
router.use(authorize('admin', 'superadmin', 'subadmin'));

// @route   GET /api/admin/ib-withdrawals
// @desc    Get all withdrawal requests with filters
// @access  Private (Admin)
router.get('/', authorizePermission(PERMISSIONS.IB_WITHDRAWAL_VIEW), getAllWithdrawals);

// @route   GET /api/admin/ib-withdrawals/stats
// @desc    Get withdrawal statistics
// @access  Private (Admin)
router.get('/stats', authorizePermission(PERMISSIONS.IB_WITHDRAWAL_VIEW), getWithdrawalStats);

// @route   GET /api/admin/ib-withdrawals/:withdrawalId
// @desc    Get withdrawal details by ID
// @access  Private (Admin)
router.get('/:withdrawalId', authorizePermission(PERMISSIONS.IB_WITHDRAWAL_VIEW), getWithdrawalDetails);

// @route   PUT /api/admin/ib-withdrawals/:withdrawalId/approve
// @desc    Approve withdrawal request
// @access  Private (Admin)
router.put('/:withdrawalId/approve', authorizePermission(PERMISSIONS.IB_WITHDRAWAL_APPROVE), approveWithdrawal);

// @route   PUT /api/admin/ib-withdrawals/:withdrawalId/reject
// @desc    Reject withdrawal request
// @access  Private (Admin)
router.put('/:withdrawalId/reject', authorizePermission(PERMISSIONS.IB_WITHDRAWAL_APPROVE), rejectWithdrawal);

module.exports = router;
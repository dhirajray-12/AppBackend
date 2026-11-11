// backend/routes/admin/ibClientConfigurationRoutes.js
const express = require('express');
const {
    createIBConfiguration,
    getMyIBConfiguration,
    getIBDashboardSummary,
    getPartnersList,
    verifyReferralCode,
    getIBTree,
    getPartnersAccounts,
    getPendingDownlineAssignments,
    assignDownlineCommission
} = require('../../controllers/client/ibClientConfigurationController');
const { protect, authorize } = require('../../middlewares/auth');

const router = express.Router();

// Public route for verifying referral codes (used during signup)
router.post('/verify-referral', verifyReferralCode);

// Client routes
router.post('/create', protect, authorize('client'), createIBConfiguration);
router.get('/my-code', protect, authorize('client'), getMyIBConfiguration);
router.get('/dashboard', protect, authorize('client'), getIBDashboardSummary);
router.get('/partners', protect, authorize('client'), getPartnersList);
router.get('/tree', protect, authorize('client'), getIBTree);
// Get accounts for a specific user
router.get('/user/partners-accounts', protect, authorize('client', 'admin'), getPartnersAccounts);
// Sub-IB commission assignment (direct downline)
router.get('/downline/pending', protect, authorize('client'), getPendingDownlineAssignments);
router.patch('/downline/:childConfigId/commission', protect, authorize('client'), assignDownlineCommission);
module.exports = router;
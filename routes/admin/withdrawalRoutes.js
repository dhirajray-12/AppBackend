// Backend\routes\admin\withdrawalRoutes.js

const express = require('express');
const router = express.Router();
const { getAllWithdrawals,
    approveWithdrawal,
    rejectWithdrawal } = require('../../controllers/admin/withdrawalController');
const { protect, authorize, authorizePermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../constants/permissions');

router.use(protect);
router.use(authorize('admin', 'superadmin', 'subadmin'));

router.get('/', authorizePermission(PERMISSIONS.WITHDRAWALS_VIEW), getAllWithdrawals);
router.patch('/:id/approve', authorizePermission(PERMISSIONS.WITHDRAWALS_APPROVE), approveWithdrawal);
router.patch('/:id/reject', authorizePermission(PERMISSIONS.WITHDRAWALS_APPROVE), rejectWithdrawal);

module.exports = router;

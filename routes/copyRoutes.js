// Backend\routes\copyRoutes.js
const express = require('express');
const {
    createCopyRequest,
    getUserCopyRequests,
    getAllCopyRequests,
    acceptCopyRequest,
    rejectCopyRequest,
    getCopyRequestDetails
} = require('../controllers/copyController');
const { protect, authorize, authorizePermission } = require('../middlewares/auth');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Client routes
router.post('/request', protect, createCopyRequest);
router.get('/my-requests', protect, getUserCopyRequests);

// Admin routes
router.get('/admin/requests', protect, authorize('admin', 'superadmin', 'subadmin'), authorizePermission(PERMISSIONS.COPY_COPIER_VIEW), getAllCopyRequests);
router.get('/admin/request/:id', protect, authorize('admin', 'superadmin', 'subadmin'), authorizePermission(PERMISSIONS.COPY_COPIER_VIEW), getCopyRequestDetails);
router.put('/admin/accept/:id', protect, authorize('admin', 'superadmin', 'subadmin'), authorizePermission(PERMISSIONS.COPY_COPIER_EDIT), acceptCopyRequest);
router.put('/admin/reject/:id', protect, authorize('admin', 'superadmin', 'subadmin'), authorizePermission(PERMISSIONS.COPY_COPIER_EDIT), rejectCopyRequest);

module.exports = router;
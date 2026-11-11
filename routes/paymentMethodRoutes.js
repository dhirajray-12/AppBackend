//Backend\routes\paymentMethodRoutes.js

const express = require('express');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

const {
    getPaymentMethods,
    createPaymentMethod,
    updatePaymentMethod,
    deletePaymentMethod,
    uploadPaymentMethodQR,
    getPaymentMethodDetails
} = require('../controllers/paymentMethodController');
const { protect, authorize, authorizePermission } = require('../middlewares/auth');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Payment Method Routes
router.route('/')
    .get(protect, authorize('admin', 'subadmin'), authorizePermission(PERMISSIONS.PAYMENTS_VIEW), getPaymentMethods)
    .post(protect, authorize('admin', 'subadmin'), authorizePermission(PERMISSIONS.PAYMENTS_EDIT), createPaymentMethod);

router.route('/:id')
    .get(protect, authorize('admin', 'subadmin'), authorizePermission(PERMISSIONS.PAYMENTS_VIEW), getPaymentMethodDetails)
    .put(protect, authorize('admin', 'subadmin'), authorizePermission(PERMISSIONS.PAYMENTS_EDIT), updatePaymentMethod)
    .delete(protect, authorize('admin', 'subadmin'), authorizePermission(PERMISSIONS.PAYMENTS_EDIT), deletePaymentMethod);

router.post(
    '/:id/upload-qr',
    protect,
    authorize('admin', 'subadmin'),
    authorizePermission(PERMISSIONS.PAYMENTS_EDIT),
    uploadPaymentMethodQR
);

module.exports = router;
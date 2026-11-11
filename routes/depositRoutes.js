// Backend\routes\depositRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const {
    uploadProofOfPayment,
    createDeposit,
    getMyDeposits,
    getDepositById,
    getActivePaymentMethods
} = require('../controllers/client/depositController');
const { createStripeCheckout } = require('../controllers/client/stripeDepositController');

// Card deposit through Stripe Checkout: returns the page to redirect to.
router.post('/stripe/checkout', protect, createStripeCheckout);

// Routes
router.route('/')
    .post(protect, uploadProofOfPayment, createDeposit)
    .get(protect, getMyDeposits);

router.route('/payment-methods')
    .get(protect, getActivePaymentMethods);

router.route('/:id')
    .get(protect, getDepositById);

module.exports = router;
// Backend\routes\client\withdrawalRoutes.js

const express = require('express');
const router = express.Router();
const {
    createWithdrawal,
    getWithdrawals,
    getWithdrawalById,
    getWithdrawalsByAccount,
    getWithdrawalsByUser,
    getLastWithdrawalMethod
} = require('../../controllers/client/withdrawalClientController');
const { protect } = require('../../middlewares/auth');
const { getCardRefundable } = require('../../controllers/client/stripeWithdrawalController');

// How much can go back to the client's card (card withdrawals are refunds).
router.get('/stripe/refundable', protect, getCardRefundable);

// Client routes
router.post('/', protect, createWithdrawal);
router.get('/', protect, getWithdrawals);
router.get('/user', protect, getWithdrawalsByUser);
router.get('/account/:accountId', protect, getWithdrawalsByAccount);
router.get('/last-method', protect, getLastWithdrawalMethod);
router.get('/:id', protect, getWithdrawalById);


module.exports = router;
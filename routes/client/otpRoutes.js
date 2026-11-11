// Backend\routes\client\otpRoutes.js

const express = require('express');
const router = express.Router();
const {
    sendWithdrawalOTP,
    verifyWithdrawalOTP,
    resendWithdrawalOTP
} = require('../../controllers/client/otpController');
const { protect } = require('../../middlewares/auth');

router.post('/withdrawal/send', protect, sendWithdrawalOTP);
router.post('/withdrawal/verify', protect, verifyWithdrawalOTP);
router.post('/withdrawal/resend', protect, resendWithdrawalOTP);

module.exports = router;
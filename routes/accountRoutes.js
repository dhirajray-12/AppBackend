const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
    createAccount,
    getAccounts,
    getAccount,
    updateAccountPasswords,
    getUserAccountsForCopy
} = require('../controllers/client/accountController');

router.post('/create', protect, authorize('client'), createAccount);
router.get('/', protect, getAccounts);
router.get('/:accountId/refresh', protect, getAccount);
// Add this line after your existing routes
router.put('/:accountId/passwords', protect, authorize('client'), updateAccountPasswords);
router.get('/copy-accounts', protect, getUserAccountsForCopy);

module.exports = router;
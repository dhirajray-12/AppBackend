const express = require("express");
const {
  getAllTransactions,
} = require("../../controllers/admin/adminTransactionController");
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const router = express.Router();

// Apply authentication middleware
router.use(protect);
router.use(authorize("admin", "subadmin"));
router.use(authorizePermission(PERMISSIONS.TRANSACTIONS_VIEW));

// Get all transactions
router.get("/", getAllTransactions);

module.exports = router;

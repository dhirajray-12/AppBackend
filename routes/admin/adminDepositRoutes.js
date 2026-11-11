// Backend\routes\admin\adminDepositRoutes.js
const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getDeposits,
  getDepositById,
  approveDeposit,
  rejectDeposit,
  exportDeposits,
  getDocument,
} = require("../../controllers/admin/depositController");

// All routes require authentication
router.use(protect);
router.use(authorize("admin", "subadmin"));

// Admin routes
router.get("/", authorizePermission(PERMISSIONS.DEPOSITS_VIEW), getDeposits);
router.get(
  "/export",
  authorizePermission(PERMISSIONS.DEPOSITS_VIEW),
  exportDeposits,
);
router.post(
  "/:id/approve",
  authorizePermission(PERMISSIONS.DEPOSITS_APPROVE),
  approveDeposit,
);
router.post(
  "/:id/reject",
  authorizePermission(PERMISSIONS.DEPOSITS_APPROVE),
  rejectDeposit,
);
router.get(
  "/:id/document",
  authorizePermission(PERMISSIONS.DEPOSITS_VIEW),
  getDocument,
);
router.get(
  "/:id",
  authorizePermission(PERMISSIONS.DEPOSITS_VIEW),
  getDepositById,
);

module.exports = router;

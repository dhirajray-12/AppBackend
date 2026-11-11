// Backend\routes\copyRoutes.js
const express = require("express");
const {
  createCopyRequest,
  getUserCopyRequests,
  getAllCopyRequests,
  acceptCopyRequest,
  rejectCopyRequest,
  getCopyRequestDetails,
} = require("../../controllers/copyController");
const { protect, authorize } = require("../../middlewares/auth");

const router = express.Router();

// Client routes
router.post("/request", protect, createCopyRequest);
router.get("/my-requests", protect, getUserCopyRequests);

// Admin routes
router.get(
  "/admin/requests",
  protect,
  authorize("admin", "superadmin"),
  getAllCopyRequests
);
router.get(
  "/admin/request/:id",
  protect,
  authorize("admin", "superadmin"),
  getCopyRequestDetails
);
router.put(
  "/admin/accept/:id",
  protect,
  authorize("admin", "superadmin"),
  acceptCopyRequest
);
router.put(
  "/admin/reject/:id",
  protect,
  authorize("admin", "superadmin"),
  rejectCopyRequest
);

module.exports = router;

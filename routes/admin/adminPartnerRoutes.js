// backend/routes/admin/adminPartnerRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllPartners,
  getPartnerStats,
  getPartnerById,
  getPartnerDownlineTree,
  getPartnerCommissions,
  updatePartnerCommission,
} = require("../../controllers/admin/adminPartnerController");
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");

router.use(protect);
router.use(authorize("admin", "superadmin", "subadmin"));

// @route   GET /api/admin/partners
// @desc    List all partners with referrer, downline count and commission totals
router.get("/", authorizePermission(PERMISSIONS.IB_PARTNERS_VIEW), getAllPartners);

// @route   GET /api/admin/partners/stats
// @desc    Platform-wide partner/commission overview stats
router.get("/stats", authorizePermission(PERMISSIONS.IB_PARTNERS_VIEW), getPartnerStats);

// @route   GET /api/admin/partners/:id
// @desc    Single partner detail (profile, referrer, direct downline)
router.get("/:id", authorizePermission(PERMISSIONS.IB_PARTNERS_VIEW), getPartnerById);

// @route   GET /api/admin/partners/:id/tree
// @desc    Full multi-level downline tree for a partner
router.get("/:id/tree", authorizePermission(PERMISSIONS.IB_PARTNERS_VIEW), getPartnerDownlineTree);

// @route   GET /api/admin/partners/:id/commissions
// @desc    Trade-level commission history for a partner
router.get(
  "/:id/commissions",
  authorizePermission(PERMISSIONS.IB_PARTNERS_VIEW),
  getPartnerCommissions,
);

// @route   PATCH /api/admin/partners/:id/commission
// @desc    Admin sets/overrides the maximum commission for any partner (root or Sub-IB)
router.patch(
  "/:id/commission",
  authorizePermission(PERMISSIONS.IB_PARTNERS_EDIT),
  updatePartnerCommission,
);

module.exports = router;

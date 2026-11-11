// Backend/routes/admin/pammRoutes.js
const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const {
  getEligibleAccounts,
  createFund,
  updateFund,
  closeFund,
  getFunds,
  getFundById,
  getFundStats,
  getInvestmentRequests,
  getRedemptionRequests,
  approveInvestment,
  rejectInvestment,
  approveRedemption,
  rejectRedemption,
  triggerSettlement,
  getDashboardStats,
} = require("../../controllers/admin/pammController");

router.use(protect);
router.use(authorize("admin", "subadmin"));

router.get("/stats", authorizePermission(PERMISSIONS.PAMM_VIEW), getDashboardStats);
router.get("/eligible-accounts", authorizePermission(PERMISSIONS.PAMM_VIEW), getEligibleAccounts);

router.get("/funds", authorizePermission(PERMISSIONS.PAMM_VIEW), getFunds);
router.post("/funds", authorizePermission(PERMISSIONS.PAMM_EDIT), createFund);
router.get("/funds/:id", authorizePermission(PERMISSIONS.PAMM_VIEW), getFundById);
router.put("/funds/:id", authorizePermission(PERMISSIONS.PAMM_EDIT), updateFund);
router.post("/funds/:id/close", authorizePermission(PERMISSIONS.PAMM_EDIT), closeFund);
router.get("/funds/:id/stats", authorizePermission(PERMISSIONS.PAMM_VIEW), getFundStats);
router.post("/funds/:id/settle", authorizePermission(PERMISSIONS.PAMM_EDIT), triggerSettlement);

router.get("/investments", authorizePermission(PERMISSIONS.PAMM_VIEW), getInvestmentRequests);
router.put("/investments/:id/approve", authorizePermission(PERMISSIONS.PAMM_EDIT), approveInvestment);
router.put("/investments/:id/reject", authorizePermission(PERMISSIONS.PAMM_EDIT), rejectInvestment);

router.get("/redemptions", authorizePermission(PERMISSIONS.PAMM_VIEW), getRedemptionRequests);
router.put("/redemptions/:id/approve", authorizePermission(PERMISSIONS.PAMM_EDIT), approveRedemption);
router.put("/redemptions/:id/reject", authorizePermission(PERMISSIONS.PAMM_EDIT), rejectRedemption);

module.exports = router;

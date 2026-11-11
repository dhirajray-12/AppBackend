const express = require("express");
const { protect, authorize } = require("../middlewares/auth");
const {
  listAdminsWithSuspensionStatus,
  updateBillingSuspensionPolicy,
  updateManualSuspension,
} = require("../controllers/superadminController");

const router = express.Router();

router.use(protect);
router.use(authorize("superadmin"));

router.get("/billing-suspension", listAdminsWithSuspensionStatus);
router.put("/billing-suspension/policy", updateBillingSuspensionPolicy);
router.patch("/billing-suspension/manual", updateManualSuspension);

module.exports = router;

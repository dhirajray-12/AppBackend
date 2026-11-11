// backend/routes/admin/subadminRoutes.js
const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../../middlewares/auth");
const {
  listSubadmins,
  getSubadmin,
  createSubadmin,
  updateSubadmin,
  resetSubadminPassword,
  deleteSubadmin,
} = require("../../controllers/admin/subadminController");

// Subadmins must never be able to manage other subadmins.
router.use(protect);
router.use(authorize("admin", "superadmin"));

router.get("/", listSubadmins);
router.post("/", createSubadmin);
router.get("/:id", getSubadmin);
router.put("/:id", updateSubadmin);
router.put("/:id/reset-password", resetSubadminPassword);
router.delete("/:id", deleteSubadmin);

module.exports = router;

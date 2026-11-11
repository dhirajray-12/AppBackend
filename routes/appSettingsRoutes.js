const express = require("express");
const {
  getAppSettings,
  updateAppSettings,
  getPublicAppStatus,
} = require("../controllers/appSettingsController");
const { protect, authorize } = require("../middlewares/auth");

const router = express.Router();

router.get("/public", getPublicAppStatus);
router.get("/", protect, getAppSettings);
router.put("/", protect, authorize("superadmin"), updateAppSettings);

module.exports = router;

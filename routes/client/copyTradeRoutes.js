// Backend/routes/copyTradingRoutes.js
const express = require("express");
const router = express.Router();
const { protect } = require("../../middlewares/auth");
const masterController = require("../../controllers/client/copyMasterController");

// Master Routes
router.get("/masters", protect, masterController.getMasters); // Get all masters
// router.get('/masters/public', protect, masterController.getPublicMasters);
router.get("/masters/:id", protect, masterController.getMaster); // Get a single master
router.post("/masters", protect, masterController.createMaster); // Create a master
router.put("/masters/:id", protect, masterController.updateMaster); // Update a master
// router.get('/masters/:id/copiers', protect, masterController.getMasterCopiers);
router.delete("/masters/:id", protect, masterController.deleteMaster);
// router.get('/masters-accounts', protect, masterController.getMasterAccounts);

router.get("/admin/accounts", protect, masterController.getAllAccounts);

module.exports = router;

// Backend/routes/copyRatingRoutes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');
const { getAllMasters, getMasterDetails, setupCopying } = require('../../controllers/client/copyRatingController');

// Get all master traders
router.get('/masters', protect, authorize('client', 'admin', 'superadmin'), getAllMasters);

// Get specific master details
router.get('/master/:masterId', protect, authorize('client', 'admin', 'superadmin'), getMasterDetails);

// Add setup copying route
router.post('/setup-copying', protect, authorize('client', 'admin', 'superadmin'), setupCopying);

module.exports = router;
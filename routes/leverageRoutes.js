// backend/routes/leverageRoutes.js
const express = require('express');
const {
    getLeverages,
    createLeverage,
    updateLeverage,
    deleteLeverage
} = require('../controllers/leverageController');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();

router.route('/')
    .get(getLeverages)
    .post(protect, authorize('superadmin'), createLeverage);

router.route('/:id')
    .put(protect, authorize('superadmin'), updateLeverage)
    .delete(protect, authorize('superadmin'), deleteLeverage);

module.exports = router;
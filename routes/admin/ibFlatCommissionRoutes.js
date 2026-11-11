// backend/routes/admin/ibFlatCommissionRoutes.js
const express = require('express');
const {
    getFlatConfigurationsByGroup,
    getAllGroupsWithFlatConfigurations,
    createFlatConfiguration,
    updateFlatConfiguration,
    deleteFlatConfiguration,
    updateGroupDefaultTime
} = require('../../controllers/admin/ibFlatCommissionController');
const { protect, authorize, authorizePermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../constants/permissions');

const router = express.Router();

// All routes require authentication and admin authorization
router.use(protect);
router.use(authorize('admin', 'subadmin'));

router.route('/groups')
    .get(authorizePermission(PERMISSIONS.IB_CONFIGURATION_VIEW), getAllGroupsWithFlatConfigurations);

router.route('/group/:groupId')
    .get(authorizePermission(PERMISSIONS.IB_CONFIGURATION_VIEW), getFlatConfigurationsByGroup);

router.route('/')
    .post(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), createFlatConfiguration);

router.route('/:id')
    .put(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), updateFlatConfiguration)
    .delete(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), deleteFlatConfiguration);

router.put('/group/:groupId/default-time', authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), updateGroupDefaultTime);

module.exports = router;

// backend/routes/ibAdminConfigurationRoutes.js
const express = require('express');
const {
    getIBConfigurationsByGroup,
    getAllGroupsWithConfigurations,
    createIBConfiguration,
    updateIBConfiguration,
    deleteIBConfiguration,
    updateGroupDefaultTime,
    getRootIBs,
    assignRootIBCommission
} = require('../../controllers/admin/ibAdminConfigurationController');
const { protect, authorize, authorizePermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../constants/permissions');

const router = express.Router();

// All routes require authentication and admin authorization
router.use(protect);
router.use(authorize('admin', 'subadmin'));

router.route('/groups')
    .get(authorizePermission(PERMISSIONS.IB_CONFIGURATION_VIEW), getAllGroupsWithConfigurations);

router.route('/group/:groupId')
    .get(authorizePermission(PERMISSIONS.IB_CONFIGURATION_VIEW), getIBConfigurationsByGroup);

router.route('/')
    .post(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), createIBConfiguration);

router.route('/:id')
    .put(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), updateIBConfiguration)
    .delete(authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), deleteIBConfiguration);

// Add this route
router.put('/group/:groupId/default-time', authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), updateGroupDefaultTime);

// Root IB assignment ("Step 1 - Admin Configuration")
router.get('/root-ibs', authorizePermission(PERMISSIONS.IB_CONFIGURATION_VIEW), getRootIBs);
router.post('/root/assign', authorizePermission(PERMISSIONS.IB_CONFIGURATION_EDIT), assignRootIBCommission);

module.exports = router;
// backend/routes/admin/clientRoutes.js - WITH PAGINATION
const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../../middlewares/auth");
const { PERMISSIONS } = require("../../constants/permissions");
const { paginate } = require("../../middlewares/pagination");
const User = require("../../models/User");
const {
  getAllClients,
  getClientDetails,
  updateClient,
  updateClientPassword,
  getClientPassword,
  suspendClient,
  activateClient,
  exportToExcel,
  exportToPdf,
  getUserAccounts,
  getAccountDetails,
  getClientRiskScore,
  getClientTimeMachine,
} = require("../../controllers/admin/clientManagementController");
const {
  getClientDeviceSessions,
  updateClientDeviceSession,
} = require("../../controllers/deviceSessionController");
const {
  sendEmailToClient,
  sendEmailToAllClients,
  getAllClientsEmailPreview,
  getEmailStats,
  getClientEmailLogs,
  getAllEmailLogs,
} = require("../../controllers/admin/adminEmailController");

// Protected routes
router.use(protect);
router.use(authorize("client", "admin", "superadmin", "subadmin"));

// Get all clients with pagination
router.get(
  "/",
  authorizePermission(PERMISSIONS.CLIENTS_VIEW),
  paginate(User, {
    filterFields: ["role", "status", "isEmailVerified"],
    searchFields: ["firstName", "lastName", "email"],
    defaultSort: { createdAt: -1 },
  }),
  getAllClients,
);

// Email stats/preview (must be registered before "/:id" so they aren't swallowed by it)
router.get("/email-stats", authorizePermission(PERMISSIONS.EMAIL_LOGS_VIEW), getEmailStats);
router.get("/send-email/all/preview", authorizePermission(PERMISSIONS.CLIENTS_EDIT), getAllClientsEmailPreview);
router.get("/email-logs", authorizePermission(PERMISSIONS.EMAIL_LOGS_VIEW), getAllEmailLogs);

// Get single client
router.get("/:id", authorizePermission(PERMISSIONS.CLIENTS_VIEW), getClientDetails);

// Compliance/fraud risk score - see controller for how it's computed
router.get("/:id/risk-score", authorizePermission(PERMISSIONS.CLIENTS_VIEW), getClientRiskScore);

// Time Machine - reconstructs the client's account state as of a past
// moment (?at=<ISO datetime>, optional &accountId=<id>). See controller
// for how the balance/positions are derived and their caveats.
router.get("/:id/time-machine", authorizePermission(PERMISSIONS.CLIENTS_VIEW), getClientTimeMachine);

// Device security
router.get("/:clientId/devices", authorizePermission(PERMISSIONS.CLIENTS_VIEW), getClientDeviceSessions);
router.patch("/:clientId/devices/:sessionId", authorizePermission(PERMISSIONS.CLIENTS_EDIT), updateClientDeviceSession);

// Update client
router.put("/:id", authorizePermission(PERMISSIONS.CLIENTS_EDIT), updateClient);

// Password management
router.put("/:id/update-password", authorizePermission(PERMISSIONS.CLIENTS_EDIT), updateClientPassword);
router.get("/:id/password", authorizePermission(PERMISSIONS.CLIENTS_EDIT), getClientPassword);

// Status management
router.put("/:id/suspend", authorizePermission(PERMISSIONS.CLIENTS_SUSPEND), suspendClient);
router.put("/:id/activate", authorizePermission(PERMISSIONS.CLIENTS_SUSPEND), activateClient);

// Custom email
router.post("/send-email/all", authorizePermission(PERMISSIONS.CLIENTS_EDIT), sendEmailToAllClients);
router.post("/:id/send-email", authorizePermission(PERMISSIONS.CLIENTS_EDIT), sendEmailToClient);
router.get("/:id/email-logs", authorizePermission(PERMISSIONS.EMAIL_LOGS_VIEW), getClientEmailLogs);

// Export data
router.get("/export/excel", authorizePermission(PERMISSIONS.CLIENTS_EXPORT), exportToExcel);
router.get("/export/pdf", authorizePermission(PERMISSIONS.CLIENTS_EXPORT), exportToPdf);

// Get accounts for a specific user
router.get(
  "/users/:userId/accounts",
  protect,
  authorize("client", "admin", "subadmin"),
  authorizePermission(PERMISSIONS.CLIENTS_VIEW),
  getUserAccounts,
);

module.exports = router;

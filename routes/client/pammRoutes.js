// Backend/routes/client/pammRoutes.js
const express = require("express");
const router = express.Router();
const { protect } = require("../../middlewares/auth");
const {
  getActiveFunds,
  getFundDetail,
  investInFund,
  getMyInvestments,
  getInvestmentTransactions,
  requestRedemption,
  getMyRequests,
  getMyManagedFunds,
  getMyFundInvestors,
} = require("../../controllers/client/pammController");

router.use(protect);

router.get("/funds", getActiveFunds);
router.get("/funds/:id", getFundDetail);
router.post("/invest", investInFund);

router.get("/my-investments", getMyInvestments);
router.get("/my-investments/:id/transactions", getInvestmentTransactions);
router.post("/redeem", requestRedemption);

router.get("/my-requests", getMyRequests);

router.get("/my-funds", getMyManagedFunds);
router.get("/my-funds/:id/investors", getMyFundInvestors);

module.exports = router;

// controllers/client/stripeWithdrawalController.js
// GET /api/withdrawals/stripe/refundable: how much the client can withdraw back
// to their card (card withdrawals are refunds of card deposits).
const { maxCardWithdrawal } = require("../../services/stripeWithdrawalService");

exports.getCardRefundable = async (req, res, next) => {
  try {
    const max = await maxCardWithdrawal(req.user.id);
    return res.json({ success: true, data: { maxAmount: max } });
  } catch (err) {
    return next(err);
  }
};

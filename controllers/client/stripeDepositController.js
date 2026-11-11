// controllers/client/stripeDepositController.js
// POST /api/clientdeposits/stripe/checkout  { accountId, amount, returnPath? }
// Creates a Pending card deposit and returns the Stripe Checkout URL to redirect to.
const { createCheckout } = require("../../services/stripeDepositService");

exports.createStripeCheckout = async (req, res, next) => {
  try {
    const { accountId, amount, returnPath } = req.body;
    if (!accountId) {
      return res.status(400).json({ success: false, message: "accountId is required" });
    }
    const { deposit, url } = await createCheckout({ userId: req.user.id, accountId, amount, returnPath });
    return res.status(201).json({ success: true, data: { depositId: deposit._id, checkoutUrl: url } });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
};

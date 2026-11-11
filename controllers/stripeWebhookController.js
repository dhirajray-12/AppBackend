// controllers/stripeWebhookController.js
// POST /api/stripe/webhook: Stripe events, forwarded by Relaya.
//
// Relaya verifies Stripe's signature, records every event and retries until
// this server answers 2xx. This route verifies Relaya's signature
// (RELAYA_SIGNING_SECRET, the destination's secret), so nobody else can post
// a fake "payment succeeded". A 5xx makes Relaya retry later.
const { relayaMiddleware } = require("relaya-node");
const { creditPaidSession, expireSession } = require("../services/stripeDepositService");
const { handleChargeRefunded } = require("../services/stripeWithdrawalService");

const verifyRelaya = relayaMiddleware({ secret: process.env.RELAYA_SIGNING_SECRET });

async function handle(req, res) {
  const delivery = req.relaya;
  let event;
  try {
    event = delivery.json();
  } catch {
    return res.status(400).json({ error: "body is not JSON" });
  }
  const object = event && event.data && event.data.object;
  let result = "ignored";
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        result = await creditPaidSession(object, req.app);
        break;
      case "checkout.session.expired":
        result = await expireSession(object);
        break;
      case "charge.refunded": // a card withdrawal's refund went through
        result = await handleChargeRefunded(object);
        break;
      default:
        result = `ignored: ${event.type}`;
    }
  } catch (err) {
    console.error("Stripe webhook failed; Relaya will retry", {
      event: event.id, type: event.type, attempt: delivery.attempt, error: err.message,
    });
    return res.status(500).json({ error: "processing failed, retry later" });
  }
  console.log("Stripe webhook", { event: event.id, type: event.type, attempt: delivery.attempt, replay: delivery.replayId || undefined, result });
  return res.status(200).json({ ok: true, result });
}

// Mounted in index.js before the JSON body parser: the signature covers the raw body.
exports.stripeWebhook = [verifyRelaya, handle];

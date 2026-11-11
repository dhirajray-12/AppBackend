// services/stripeWithdrawalService.js
// Card withdrawals: money goes back to the card the client deposited with, as a
// Stripe refund of one of their card deposits. A refund can't exceed what that
// card paid, so the client can withdraw by card at most their largest
// remaining card deposit; larger amounts go by bank or e-wallet.
//
// Order on approval: MT5 is debited first (the existing flow), then the refund
// is created. If Stripe refuses, the MT5 debit is reversed, so a client is
// never debited without being paid. Stripe then confirms the refund
// (charge.refunded) through Relaya, and the withdrawal is marked completed.
const Stripe = require("stripe");
const mongoose = require("mongoose");
const Deposit = require("../models/Deposit");
const Withdrawal = require("../models/Withdrawal");
const { metaApi } = require("../API/metaApi");

const METHOD = "stripe_card";

let client;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  client = client || new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

/** The client's card payments that can still be refunded, largest first (amounts in dollars). */
async function refundablePayments(userId) {
  const deposits = await Deposit.find({ user: userId, paymentType: "Stripe", status: "Approved", transactionId: /^pi_/ })
    .sort({ approvedDate: -1 })
    .limit(20)
    .lean();
  const out = [];
  for (const d of deposits) {
    const pi = await stripe().paymentIntents.retrieve(d.transactionId, { expand: ["latest_charge"] });
    const charge = pi.latest_charge;
    if (!charge || typeof charge !== "object") continue;
    const left = (charge.amount - charge.amount_refunded) / 100;
    if (left > 0) {
      out.push({ paymentIntent: pi.id, depositId: String(d._id), refundable: left, last4: charge.payment_method_details?.card?.last4 || "" });
    }
  }
  return out.sort((a, b) => b.refundable - a.refundable);
}

/** The most the client can withdraw by card in one request. */
async function maxCardWithdrawal(userId) {
  const list = await refundablePayments(userId);
  return list.length ? list[0].refundable : 0;
}

/** A card payment that can take the whole refund, or null. */
async function pickPayment(userId, amount) {
  const list = await refundablePayments(userId);
  return list.find((p) => p.refundable + 1e-9 >= amount) || null;
}

/** Refunds the withdrawal to the card. Idempotent per withdrawal. */
async function refund(withdrawal, payment) {
  const refundObj = await stripe().refunds.create(
    {
      payment_intent: payment.paymentIntent,
      amount: Math.round(withdrawal.amount * 100),
      metadata: { withdrawalId: String(withdrawal._id) },
    },
    { idempotencyKey: `withdrawal-${withdrawal._id}` },
  );
  // The schema doesn't list these fields, so write them directly.
  await Withdrawal.collection.updateOne(
    { _id: withdrawal._id },
    {
      $set: {
        stripePaymentIntent: payment.paymentIntent,
        stripeRefundId: refundObj.id,
        stripeRefundStatus: refundObj.status,
        cardLast4: payment.last4,
      },
    },
  );
  return refundObj;
}

/** Puts a debited amount back into MT5 (the refund failed). */
async function reverseMT5Debit(account, amount, withdrawalId) {
  const res = await metaApi.get(`/MakeDepositBalance`, {
    params: {
      Manager_Index: account.managerIndex || "3",
      MT5Account: account.mt5Account,
      Amount: amount,
      Comment: `Reversal: card refund failed for withdrawal ${withdrawalId}`,
    },
  });
  if (!res.data || res.data.error) {
    throw new Error(`MT5 reversal failed: ${res.data?.message || "unknown error"}`);
  }
}

/** charge.refunded from Stripe: mark the matching card withdrawals completed. */
// Withdrawals are found through each refund's metadata.withdrawalId, not through
// fields refund() stores: the event can arrive before that write lands.
async function handleChargeRefunded(charge) {
  const refunds = await stripe().refunds.list({ charge: charge.id, limit: 100 });
  const results = [];
  for (const r of refunds.data) {
    const id = r.metadata && r.metadata.withdrawalId;
    if (!id || !mongoose.isValidObjectId(id)) continue;
    const w = await Withdrawal.collection.findOne({ _id: new mongoose.Types.ObjectId(id), stripeRefundConfirmed: { $ne: true } });
    if (!w) continue;
    const done = r.status === "succeeded";
    const last4 = w.cardLast4 || charge.payment_method_details?.card?.last4 || "";
    await Withdrawal.collection.updateOne(
      { _id: w._id },
      {
        $set: {
          stripePaymentIntent: charge.payment_intent,
          stripeRefundId: r.id,
          stripeRefundStatus: r.status,
          stripeRefundConfirmed: done,
          remarks: done
            ? `Refunded to card ••••${last4} (Stripe ${r.id})`
            : `Card refund ${r.status} (Stripe ${r.id})`,
        },
      },
    );
    results.push(`${w._id}: refund ${r.status}`);
  }
  return results.length ? results.join("; ") : "ignored: no card withdrawal for this charge";
}

module.exports = { METHOD, maxCardWithdrawal, pickPayment, refund, reverseMT5Debit, handleChargeRefunded };

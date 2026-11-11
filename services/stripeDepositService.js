// services/stripeDepositService.js
// Card deposits through Stripe Checkout. Stripe's events reach this server
// through Relaya (verified, recorded, retried), and a paid deposit is
// credited to MT5 exactly like an admin approval, at most once.
const Stripe = require("stripe");
const Deposit = require("../models/Deposit");
const PaymentMethod = require("../models/PaymentMethod");
const Account = require("../models/client/Account");
const { metaApi } = require("../API/metaApi");
const { invalidateDepositCaches } = require("../controllers/client/depositController");
const { invalidateTransactionsCache } = require("../controllers/admin/adminTransactionController");
const { invalidateStatementCaches } = require("../controllers/client/statementController");
const { invalidateClientCaches } = require("../controllers/client/clientDashboardController");
const { normalizeDepositAssetFields } = require("../utils/assetPaths");

const PAYMENT_TYPE = "Stripe";
const CURRENCY = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
const MIN_AMOUNT = Number(process.env.STRIPE_MIN_DEPOSIT || 1);
const MAX_AMOUNT = Number(process.env.STRIPE_MAX_DEPOSIT || 50000);

let stripeClient;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  stripeClient = stripeClient || new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

// Deposits must reference a payment method. Card payments use one internal,
// inactive method so it never shows in the manual (proof-of-payment) list.
async function stripePaymentMethod(userId) {
  let pm = await PaymentMethod.findOne({ type: "Other", walletName: "Card (Stripe)" }).lean();
  if (!pm) {
    pm = await PaymentMethod.create({
      user: userId,
      type: "Other",
      walletName: "Card (Stripe)",
      description: "Card payments through Stripe Checkout (internal, credited automatically).",
      active: false,
    });
  }
  return pm._id;
}

/**
 * Creates a Pending deposit and a Stripe Checkout page for it.
 * returnPath is a path on the CRM frontend (never another site).
 */
async function createCheckout({ userId, accountId, amount, returnPath }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
    const err = new Error(`Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} ${CURRENCY.toUpperCase()}`);
    err.status = 400;
    throw err;
  }
  const account = await Account.findById(accountId).lean();
  if (!account) {
    const err = new Error("Account not found");
    err.status = 404;
    throw err;
  }
  if (account.user.toString() !== userId.toString()) {
    const err = new Error("Unauthorized access to this account");
    err.status = 403;
    throw err;
  }

  const deposit = await Deposit.create({
    user: userId,
    account: accountId,
    amount: value,
    paymentMethod: await stripePaymentMethod(userId),
    paymentType: PAYMENT_TYPE,
    proofOfPayment: "stripe-checkout", // paid by card: Stripe holds the proof
    accountNumber: account.mt5Account,
    remarks: "Waiting for card payment (Stripe)",
  });

  const base = (process.env.CLIENT_URL || "").replace(/\/+$/, "");
  const path = typeof returnPath === "string" && returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  const sep = path.includes("?") ? "&" : "?";
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    client_reference_id: deposit._id.toString(),
    metadata: { depositId: deposit._id.toString(), mt5Account: String(account.mt5Account) },
    payment_intent_data: { metadata: { depositId: deposit._id.toString() } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: Math.round(value * 100),
          product_data: { name: `Deposit to trading account ${account.mt5Account}` },
        },
      },
    ],
    success_url: `${base}${path}${sep}stripe=success&deposit=${deposit._id}`,
    cancel_url: `${base}${path}${sep}stripe=cancelled&deposit=${deposit._id}`,
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
  });

  deposit.transactionId = session.id;
  await deposit.save();
  await invalidateDepositCaches(userId.toString());
  return { deposit, url: session.url };
}

/**
 * Credits a paid Checkout session's deposit to MT5 and approves it. Safe to
 * call more than once (retries, replays): only the first call credits.
 * Returns a short description of what happened.
 */
async function creditPaidSession(session, app) {
  const depositId = session.metadata && session.metadata.depositId;
  if (!depositId) return "ignored: not a CRM deposit";
  if (session.payment_status !== "paid") return `ignored: payment_status ${session.payment_status}`;

  const deposit = await Deposit.findById(depositId).populate("account");
  if (!deposit) return "ignored: deposit not found";
  if (deposit.status === "Approved") return "already credited";
  if (deposit.status !== "Pending") return `ignored: deposit is ${deposit.status}`;

  // The amount paid must be exactly what was asked for.
  const paid = Number(session.amount_total) / 100;
  if (String(session.currency).toLowerCase() !== CURRENCY || Math.abs(paid - deposit.amount) > 0.001) {
    await Deposit.updateOne({ _id: deposit._id }, { $set: { remarks: `Stripe paid ${paid} ${session.currency}; expected ${deposit.amount} ${CURRENCY}. Check before approving.` } });
    return "held for review: amount mismatch";
  }

  // Claim it, so parallel deliveries can't both credit.
  const claimed = await Deposit.collection.findOneAndUpdate(
    { _id: deposit._id, status: "Pending", stripeCreditLock: { $exists: false } },
    { $set: { stripeCreditLock: new Date() } },
  );
  if (!claimed) return "in progress elsewhere";

  try {
    const managerIndex = deposit.account.managerIndex || "3";
    const mt5Account = deposit.account.mt5Account;
    const depositResponse = await metaApi.get(`/MakeDepositBalance`, {
      params: { Manager_Index: managerIndex, MT5Account: mt5Account, Amount: deposit.amount, Comment: `Stripe card deposit - ID: ${deposit._id}` },
    });
    if (!depositResponse.data || depositResponse.data.error) {
      throw new Error(`Deposit API failed: ${depositResponse.data?.message || "Unknown error"}`);
    }
    const balanceResponse = await metaApi.get(`/GetUserInfo`, { params: { Manager_Index: managerIndex, MT5Account: mt5Account } });
    const info = balanceResponse.data || {};
    const updatedAccount = await Account.findByIdAndUpdate(
      deposit.account._id,
      { balance: info.Balance || info.balance || 0, equity: info.Equity || info.equity || 0 },
      { new: true },
    ).lean();

    const previousStatus = deposit.status;
    deposit.status = "Approved";
    deposit.approvedDate = Date.now();
    deposit.transactionId = session.payment_intent || session.id;
    deposit.remarks = `Paid by card (Stripe ${session.id}); credited automatically`;
    await deposit.save();

    const userId = deposit.user.toString();
    await invalidateDepositCaches(userId, deposit._id.toString());
    await invalidateTransactionsCache();
    await invalidateStatementCaches(userId);
    await invalidateClientCaches(userId);

    const io = app && app.get("io");
    if (io) {
      const realtime = await Deposit.findById(deposit._id)
        .populate("account", "mt5Account accountType balance equity")
        .populate("paymentMethod", "type bankName walletName")
        .populate("user", "firstName lastName email")
        .lean();
      if (realtime && io.emitDepositUpdate) io.emitDepositUpdate(normalizeDepositAssetFields(realtime), previousStatus);
      if (updatedAccount && io.emitAccountUpdate) io.emitAccountUpdate(userId, updatedAccount);
      if (io.emitCacheInvalidation) {
        io.emitCacheInvalidation(userId, ["deposits", "dashboard", "transactions", "dashboardData", "accounts", "availableBalances", "withdrawalAccounts", "accountActivity"]);
      }
      if (io.broadcastCacheInvalidation) io.broadcastCacheInvalidation(["admin_deposits", "admin_dashboard"]);
    }
    return "credited";
  } catch (err) {
    // Release the claim so Relaya's retry can try again.
    await Deposit.collection.updateOne({ _id: deposit._id }, { $unset: { stripeCreditLock: "" } });
    throw err;
  }
}

/** A Checkout session expired unpaid: reject its deposit. */
async function expireSession(session) {
  const depositId = session.metadata && session.metadata.depositId;
  if (!depositId) return "ignored: not a CRM deposit";
  const res = await Deposit.updateOne(
    { _id: depositId, status: "Pending", paymentType: PAYMENT_TYPE },
    { $set: { status: "Rejected", rejectedDate: Date.now(), remarks: "Card payment was not completed (Stripe checkout expired)" } },
  );
  return res.modifiedCount ? "rejected: checkout expired" : "no change";
}

module.exports = { createCheckout, creditPaidSession, expireSession, PAYMENT_TYPE };

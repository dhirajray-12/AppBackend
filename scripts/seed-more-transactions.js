// Adds MORE deposits/withdrawals/transfers on top of an existing seeded
// account pool (from seed-performance-data-multiuser.js), without creating
// any new users. Useful for pushing collections to a bigger scale to make
// load/pagination testing more realistic.
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

const SOURCE_TAG = process.env.PERF_SOURCE_TAG || "loadtest-multiuser-20260805";
const SEED_TAG = process.env.PERF_SEED_TAG || `${SOURCE_TAG}-extra-${Date.now()}`;

const SETTINGS = {
  deposits: Number.parseInt(process.env.PERF_SEED_DEPOSITS || "20000", 10),
  withdrawals: Number.parseInt(process.env.PERF_SEED_WITHDRAWALS || "20000", 10),
  transfers: Number.parseInt(process.env.PERF_SEED_TRANSFERS || "20000", 10),
};

const pick = (items, index) => items[index % items.length];
const randomBetween = (min, max) => min + Math.random() * (max - min);

const makeDateWithinDays = (daysBack, offset = 0) => {
  const now = Date.now();
  const delta = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - delta - offset);
};

async function main() {
  await connectDB();
  const db = mongoose.connection.db;

  const accounts = await db
    .collection("accounts")
    .find({ seedTag: SOURCE_TAG }, { projection: { _id: 1, user: 1, mt5Account: 1, accountType: 1 } })
    .toArray();

  if (accounts.length === 0) {
    throw new Error(
      `No accounts found with seedTag "${SOURCE_TAG}". Set PERF_SOURCE_TAG to an existing seed batch.`,
    );
  }

  console.log(`Using ${accounts.length} existing accounts from seedTag "${SOURCE_TAG}"`);

  const paymentTypes = ["bank", "usdt", "ethereum", "bitcoin"];
  const strideFor = (n) => Math.max(1, Math.floor(n * 0.41) | 1);
  const baseNow = Date.now();

  const deposits = [];
  const depositStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.deposits; index += 1) {
    const account = accounts[(index * depositStride + index * 3 + 7) % accounts.length];
    const createdAt = makeDateWithinDays(365, index * 150);
    const status = index % 9 === 0 ? "Pending" : index % 13 === 0 ? "Rejected" : "Approved";
    deposits.push({
      _id: new mongoose.Types.ObjectId(),
      user: account.user,
      account: account._id,
      amount: Number(randomBetween(100, 5000).toFixed(2)),
      planType: "performance",
      paymentMethod: new mongoose.Types.ObjectId(),
      paymentType: pick(paymentTypes, index),
      proofOfPayment: `seed-proof-${SEED_TAG}-${index}`,
      accountNumber: account.mt5Account,
      bonus: 0,
      status,
      transactionId: `DEP-${SEED_TAG}-${index}`,
      requestedDate: createdAt,
      approvedDate: status === "Approved" ? new Date(createdAt.getTime() + 2 * 60 * 60 * 1000) : null,
      rejectedDate: status === "Rejected" ? new Date(createdAt.getTime() + 60 * 60 * 1000) : null,
      remarks: "Load test deposit (extra batch)",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000),
    });
  }

  const withdrawals = [];
  const withdrawalStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.withdrawals; index += 1) {
    const account = accounts[(index * withdrawalStride + index * 5 + 11) % accounts.length];
    const createdAt = makeDateWithinDays(365, index * 180);
    const status = index % 8 === 0 ? "Pending" : index % 11 === 0 ? "Rejected" : "Approved";
    const paymentMethod = pick(paymentTypes, index);
    withdrawals.push({
      _id: new mongoose.Types.ObjectId(),
      user: account.user,
      account: account._id,
      accountNumber: account.mt5Account,
      accountType: account.accountType,
      amount: Number(randomBetween(50, 3000).toFixed(2)),
      paymentMethod,
      bankDetails:
        paymentMethod === "bank"
          ? {
              bankName: "Seed Bank",
              accountHolderName: "Load Test User",
              accountNumber: "1234567890",
              ifscCode: "SEED0001",
            }
          : {},
      eWalletDetails:
        paymentMethod !== "bank"
          ? { walletId: `${paymentMethod}-${index}`, type: paymentMethod }
          : {},
      status,
      requestedDate: createdAt,
      approvedDate: status === "Approved" ? new Date(createdAt.getTime() + 90 * 60 * 1000) : null,
      rejectedDate: status === "Rejected" ? new Date(createdAt.getTime() + 45 * 60 * 1000) : null,
      remarks: "Load test withdrawal (extra batch)",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000),
    });
  }

  const transfers = [];
  const transferStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.transfers; index += 1) {
    const fromAccount = accounts[(index * transferStride + 2) % accounts.length];
    const toAccount = accounts[(index * transferStride + 17) % accounts.length];
    if (String(fromAccount._id) === String(toAccount._id)) continue;

    const createdAt = new Date(baseNow - index * 3 * 60 * 1000);
    transfers.push({
      _id: new mongoose.Types.ObjectId(),
      user: fromAccount.user,
      fromAccount: fromAccount._id,
      toAccount: toAccount._id,
      amount: Number(randomBetween(25, 1500).toFixed(2)),
      status: index % 17 === 0 ? "Failed" : "Completed",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: createdAt,
    });
  }

  const BATCH = 2000;
  for (let i = 0; i < deposits.length; i += BATCH) {
    await db.collection("deposits").insertMany(deposits.slice(i, i + BATCH), { ordered: false });
  }
  for (let i = 0; i < withdrawals.length; i += BATCH) {
    await db.collection("withdrawals").insertMany(withdrawals.slice(i, i + BATCH), { ordered: false });
  }
  for (let i = 0; i < transfers.length; i += BATCH) {
    await db.collection("transfers").insertMany(transfers.slice(i, i + BATCH), { ordered: false });
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        seedTag: SEED_TAG,
        depositsAdded: deposits.length,
        withdrawalsAdded: withdrawals.length,
        transfersAdded: transfers.length,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (e) {
    console.error(e);
  }
  process.exit(1);
});

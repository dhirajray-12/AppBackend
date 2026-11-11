// Load-test seeder: spreads ~10k accounts/deposits/withdrawals/transfers/
// closed-trades across MANY distinct client users (not a single benchmark
// user), so admin listing/search/pagination endpoints see realistic
// cardinality. Everything is tagged with seedTag for easy cleanup.
require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { connectDB } = require("../config/db");

const SEED_TAG =
  process.env.PERF_SEED_TAG || `loadtest-multiuser-${new Date().toISOString().slice(0, 10)}`;

const SETTINGS = {
  users: Number.parseInt(process.env.PERF_SEED_USERS || "2000", 10),
  targetAccounts: Number.parseInt(process.env.PERF_SEED_ACCOUNTS || "10000", 10),
  deposits: Number.parseInt(process.env.PERF_SEED_DEPOSITS || "10000", 10),
  withdrawals: Number.parseInt(process.env.PERF_SEED_WITHDRAWALS || "10000", 10),
  transfers: Number.parseInt(process.env.PERF_SEED_TRANSFERS || "10000", 10),
  closedTrades: Number.parseInt(process.env.PERF_SEED_CLOSED_TRADES || "10000", 10),
};

const pick = (items, index) => items[index % items.length];
const randomInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const randomBetween = (min, max) => min + Math.random() * (max - min);

const makeDateWithinDays = (daysBack, offset = 0) => {
  const now = Date.now();
  const delta = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - delta - offset);
};

const makeMt5Account = (prefix, index) => `${prefix}${String(index).padStart(7, "0")}`;

async function seedUsersAndAccounts(db) {
  const usersCollection = db.collection("users");
  const profilesCollection = db.collection("profiles");
  const accountsCollection = db.collection("accounts");

  const hashedPassword = await bcrypt.hash("PerfSeed123!", 10);
  const accountTypes = ["BASIC", "STANDARD", "VVIP"];
  const leverages = ["1:100", "1:200", "1:500"];

  const users = [];
  const profiles = [];
  const accounts = [];
  let accountCounter = 0;

  for (let u = 0; u < SETTINGS.users && accounts.length < SETTINGS.targetAccounts; u += 1) {
    const userId = new mongoose.Types.ObjectId();
    const createdAt = makeDateWithinDays(400, u * 1000);
    const email = `perf.user.${SEED_TAG}.${u}@example.com`;

    users.push({
      _id: userId,
      firstName: `PerfUser${u + 1}`,
      lastName: "LoadTest",
      email,
      role: "client",
      password: hashedPassword,
      country: { name: "India", state: "MH" },
      phone: `91${String(u).padStart(8, "0")}`,
      dateofbirth: new Date("1990-01-01"),
      isEmailVerified: true,
      status: "activated",
      referredBy: null,
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    profiles.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
      kycVerified: true,
      kycStatus: "verified",
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    const accountsForUser = randomInt(1, 8);
    for (let a = 0; a < accountsForUser && accounts.length < SETTINGS.targetAccounts; a += 1) {
      accountCounter += 1;
      accounts.push({
        _id: new mongoose.Types.ObjectId(),
        user: userId,
        mt5Account: makeMt5Account("97", accountCounter),
        investor_pwd: "seedInvestorPwd",
        master_pwd: "seedMasterPwd",
        name: `LoadTest Account ${accountCounter}`,
        leverage: pick(leverages, accountCounter),
        accountType: pick(accountTypes, accountCounter),
        groupName: pick(accountTypes, accountCounter),
        platform: "MetaTrader 5",
        balance: Number(randomBetween(500, 25000).toFixed(2)),
        equity: Number(randomBetween(500, 25000).toFixed(2)),
        status: true,
        managerIndex: "2",
        seedTag: SEED_TAG,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  const BATCH = 2000;
  for (let i = 0; i < users.length; i += BATCH) {
    await usersCollection.insertMany(users.slice(i, i + BATCH), { ordered: false });
  }
  for (let i = 0; i < profiles.length; i += BATCH) {
    await profilesCollection.insertMany(profiles.slice(i, i + BATCH), { ordered: false });
  }
  for (let i = 0; i < accounts.length; i += BATCH) {
    await accountsCollection.insertMany(accounts.slice(i, i + BATCH), { ordered: false });
  }

  return { users, accounts };
}

async function seedCashCollections(db, accounts) {
  const deposits = [];
  const withdrawals = [];
  const transfers = [];
  const paymentTypes = ["bank", "usdt", "ethereum", "bitcoin"];
  const baseNow = Date.now();

  // Shuffle-ish access pattern: use a stride that's coprime-ish with pool
  // size so consecutive records don't hit the same account/user repeatedly.
  const strideFor = (n) => Math.max(1, Math.floor(n * 0.37) | 1);

  const depositStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.deposits; index += 1) {
    const account = accounts[(index * depositStride + index) % accounts.length];
    const createdAt = makeDateWithinDays(365, index * 200);
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
      remarks: "Load test deposit",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000),
    });
  }

  const withdrawalStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.withdrawals; index += 1) {
    const account = accounts[(index * withdrawalStride + index * 7 + 3) % accounts.length];
    const createdAt = makeDateWithinDays(365, index * 250);
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
          ? {
              walletId: `${paymentMethod}-${index}`,
              type: paymentMethod,
            }
          : {},
      status,
      requestedDate: createdAt,
      approvedDate: status === "Approved" ? new Date(createdAt.getTime() + 90 * 60 * 1000) : null,
      rejectedDate: status === "Rejected" ? new Date(createdAt.getTime() + 45 * 60 * 1000) : null,
      remarks: "Load test withdrawal",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000),
    });
  }

  const transferStride = strideFor(accounts.length);
  for (let index = 0; index < SETTINGS.transfers; index += 1) {
    const fromAccount = accounts[(index * transferStride + 1) % accounts.length];
    const toAccount = accounts[(index * transferStride + 11) % accounts.length];
    if (String(fromAccount._id) === String(toAccount._id)) {
      continue;
    }

    const createdAt = new Date(baseNow - index * 5 * 60 * 1000);
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

  return { depositCount: deposits.length, withdrawalCount: withdrawals.length, transferCount: transfers.length };
}

async function seedClosedTrades(db, accounts) {
  const closedTrades = [];
  const stride = Math.max(1, Math.floor(accounts.length * 0.53) | 1);
  for (let index = 0; index < SETTINGS.closedTrades; index += 1) {
    const account = accounts[(index * stride + 5) % accounts.length];
    const closeTime = makeDateWithinDays(365, index * 400);
    const openTime = new Date(closeTime.getTime() - randomBetween(30, 600) * 60 * 1000);
    closedTrades.push({
      _id: new mongoose.Types.ObjectId(),
      mt5Account: account.mt5Account,
      positionId: `${Date.now()}-${SEED_TAG}-${index}`,
      ticket: `T${Date.now()}${index}`,
      symbol: pick(["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"], index),
      openTime,
      closeTime,
      openPrice: Number(randomBetween(1.01, 1.8).toFixed(5)),
      closePrice: Number(randomBetween(1.01, 1.8).toFixed(5)),
      profit: Number(randomBetween(-250, 450).toFixed(2)),
      volume: Number(randomBetween(0.1, 4).toFixed(2)),
      commission: Number(randomBetween(-12, -1).toFixed(2)),
      swap: Number(randomBetween(-4, 4).toFixed(2)),
      comment: "Load test trade",
      stopLoss: 0,
      targetPrice: 0,
      taxes: 0,
      oBSFlag: 0,
      uPosStatus: 0,
      uTradeFlag: 0,
      timestamp: Math.floor(closeTime.getTime() / 1000),
      openTimeSec: Math.floor(openTime.getTime() / 1000),
      commissionProcessed: index % 7 !== 0,
      processingWorkerId: null,
      processingClaimToken: null,
      processingClaimedAt: null,
      processingClaimExpiresAt: null,
      processedAt: index % 7 !== 0 ? closeTime : null,
      seedTag: SEED_TAG,
      createdAt: closeTime,
      updatedAt: closeTime,
    });
  }

  const BATCH = 2000;
  for (let i = 0; i < closedTrades.length; i += BATCH) {
    await db.collection("ibclosedtrades").insertMany(closedTrades.slice(i, i + BATCH), { ordered: false });
  }
  return closedTrades.length;
}

async function main() {
  await connectDB();
  const db = mongoose.connection.db;

  const { users, accounts } = await seedUsersAndAccounts(db);
  const cashResult = await seedCashCollections(db, accounts);
  const tradeCount = await seedClosedTrades(db, accounts);

  console.log(
    JSON.stringify(
      {
        success: true,
        seedTag: SEED_TAG,
        userCount: users.length,
        accountCount: accounts.length,
        distinctUsersWithAccounts: new Set(accounts.map((a) => String(a.user))).size,
        ...cashResult,
        closedTradeCount: tradeCount,
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
  } catch (disconnectError) {
    console.error(disconnectError);
  }
  process.exit(1);
});

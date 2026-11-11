require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { connectDB } = require("../config/db");

const BENCHMARK_USER_ID = process.env.PERF_SEED_USER_ID || "69eb5722094c9803bc5e0e83";
const SEED_TAG =
  process.env.PERF_SEED_TAG || `perf-seed-${new Date().toISOString().slice(0, 10)}`;

const SETTINGS = {
  accounts: Number.parseInt(process.env.PERF_SEED_ACCOUNTS || "80", 10),
  deposits: Number.parseInt(process.env.PERF_SEED_DEPOSITS || "4000", 10),
  withdrawals: Number.parseInt(process.env.PERF_SEED_WITHDRAWALS || "2500", 10),
  transfers: Number.parseInt(process.env.PERF_SEED_TRANSFERS || "1500", 10),
  closedTrades: Number.parseInt(process.env.PERF_SEED_CLOSED_TRADES || "5000", 10),
  partners: Number.parseInt(process.env.PERF_SEED_PARTNERS || "30", 10),
  commissionsPerPartner: Number.parseInt(
    process.env.PERF_SEED_COMMISSIONS_PER_PARTNER || "80",
    10,
  ),
};

const toObjectId = (value) => new mongoose.Types.ObjectId(value);

const pick = (items, index) => items[index % items.length];

const randomBetween = (min, max) => min + Math.random() * (max - min);

const makeDateWithinDays = (daysBack, offset = 0) => {
  const now = Date.now();
  const delta = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - delta - offset);
};

const makeMt5Account = (prefix, index) =>
  `${prefix}${String(index).padStart(7, "0")}`;

async function ensureBenchmarkProfile(db, userId) {
  const profiles = db.collection("profiles");
  const existing = await profiles.findOne({ user: userId });
  if (existing) {
    return;
  }

  await profiles.insertOne({
    user: userId,
    kycVerified: true,
    kycStatus: "verified",
    bankDetails: {
      bankName: "Seed Bank",
      accountHolderName: "Benchmark User",
      accountNumber: "1234567890",
      ifscSwiftCode: "SEED0001",
    },
    walletDetails: {
      tetherWalletAddress: "USDT-SEED-ADDRESS",
      ethWalletAddress: "ETH-SEED-ADDRESS",
      trxWalletAddress: "TRX-SEED-ADDRESS",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedAccounts(db, userId) {
  const accountsCollection = db.collection("accounts");
  const existingAccounts = await accountsCollection
    .find({ user: userId }, { projection: { _id: 1, mt5Account: 1, accountType: 1 } })
    .toArray();

  const existingCount = existingAccounts.length;
  const needed = Math.max(0, SETTINGS.accounts - existingCount);
  const newAccounts = [];
  const accountTypes = ["BASIC", "STANDARD", "VVIP"];
  const leverages = ["1:100", "1:200", "1:500"];
  const groupNames = ["BASIC", "STANDARD", "VVIP"];

  for (let index = 0; index < needed; index += 1) {
    const accountType = pick(accountTypes, existingCount + index);
    const createdAt = makeDateWithinDays(365, index * 1000);
    newAccounts.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
      mt5Account: makeMt5Account("99", existingCount + index + 1),
      investor_pwd: "seedInvestorPwd",
      master_pwd: "seedMasterPwd",
      name: `Perf Account ${existingCount + index + 1}`,
      leverage: pick(leverages, index),
      accountType,
      groupName: pick(groupNames, index),
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

  if (newAccounts.length > 0) {
    await accountsCollection.insertMany(newAccounts, { ordered: false });
  }

  const allAccounts = await accountsCollection
    .find({ user: userId }, { projection: { _id: 1, mt5Account: 1, accountType: 1, balance: 1, groupName: 1 } })
    .toArray();

  return allAccounts;
}

async function seedCashCollections(db, userId, accounts) {
  const deposits = [];
  const withdrawals = [];
  const transfers = [];
  const paymentTypes = ["bank", "usdt", "ethereum", "bitcoin"];
  const baseNow = Date.now();

  for (let index = 0; index < SETTINGS.deposits; index += 1) {
    const account = pick(accounts, index);
    const createdAt = makeDateWithinDays(365, index * 250);
    const status = index % 9 === 0 ? "Pending" : index % 13 === 0 ? "Rejected" : "Approved";
    deposits.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
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
      remarks: "Performance seed deposit",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000),
    });
  }

  for (let index = 0; index < SETTINGS.withdrawals; index += 1) {
    const account = pick(accounts, index);
    const createdAt = makeDateWithinDays(365, index * 300);
    const status = index % 8 === 0 ? "Pending" : index % 11 === 0 ? "Rejected" : "Approved";
    const paymentMethod = pick(paymentTypes, index);
    withdrawals.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
      account: account._id,
      accountNumber: account.mt5Account,
      accountType: account.accountType,
      amount: Number(randomBetween(50, 3000).toFixed(2)),
      paymentMethod,
      bankDetails:
        paymentMethod === "bank"
          ? {
              bankName: "Seed Bank",
              accountHolderName: "Benchmark User",
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
      remarks: "Performance seed withdrawal",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000),
    });
  }

  for (let index = 0; index < SETTINGS.transfers; index += 1) {
    const fromAccount = pick(accounts, index);
    const toAccount = pick(accounts, index + 1);
    if (String(fromAccount._id) === String(toAccount._id)) {
      continue;
    }

    const createdAt = new Date(baseNow - index * 10 * 60 * 1000);
    transfers.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
      fromAccount: fromAccount._id,
      toAccount: toAccount._id,
      amount: Number(randomBetween(25, 1500).toFixed(2)),
      status: index % 17 === 0 ? "Failed" : "Completed",
      seedTag: SEED_TAG,
      createdAt,
      updatedAt: createdAt,
    });
  }

  if (deposits.length) {
    await db.collection("deposits").insertMany(deposits, { ordered: false });
  }
  if (withdrawals.length) {
    await db.collection("withdrawals").insertMany(withdrawals, { ordered: false });
  }
  if (transfers.length) {
    await db.collection("transfers").insertMany(transfers, { ordered: false });
  }
}

async function ensureRootIbConfig(db, userId) {
  const collection = db.collection("ibclientconfigurations");
  let config = await collection.findOne({ userId });
  if (config) {
    return config;
  }

  const now = new Date();
  const newConfig = {
    _id: new mongoose.Types.ObjectId(),
    userId,
    referralCode: `PERF${Date.now().toString().slice(-6)}`,
    referredBy: null,
    IBbalance: 0,
    status: "active",
    level: 0,
    parent: null,
    createdAt: now,
    updatedAt: now,
  };
  await collection.insertOne(newConfig);
  return newConfig;
}

async function seedPartnersAndCommissions(db, rootUserId, rootIbConfigId) {
  const usersCollection = db.collection("users");
  const profilesCollection = db.collection("profiles");
  const accountsCollection = db.collection("accounts");
  const ibConfigsCollection = db.collection("ibclientconfigurations");
  const commissionsCollection = db.collection("ibcommissions");

  const partnerUsers = [];
  const partnerProfiles = [];
  const partnerAccounts = [];
  const partnerConfigs = [];
  const partnerAccountMap = [];
  const hashedPassword = await bcrypt.hash("PerfSeed123!", 10);

  for (let index = 0; index < SETTINGS.partners; index += 1) {
    const userId = new mongoose.Types.ObjectId();
    const configId = new mongoose.Types.ObjectId();
    const accountId = new mongoose.Types.ObjectId();
    const createdAt = makeDateWithinDays(300, index * 10000);
    const email = `perf.partner.${SEED_TAG}.${index}@example.com`;

    partnerUsers.push({
      _id: userId,
      firstName: `PerfPartner${index + 1}`,
      lastName: "Seed",
      email,
      role: "client",
      password: hashedPassword,
      country: { name: "India", state: "MH" },
      phone: `900000${String(index).padStart(4, "0")}`,
      dateofbirth: new Date("1990-01-01"),
      isEmailVerified: true,
      status: "activated",
      referredBy: null,
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    partnerProfiles.push({
      _id: new mongoose.Types.ObjectId(),
      user: userId,
      kycVerified: true,
      kycStatus: "verified",
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    partnerAccounts.push({
      _id: accountId,
      user: userId,
      mt5Account: makeMt5Account("88", index + 1),
      investor_pwd: "seedInvestorPwd",
      master_pwd: "seedMasterPwd",
      name: `Partner Perf Account ${index + 1}`,
      leverage: "1:200",
      accountType: index % 2 === 0 ? "STANDARD" : "BASIC",
      groupName: index % 2 === 0 ? "STANDARD" : "BASIC",
      platform: "MetaTrader 5",
      balance: Number(randomBetween(1000, 12000).toFixed(2)),
      equity: Number(randomBetween(1000, 12000).toFixed(2)),
      status: true,
      managerIndex: "2",
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    partnerConfigs.push({
      _id: configId,
      userId,
      referralCode: `P${SEED_TAG.replace(/[^a-zA-Z0-9]/g, "").slice(-6)}${index}`,
      referredBy: null,
      IBbalance: 0,
      status: "active",
      level: 1,
      parent: rootIbConfigId,
      createdAt,
      updatedAt: createdAt,
      seedTag: SEED_TAG,
    });

    partnerAccountMap.push({
      userId,
      accountId,
      mt5Account: makeMt5Account("88", index + 1),
      configId,
    });
  }

  if (partnerUsers.length) {
    await usersCollection.insertMany(partnerUsers, { ordered: false });
    await profilesCollection.insertMany(partnerProfiles, { ordered: false });
    await accountsCollection.insertMany(partnerAccounts, { ordered: false });
    await ibConfigsCollection.insertMany(partnerConfigs, { ordered: false });
  }

  const commissions = [];
  for (let partnerIndex = 0; partnerIndex < partnerAccountMap.length; partnerIndex += 1) {
    const partner = partnerAccountMap[partnerIndex];
    for (let commissionIndex = 0; commissionIndex < SETTINGS.commissionsPerPartner; commissionIndex += 1) {
      const createdAt = makeDateWithinDays(365, partnerIndex * 5000 + commissionIndex * 1000);
      const openTime = new Date(createdAt.getTime() - 4 * 60 * 60 * 1000);
      const closeTime = new Date(createdAt.getTime() - 2 * 60 * 60 * 1000);
      const volume = Number(randomBetween(0.1, 5).toFixed(2));
      const commissionAmount = Number((volume * randomBetween(4, 10)).toFixed(2));
      commissions.push({
        _id: new mongoose.Types.ObjectId(),
        tradeId: new mongoose.Types.ObjectId(),
        clientId: partner.userId,
        clientMT5Account: partner.mt5Account,
        ibUserId: rootUserId,
        ibConfigurationId: rootIbConfigId,
        level: 1,
        bonusPerLot: Number(randomBetween(4, 10).toFixed(2)),
        volume,
        commissionAmount,
        symbol: pick(["EURUSD", "GBPUSD", "XAUUSD", "BTCUSD"], commissionIndex),
        profit: Number(randomBetween(-500, 900).toFixed(2)),
        openTime,
        closeTime,
        openPrice: Number(randomBetween(1.05, 1.25).toFixed(5)),
        closePrice: Number(randomBetween(1.05, 1.25).toFixed(5)),
        baseAmount: volume,
        groupName: partnerIndex % 2 === 0 ? "STANDARD" : "BASIC",
        status: commissionIndex % 9 === 0 ? "pending" : "confirmed",
        processedAt: createdAt,
        batchId: `perf-batch-${partnerIndex}`,
        createdAt,
        updatedAt: createdAt,
        seedTag: SEED_TAG,
      });
    }
  }

  if (commissions.length) {
    await commissionsCollection.insertMany(commissions, { ordered: false });
  }

  return {
    partnerCount: partnerUsers.length,
    firstPartnerConfigId: partnerConfigs[0]?._id || null,
  };
}

async function seedClosedTrades(db, accounts) {
  const closedTrades = [];
  for (let index = 0; index < SETTINGS.closedTrades; index += 1) {
    const account = pick(accounts, index);
    const closeTime = makeDateWithinDays(365, index * 500);
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
      comment: "Performance seed trade",
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

  if (closedTrades.length) {
    await db.collection("ibclosedtrades").insertMany(closedTrades, {
      ordered: false,
    });
  }
}

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  const benchmarkUserId = toObjectId(BENCHMARK_USER_ID);

  const benchmarkUser = await db.collection("users").findOne({ _id: benchmarkUserId });
  if (!benchmarkUser) {
    throw new Error(`Benchmark user ${BENCHMARK_USER_ID} not found`);
  }

  await ensureBenchmarkProfile(db, benchmarkUserId);
  const accounts = await seedAccounts(db, benchmarkUserId);
  await seedCashCollections(db, benchmarkUserId, accounts);
  await seedClosedTrades(db, accounts);
  const rootIbConfig = await ensureRootIbConfig(db, benchmarkUserId);
  const partnerResult = await seedPartnersAndCommissions(
    db,
    benchmarkUserId,
    rootIbConfig._id,
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        seedTag: SEED_TAG,
        benchmarkUserId: BENCHMARK_USER_ID,
        accountCount: accounts.length,
        insertedTargets: SETTINGS,
        firstPartnerConfigId: partnerResult.firstPartnerConfigId,
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

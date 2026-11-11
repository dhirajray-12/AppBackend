// backend/scripts/createDummyDownlineAndTest.js
// One-off: create a dummy test client, link them as a referred downline under
// a given root IB (mirrors the real signup-via-referral-code flow), assign
// their commission, place 100 dummy closed trades on their account, then run
// the real commission pipeline over those trades.
//
// Run with: node scripts/createDummyDownlineAndTest.js <rootUserId> <downlineMaxCommission>

const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const Account = require("../models/client/Account");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBClosedTrades = require("../models/IBClosedTrade");
const IBCommission = require("../models/IBCommission");
const tradeSyncService = require("../services/tradeSyncService");

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "AUDUSD", "USDCAD", "NZDUSD", "EURJPY"];
const randomBetween = (min, max) => Math.random() * (max - min) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function run() {
  const [rootUserId, downlineMaxArg] = process.argv.slice(2);
  const downlineMax = parseFloat(downlineMaxArg);

  if (!rootUserId || isNaN(downlineMax)) {
    console.error(
      "Usage: node scripts/createDummyDownlineAndTest.js <rootUserId> <downlineMaxCommission>",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("📊 Connected to MongoDB");

  const rootUser = await User.findById(rootUserId).select("firstName lastName email").lean();
  const rootConfig = await IBClientConfiguration.findOne({ userId: rootUserId });

  if (!rootUser || !rootConfig) {
    console.error(`❌ Root user/IB config not found for ${rootUserId}`);
    process.exit(1);
  }
  if (rootConfig.maximumCommission == null) {
    console.error("❌ Root IB has no maximumCommission assigned yet");
    process.exit(1);
  }
  if (downlineMax > rootConfig.maximumCommission) {
    console.error(
      `❌ ${downlineMax} exceeds the root IB's own maximum of ${rootConfig.maximumCommission}`,
    );
    process.exit(1);
  }

  const rootAccount = await Account.findOne({ user: rootUserId }).select("groupName").lean();
  const groupName = rootAccount?.groupName || "SK GROUP\\M8\\GROUP6";

  const runTag = Date.now();
  const dummyEmail = `dummy.subib.${runTag}@testdomain.local`;

  const downlineUser = await User.create({
    firstName: "DummySubIB",
    lastName: `Test${runTag}`,
    email: dummyEmail,
    password: "DummyPass123!",
    country: { name: "Test Country" },
    phone: "0000000000",
    dateofbirth: new Date("1990-01-01"),
    role: "client",
    referredBy: rootConfig.referralCode,
  });

  const downlineAccount = await Account.create({
    user: downlineUser._id,
    mt5Account: `DUMMY${runTag}`,
    investor_pwd: "dummy",
    master_pwd: "dummy",
    name: `${downlineUser.firstName} ${downlineUser.lastName}`,
    leverage: "1:100",
    accountType: "STANDARD",
    groupName,
    balance: 1000,
    status: true,
  });

  const downlineConfig = await IBClientConfiguration.create({
    userId: downlineUser._id,
    referralCode: null,
    parent: rootConfig._id,
    level: rootConfig.level + 1,
    status: "active",
    referredBy: rootConfig.referralCode,
    maximumCommission: downlineMax,
  });

  console.log(
    `✅ Created dummy downline ${downlineUser.email} (account ${downlineAccount.mt5Account}), referred by ${rootUser.firstName} ${rootUser.lastName}, maximumCommission=${downlineMax}`,
  );

  // Clean up the earlier (wrongly-placed) dummy trades on the root's own account.
  const removed = await IBClosedTrades.deleteMany({
    comment: "DUMMY_TEST_DATA",
    mt5Account: rootAccount ? undefined : undefined, // no-op filter placeholder
  });

  const trades = [];
  const now = Date.now();
  for (let i = 0; i < 100; i++) {
    const closeTime = new Date(now - Math.floor(randomBetween(0, 30 * 24 * 60 * 60 * 1000)));
    const heldMs = randomBetween(5 * 60 * 1000, 6 * 60 * 60 * 1000);
    const openTime = new Date(closeTime.getTime() - heldMs);
    const openPrice = parseFloat(randomBetween(1, 2000).toFixed(5));
    const closePrice = parseFloat((openPrice + randomBetween(-0.01, 0.01) * openPrice).toFixed(5));
    const volume = parseFloat(randomBetween(0.01, 2).toFixed(2));
    const profit = parseFloat(randomBetween(-200, 400).toFixed(2));

    trades.push({
      mt5Account: downlineAccount.mt5Account,
      positionId: `DUMMY-${runTag}-${i}`,
      ticket: `DUMMY-${runTag}-${i}`,
      symbol: pick(SYMBOLS),
      openTime,
      closeTime,
      openPrice,
      closePrice,
      profit,
      volume,
      commission: 0,
      swap: 0,
      comment: "DUMMY_TEST_DATA",
      timestamp: Math.floor(closeTime.getTime() / 1000),
      openTimeSec: Math.floor(openTime.getTime() / 1000),
      commissionProcessed: false,
    });
  }

  await IBClosedTrades.insertMany(trades, { ordered: false });
  console.log(`✅ Inserted ${trades.length} dummy closed trades on ${downlineAccount.mt5Account}`);

  const unprocessedTrades = await IBClosedTrades.find({
    mt5Account: downlineAccount.mt5Account,
    commissionProcessed: false,
  }).lean();

  console.log(`⚙️  Running commission pipeline over ${unprocessedTrades.length} trades...`);
  const batchId = `dummy-downline-${runTag}`;
  await tradeSyncService.calculateCommissionsBatch(unprocessedTrades, batchId);

  const commissions = await IBCommission.find({ batchId }).lean();
  const totalsByLevel = new Map();
  for (const c of commissions) {
    totalsByLevel.set(c.level, (totalsByLevel.get(c.level) || 0) + c.commissionAmount);
  }

  console.log(`\n✅ Created ${commissions.length} IBCommission records in batch ${batchId}`);
  for (const [level, total] of [...totalsByLevel.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`   Level ${level}: $${total.toFixed(2)} total`);
  }
  const grandTotal = commissions.reduce((sum, c) => sum + c.commissionAmount, 0);
  console.log(`   Grand total commission paid: $${grandTotal.toFixed(2)}`);
  console.log(`\nDummy downline user id: ${downlineUser._id}`);
  console.log(`Dummy downline IBClientConfiguration id: ${downlineConfig._id}`);
  console.log(`Dummy downline account mt5Account: ${downlineAccount.mt5Account}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error("❌ Failed:", error);
  process.exit(1);
});

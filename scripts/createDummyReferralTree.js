// backend/scripts/createDummyReferralTree.js
//
// One-off: build a dummy 5-level referral (IB) tree under an existing root
// IB user, mirroring the real signup-via-referral-code flow. Two parallel
// chains ("A" and "B") run down from the root, each 5 levels deep, so every
// level has exactly 2 users:
//
//   Root
//    ├── A1 → A2 → A3 → A4 → A5
//    └── B1 → B2 → B3 → B4 → B5
//
// Every user (root + all 10 downline users) gets an MT5 account and a batch
// of randomized closed trades. The real commission pipeline
// (tradeSyncService.calculateCommissionsBatch) is then run over all of it,
// so every non-leaf user (root through level 4 of each chain) ends up with
// real IBCommission rows earned from their chain's trades below them.
//
// Run with: node scripts/createDummyReferralTree.js <rootUserId>

const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const Account = require("../models/client/Account");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBClosedTrades = require("../models/IBClosedTrade");
const IBCommission = require("../models/IBCommission");
const tradeSyncService = require("../services/tradeSyncService");

const LEVELS = 5;
const CHAINS = ["A", "B"];
const TRADES_PER_ACCOUNT = 20;
const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "AUDUSD", "USDCAD", "NZDUSD", "EURJPY"];

const randomBetween = (min, max) => Math.random() * (max - min) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function makeTrades(mt5Account, runTag, chainTag) {
  const trades = [];
  const now = Date.now();
  for (let i = 0; i < TRADES_PER_ACCOUNT; i++) {
    const closeTime = new Date(now - Math.floor(randomBetween(0, 30 * 24 * 60 * 60 * 1000)));
    const heldMs = randomBetween(5 * 60 * 1000, 6 * 60 * 60 * 1000);
    const openTime = new Date(closeTime.getTime() - heldMs);
    const openPrice = parseFloat(randomBetween(1, 2000).toFixed(5));
    const closePrice = parseFloat((openPrice + randomBetween(-0.01, 0.01) * openPrice).toFixed(5));
    const volume = parseFloat(randomBetween(0.05, 3).toFixed(2));
    const profit = parseFloat(randomBetween(-200, 400).toFixed(2));

    trades.push({
      mt5Account,
      positionId: `DUMMY-${runTag}-${chainTag}-${i}`,
      ticket: `DUMMY-${runTag}-${chainTag}-${i}`,
      symbol: pick(SYMBOLS),
      openTime,
      closeTime,
      openPrice,
      closePrice,
      profit,
      volume,
      commission: 0,
      swap: 0,
      comment: "DUMMY_REFERRAL_TREE",
      timestamp: Math.floor(closeTime.getTime() / 1000),
      openTimeSec: Math.floor(openTime.getTime() / 1000),
      commissionProcessed: false,
    });
  }
  return trades;
}

async function run() {
  const [rootUserId] = process.argv.slice(2);
  if (!rootUserId) {
    console.error("Usage: node scripts/createDummyReferralTree.js <rootUserId>");
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
  if (rootConfig.status !== "active") {
    rootConfig.status = "active";
    await rootConfig.save();
    console.log("ℹ️  Root IB config was not active — activated it.");
  }

  const rootAccount = await Account.findOne({ user: rootUserId }).select("groupName").lean();
  const groupName = rootAccount?.groupName || "SK GROUP\\M8\\GROUP7"; // VVIP (flat mode, levels 1-10 configured)

  const runTag = Date.now();
  const allTrades = [];
  const createdUsers = [];

  if (rootAccount) {
    allTrades.push(...makeTrades(
      (await Account.findOne({ user: rootUserId }).select("mt5Account").lean()).mt5Account,
      runTag,
      "ROOT",
    ));
  }

  for (const chain of CHAINS) {
    let parentConfig = rootConfig;
    let parentReferralCode = rootConfig.referralCode;

    for (let level = 1; level <= LEVELS; level++) {
      const tag = `${chain}${level}-${runTag}`;
      const emailTag = `${chain}${level}.${runTag}`;
      const email = `dummy.ib.${emailTag}@testdomain.local`;

      const user = await User.create({
        firstName: `DummyIB${chain}${level}`,
        lastName: `Test${runTag}`,
        email,
        password: "DummyPass123!",
        country: { name: "Test Country" },
        phone: "0000000000",
        dateofbirth: new Date("1990-01-01"),
        role: "client",
        referredBy: parentReferralCode,
      });

      const mt5Account = `DUMMY${tag}`;
      const account = await Account.create({
        user: user._id,
        mt5Account,
        investor_pwd: "dummy",
        master_pwd: "dummy",
        name: `${user.firstName} ${user.lastName}`,
        leverage: "1:100",
        accountType: "STANDARD",
        groupName,
        balance: 1000,
        status: true,
      });

      const referralCode = `DUM${tag}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
      const config = await IBClientConfiguration.create({
        userId: user._id,
        referralCode,
        parent: parentConfig._id,
        level,
        status: "active",
        referredBy: parentReferralCode,
        maximumCommission: null, // unused in flat mode
      });

      console.log(
        `✅ Chain ${chain} level ${level}: ${user.email} (account ${mt5Account}), referred by ${parentReferralCode}`,
      );

      allTrades.push(...makeTrades(mt5Account, runTag, tag));
      createdUsers.push({ chain, level, userId: user._id, email: user.email, mt5Account, configId: config._id });

      parentConfig = config;
      parentReferralCode = referralCode;
    }
  }

  await IBClosedTrades.insertMany(allTrades, { ordered: false });
  console.log(`\n✅ Inserted ${allTrades.length} dummy closed trades across ${CHAINS.length * LEVELS + (rootAccount ? 1 : 0)} accounts`);

  const mt5Accounts = allTrades.map((t) => t.mt5Account);
  const unprocessedTrades = await IBClosedTrades.find({
    mt5Account: { $in: [...new Set(mt5Accounts)] },
    commissionProcessed: false,
  }).lean();

  console.log(`⚙️  Running commission pipeline over ${unprocessedTrades.length} trades...`);
  const batchId = `dummy-referral-tree-${runTag}`;
  await tradeSyncService.calculateCommissionsBatch(unprocessedTrades, batchId);

  const commissions = await IBCommission.find({ batchId }).lean();
  const totalsByIb = new Map();
  for (const c of commissions) {
    const key = c.ibUserId.toString();
    totalsByIb.set(key, (totalsByIb.get(key) || 0) + c.commissionAmount);
  }

  console.log(`\n✅ Created ${commissions.length} IBCommission records in batch ${batchId}`);
  console.log(`\nCommission earned per IB:`);
  console.log(`   ${rootUser.firstName} ${rootUser.lastName} (root): $${(totalsByIb.get(rootUserId.toString()) || 0).toFixed(2)}`);
  for (const u of createdUsers) {
    const total = totalsByIb.get(u.userId.toString()) || 0;
    console.log(`   Chain ${u.chain} level ${u.level} (${u.email}): $${total.toFixed(2)}`);
  }
  const grandTotal = commissions.reduce((sum, c) => sum + c.commissionAmount, 0);
  console.log(`\n   Grand total commission paid: $${grandTotal.toFixed(2)}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error("❌ Failed:", error);
  process.exit(1);
});

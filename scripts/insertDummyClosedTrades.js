// backend/scripts/insertDummyClosedTrades.js
// One-off: insert dummy IBClosedTrades for a specific user's account, for
// testing the commission pipeline end-to-end. Trades are tagged with
// comment "DUMMY_TEST_DATA" so they can be found/removed later, e.g.:
//   db.ibclosedtrades.deleteMany({ comment: "DUMMY_TEST_DATA" })
//
// Run with: node scripts/insertDummyClosedTrades.js <userId> [count]

const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const Account = require("../models/client/Account");
const IBClosedTrades = require("../models/IBClosedTrade");

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "AUDUSD", "USDCAD", "NZDUSD", "EURJPY"];

const randomBetween = (min, max) => Math.random() * (max - min) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function run() {
  const userId = process.argv[2];
  const count = parseInt(process.argv[3], 10) || 100;

  if (!userId) {
    console.error("Usage: node scripts/insertDummyClosedTrades.js <userId> [count]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("📊 Connected to MongoDB");

  const user = await User.findById(userId).select("firstName lastName email").lean();
  if (!user) {
    console.error(`❌ No user found with id ${userId}`);
    process.exit(1);
  }

  const account = await Account.findOne({ user: userId, status: true })
    .sort({ balance: -1 })
    .select("mt5Account groupName")
    .lean();

  if (!account) {
    console.error(`❌ No active account found for user ${user.email}`);
    process.exit(1);
  }

  console.log(
    `👤 ${user.firstName} ${user.lastName} (${user.email}) — using account ${account.mt5Account} (${account.groupName})`,
  );

  const now = Date.now();
  const runTag = now; // keeps positionIds unique across repeated runs
  const trades = [];

  for (let i = 0; i < count; i++) {
    // Spread trades over the last 30 days, each held between 5 minutes and 6 hours.
    const closeTime = new Date(now - Math.floor(randomBetween(0, 30 * 24 * 60 * 60 * 1000)));
    const heldMs = randomBetween(5 * 60 * 1000, 6 * 60 * 60 * 1000);
    const openTime = new Date(closeTime.getTime() - heldMs);

    const openPrice = parseFloat(randomBetween(1, 2000).toFixed(5));
    const priceDelta = randomBetween(-0.01, 0.01) * openPrice;
    const closePrice = parseFloat((openPrice + priceDelta).toFixed(5));
    const volume = parseFloat(randomBetween(0.01, 2).toFixed(2));
    const profit = parseFloat(randomBetween(-200, 400).toFixed(2));

    trades.push({
      mt5Account: account.mt5Account,
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

  const result = await IBClosedTrades.insertMany(trades, { ordered: false });
  console.log(`✅ Inserted ${result.length} dummy closed trades for account ${account.mt5Account}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error("❌ Failed to insert dummy trades:", error);
  process.exit(1);
});

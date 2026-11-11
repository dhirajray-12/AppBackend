// backend/scripts/assignAndProcessDummyCommission.js
// One-off: assign a root IB's maximumCommission, then run the real commission
// pipeline (tradeSyncService.calculateCommissionsBatch) over their unprocessed
// closed trades — no MT5 sync involved, just DB -> commission calc -> DB.
//
// Run with: node scripts/assignAndProcessDummyCommission.js <userId> <groupId> <maximumCommission>

const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBAdminConfiguration = require("../models/admin/IBAdminConfiguration");
const IBClosedTrades = require("../models/IBClosedTrade");
const IBCommission = require("../models/IBCommission");
const tradeSyncService = require("../services/tradeSyncService");

async function run() {
  const [userId, groupId, maxCommissionArg] = process.argv.slice(2);
  const maximumCommission = parseFloat(maxCommissionArg);

  if (!userId || !groupId || isNaN(maximumCommission)) {
    console.error(
      "Usage: node scripts/assignAndProcessDummyCommission.js <userId> <groupId> <maximumCommission>",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("📊 Connected to MongoDB");

  const user = await User.findById(userId).select("firstName lastName email").lean();
  if (!user) {
    console.error(`❌ No user found with id ${userId}`);
    process.exit(1);
  }

  const groupConfig = await IBAdminConfiguration.findOne({
    groupId,
    maximumCommission: { $exists: true },
  }).lean();
  if (!groupConfig) {
    console.error(`❌ No commission ceiling configured for group ${groupId}`);
    process.exit(1);
  }
  if (maximumCommission > groupConfig.maximumCommission) {
    console.error(
      `❌ ${maximumCommission} exceeds the group ceiling of ${groupConfig.maximumCommission}`,
    );
    process.exit(1);
  }

  let ibConfig = await IBClientConfiguration.findOne({ userId });
  if (!ibConfig) {
    console.error(`❌ No IBClientConfiguration found for user ${userId}`);
    process.exit(1);
  }
  if (ibConfig.parent) {
    console.error(`❌ This user has a parent IB — not a root IB, use the Sub-IB assign flow instead`);
    process.exit(1);
  }

  ibConfig.maximumCommission = maximumCommission;
  ibConfig.groupId = groupId;
  if (ibConfig.status === "pending") ibConfig.status = "active";
  await ibConfig.save();

  console.log(
    `✅ Assigned maximumCommission=${maximumCommission} to ${user.firstName} ${user.lastName} (${user.email}), group ceiling ${groupConfig.maximumCommission}`,
  );

  const unprocessedTrades = await IBClosedTrades.find({
    comment: "DUMMY_TEST_DATA",
    commissionProcessed: false,
  }).lean();

  if (unprocessedTrades.length === 0) {
    console.log("ℹ️ No unprocessed dummy trades found.");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`⚙️  Running commission pipeline over ${unprocessedTrades.length} dummy trades...`);
  const batchId = `dummy-${Date.now()}`;
  await tradeSyncService.calculateCommissionsBatch(unprocessedTrades, batchId);

  const commissions = await IBCommission.find({ batchId })
    .select("ibUserId level bonusPerLot volume commissionAmount")
    .lean();

  const totalsByLevel = new Map();
  for (const c of commissions) {
    const key = c.level;
    totalsByLevel.set(key, (totalsByLevel.get(key) || 0) + c.commissionAmount);
  }

  console.log(`\n✅ Created ${commissions.length} IBCommission records in batch ${batchId}`);
  for (const [level, total] of [...totalsByLevel.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`   Level ${level}: $${total.toFixed(2)} total`);
  }
  const grandTotal = commissions.reduce((sum, c) => sum + c.commissionAmount, 0);
  console.log(`   Grand total commission paid: $${grandTotal.toFixed(2)}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error("❌ Failed:", error);
  process.exit(1);
});

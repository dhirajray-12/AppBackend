// backend/scripts/testFlatHoldingTime.js
// One-off integration check: proves that when an admin sets the "Default
// Holding Time" for a Normal Commission (flat) group with only a single
// level's bonusPerLot configured, tradeSyncService's real preload +
// per-trade commission logic actually enforces it - a trade held under
// the minimum earns nothing, one held over it earns bonusPerLot * volume.
// Creates temporary fixtures and deletes them all afterward.
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Group = require("../models/Group");
const User = require("../models/User");
const Account = require("../models/client/Account");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const IBFlatCommissionConfiguration = require("../models/admin/IBFlatCommissionConfiguration");
const tradeSyncService = require("../services/tradeSyncService");

const MIN_HOLD_SECONDS = 120;
const BONUS_PER_LOT = 5;

async function main() {
  await connectDB();
  const created = { groupId: null, userIds: [], accountId: null, ibConfigIds: [], flatConfigId: null };

  try {
    // ── Fixtures ──
    const group = await Group.create({
      name: `TEST_FLAT_HOLD_${Date.now()}`,
      value: `test_flat_hold_${Date.now()}`,
      description: "temp test group",
      commissionMode: "flat",
    });
    created.groupId = group._id;

    // Admin sets ONLY level 1's bonus + the holding time (mirrors the
    // frontend fix: level 1 is always persisted so the time has a home).
    const flatConfig = await IBFlatCommissionConfiguration.create({
      groupId: group._id,
      level: 1,
      bonusPerLot: BONUS_PER_LOT,
      defaultTimeInSeconds: MIN_HOLD_SECONDS,
    });
    created.flatConfigId = flatConfig._id;

    const baseUserFields = {
      password: "TempPassw0rd!",
      country: { name: "Testland" },
      phone: "+10000000000",
      dateofbirth: new Date("1990-01-01"),
      role: "client",
    };

    const clientUser = await User.create({
      ...baseUserFields,
      firstName: "Test",
      lastName: "Client",
      email: `test.client.${Date.now()}@example.com`,
    });
    created.userIds.push(clientUser._id);

    const ibUser = await User.create({
      ...baseUserFields,
      firstName: "Test",
      lastName: "IB",
      email: `test.ib.${Date.now()}@example.com`,
    });
    created.userIds.push(ibUser._id);

    const ibConfig = await IBClientConfiguration.create({
      userId: ibUser._id,
      status: "active",
      level: 0,
      parent: null,
    });
    created.ibConfigIds.push(ibConfig._id);

    const clientConfig = await IBClientConfiguration.create({
      userId: clientUser._id,
      status: "active",
      level: 1,
      parent: ibConfig._id,
    });
    created.ibConfigIds.push(clientConfig._id);

    const account = await Account.create({
      user: clientUser._id,
      mt5Account: `TESTACC${Date.now()}`,
      investor_pwd: "x",
      master_pwd: "x",
      name: "Test Account",
      leverage: "1:100",
      accountType: "STANDARD",
      groupName: group.value,
      status: true,
      managerIndex: "1",
    });
    created.accountId = account._id;

    // ── Run the real service logic ──
    const service = tradeSyncService;

    const makeTrade = (heldSeconds) => {
      const closeTime = new Date();
      const openTime = new Date(closeTime.getTime() - heldSeconds * 1000);
      return {
        _id: new mongoose.Types.ObjectId(),
        mt5Account: account.mt5Account,
        volume: 2,
        symbol: "EURUSD",
        profit: 10,
        openTime,
        closeTime,
        openPrice: 1.1,
        closePrice: 1.2,
        positionId: "test-position",
      };
    };

    const shortTrade = makeTrade(MIN_HOLD_SECONDS - 60); // held 60s, below minimum
    const longTrade = makeTrade(MIN_HOLD_SECONDS + 60); // held 180s, above minimum

    const context = await service.preloadCommissionContext([shortTrade, longTrade]);

    console.log("\n── Preloaded context checks ──");
    const resolvedGroupId = context.groupIdByName.get(account.groupName);
    console.log("groupId resolved from account.groupName:", resolvedGroupId === group._id.toString() ? "✅" : `❌ (${resolvedGroupId})`);
    console.log("commissionMode:", context.commissionModeByGroupId.get(resolvedGroupId));
    console.log("minHoldSecondsByGroupName:", context.minHoldSecondsByGroupName.get(account.groupName));

    const shortResult = await service.processTradeCommissionsBatch(shortTrade, "test-batch", context);
    const longResult = await service.processTradeCommissionsBatch(longTrade, "test-batch", context);

    console.log("\n── Short trade (held below minimum) ──");
    console.log("tradeAction:", shortResult.tradeAction, "| commissionOperations:", shortResult.commissionOperations.length);
    const shortOk = shortResult.tradeAction === "processed" && shortResult.commissionOperations.length === 0;
    console.log(shortOk ? "✅ No commission paid, as expected" : "❌ UNEXPECTED: commission was created for an under-held trade");

    console.log("\n── Long trade (held above minimum) ──");
    console.log("tradeAction:", longResult.tradeAction, "| commissionOperations:", longResult.commissionOperations.length);
    if (longResult.commissionOperations.length > 0) {
      const op = longResult.commissionOperations[0];
      const expectedAmount = BONUS_PER_LOT * longTrade.volume;
      console.log(`commissionAmount: ${op.commissionAmount} (expected ${expectedAmount})`, op.commissionAmount === expectedAmount ? "✅" : "❌");
    } else {
      console.log("❌ UNEXPECTED: no commission created for a trade held above the minimum");
    }

    const overallPass =
      shortOk &&
      longResult.commissionOperations.length === 1 &&
      longResult.commissionOperations[0].commissionAmount === BONUS_PER_LOT * longTrade.volume;

    console.log(`\n${overallPass ? "✅ PASS" : "❌ FAIL"}: Normal Commission holding time is enforced end-to-end.`);
  } finally {
    // ── Cleanup ──
    if (created.accountId) await Account.deleteOne({ _id: created.accountId });
    if (created.ibConfigIds.length) await IBClientConfiguration.deleteMany({ _id: { $in: created.ibConfigIds } });
    if (created.userIds.length) await User.deleteMany({ _id: { $in: created.userIds } });
    if (created.flatConfigId) await IBFlatCommissionConfiguration.deleteOne({ _id: created.flatConfigId });
    if (created.groupId) await Group.deleteOne({ _id: created.groupId });
    console.log("\n🧹 Cleaned up all temporary test fixtures.");
    await mongoose.connection.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });

// backend/scripts/verifyCommissionMath.js
// Pure unit-test of the new per-user commission math in tradeSyncService,
// simulating the PDF's worked example:
//   A=65, B=60, C=50, E=35, client trades 1 lot -> A=5, B=10, C=15, E=35 (total 65)
//
// createCommissionRecordBatch() does no DB/network calls itself, so we can call
// it directly against fabricated hierarchy data. Run with: node scripts/verifyCommissionMath.js

const tradeSyncService = require("../services/tradeSyncService");

function makeConfig(id, maximumCommission) {
  return { _id: id, userId: { _id: `user_${id}` }, maximumCommission };
}

async function run() {
  // hierarchy[0] = nearest to client (E), hierarchy[last] = root (A)
  const hierarchy = [
    makeConfig("E", 35),
    makeConfig("C", 50),
    makeConfig("B", 60),
    makeConfig("A", 65),
  ];

  const trade = { volume: 1, symbol: "EURUSD", profit: 10, openTime: new Date(), closeTime: new Date(), openPrice: 1, closePrice: 1, _id: "trade1" };
  const account = { user: { _id: "client1" }, groupName: "Standard" };

  const expected = { E: 35, C: 15, B: 10, A: 5 };
  let total = 0;
  let allPassed = true;

  for (let i = 0; i < hierarchy.length; i++) {
    const result = await tradeSyncService.createCommissionRecordBatch(
      trade,
      account,
      hierarchy,
      i,
      "batch1",
    );

    const id = hierarchy[i]._id;
    const amount = result.commissionOperation.commissionAmount;
    total += amount;
    const pass = amount === expected[id];
    allPassed = allPassed && pass;
    console.log(`${pass ? "✅" : "❌"} ${id}: got ${amount}, expected ${expected[id]}`);
  }

  console.log(`\nTotal: ${total} (expected 65)`);
  allPassed = allPassed && total === 65;

  // Pending case: last-mile IB unassigned -> must retry, not pay anyone
  const pendingHierarchy = [makeConfig("F", null), makeConfig("A", 65)];
  const pendingResult = await tradeSyncService.createCommissionRecordBatch(
    trade,
    account,
    pendingHierarchy,
    0,
    "batch1",
  );
  const pendingPass = pendingResult.status === "retry";
  allPassed = allPassed && pendingPass;
  console.log(
    `${pendingPass ? "✅" : "❌"} unassigned Sub-IB blocks payout (status=${pendingResult.status})`,
  );

  // Ancestor above an unassigned child must also retry (can't compute the diff)
  const ancestorBlockedResult = await tradeSyncService.createCommissionRecordBatch(
    trade,
    account,
    pendingHierarchy,
    1,
    "batch1",
  );
  const ancestorPass = ancestorBlockedResult.status === "retry";
  allPassed = allPassed && ancestorPass;
  console.log(
    `${ancestorPass ? "✅" : "❌"} ancestor above unassigned child also blocked (status=${ancestorBlockedResult.status})`,
  );

  console.log(allPassed ? "\n✅ ALL CHECKS PASSED" : "\n❌ SOME CHECKS FAILED");
  process.exit(allPassed ? 0 : 1);
}

run().catch((error) => {
  console.error("❌ Verification script errored:", error);
  process.exit(1);
});

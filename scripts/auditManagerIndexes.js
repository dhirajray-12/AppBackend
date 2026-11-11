// backend/scripts/auditManagerIndexes.js
// Read-only diagnostic: groups Account documents by their stored
// managerIndex so we can see which accounts don't match the currently
// configured MANAGER_INDEX/Manager_Index env value (the accountSyncService
// uses each account's own managerIndex field, not just the env default, so
// stale/mismatched values here cause "API Error for manager N" failures
// against an MT5 manager that isn't actually configured).
require("dotenv").config();

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Account = require("../models/client/Account");

async function main() {
  await connectDB();

  const configuredManagerIndex = process.env.MANAGER_INDEX || process.env.Manager_Index || "1";
  console.log(`\nConfigured MANAGER_INDEX (env): ${configuredManagerIndex}`);

  const grouped = await Account.aggregate([
    {
      $group: {
        _id: "$managerIndex",
        count: { $sum: 1 },
        sampleMt5Accounts: { $push: "$mt5Account" },
        statuses: { $addToSet: "$status" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  console.log("\nAccounts grouped by stored managerIndex:");
  console.table(
    grouped.map((g) => ({
      managerIndex: g._id === null || g._id === undefined ? "(missing)" : g._id,
      count: g.count,
      statuses: g.statuses.join(", "),
      sampleMt5Accounts: g.sampleMt5Accounts.slice(0, 5).join(", "),
    })),
  );

  const mismatched = grouped.filter(
    (g) => String(g._id) !== String(configuredManagerIndex) && g._id != null,
  );

  if (mismatched.length > 0) {
    console.log(
      `\n⚠️  ${mismatched.reduce((sum, g) => sum + g.count, 0)} account(s) have a managerIndex ` +
        `that doesn't match the configured ${configuredManagerIndex} — these are the ones ` +
        `causing "API Error for manager N" during sync.`,
    );

    for (const group of mismatched) {
      const examples = await Account.find({ managerIndex: group._id })
        .select("mt5Account managerIndex status createdAt user")
        .limit(10)
        .lean();
      console.log(`\nmanagerIndex = ${group._id} (showing up to 10 of ${group.count}):`);
      console.table(
        examples.map((a) => ({
          mt5Account: a.mt5Account,
          status: a.status,
          createdAt: a.createdAt?.toISOString?.() || a.createdAt,
          userId: a.user?.toString(),
        })),
      );
    }
  } else {
    console.log("\n✅ No mismatched accounts found — every account matches the configured manager.");
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error) => {
  console.error("Audit failed:", error);
  process.exit(1);
});

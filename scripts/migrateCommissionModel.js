// backend/scripts/migrateCommissionModel.js
// One-off migration: level-based IBAdminConfiguration -> per-Group maximumCommission ceiling.
//
// What it does:
//   1. For each Group with old level-based configs (collection: ibadminconfigurations,
//      docs shaped {groupId, level, bonusPerLot}), collapses them into one ceiling doc
//      {groupId, maximumCommission: max(bonusPerLot across levels), defaultTimeInSeconds}.
//   2. For each existing ROOT IBClientConfiguration (parent: null), sets
//      maximumCommission = that user's account group's new ceiling, inferred from
//      their existing Account.groupName. Left null (pending admin assignment) if no
//      matching group/account can be found.
//   3. Leaves every existing NON-ROOT IBClientConfiguration's maximumCommission as null
//      (pending) — there is no historical record of what a specific parent granted a
//      specific child under the old flat-rate system, so these fall into the new
//      pending-assignment queue for IBs/admins to re-balance via the new UI.
//
// This does NOT run automatically. Run manually with: node scripts/migrateCommissionModel.js
// Review the dry-run output first (default), then re-run with --apply to write changes.

const mongoose = require("mongoose");
require("dotenv").config();

const IBAdminConfiguration = require("../models/admin/IBAdminConfiguration");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const Group = require("../models/Group");
const Account = require("../models/client/Account");

const APPLY = process.argv.includes("--apply");

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`📊 Connected to MongoDB (${APPLY ? "APPLY" : "DRY RUN"} mode)`);

  const db = mongoose.connection.db;
  const rawConfigs = await db
    .collection("ibadminconfigurations")
    .find({})
    .toArray();

  const isOldShape = rawConfigs.some((doc) => doc.level !== undefined);
  if (!isOldShape) {
    console.log(
      "ℹ️ No old level-based IBAdminConfiguration docs found — nothing to collapse. " +
        "(Schema may already be migrated, or this is a fresh install.)",
    );
  }

  // Step 1: collapse level-based configs into one ceiling per group.
  const byGroup = new Map();
  for (const doc of rawConfigs) {
    if (doc.level === undefined) continue; // already new-shape, skip
    const key = doc.groupId.toString();
    const existing = byGroup.get(key) || {
      groupId: doc.groupId,
      maximumCommission: 0,
      defaultTimeInSeconds: doc.defaultTimeInSeconds || 0,
    };
    existing.maximumCommission = Math.max(
      existing.maximumCommission,
      doc.bonusPerLot || 0,
    );
    byGroup.set(key, existing);
  }

  console.log(`\n=== Step 1: Group ceilings (${byGroup.size} groups) ===`);
  for (const [groupId, ceiling] of byGroup) {
    console.log(
      `  Group ${groupId}: maximumCommission=${ceiling.maximumCommission}, defaultTimeInSeconds=${ceiling.defaultTimeInSeconds}`,
    );
  }

  if (APPLY) {
    for (const doc of rawConfigs) {
      if (doc.level === undefined) continue;
      await db.collection("ibadminconfigurations").deleteOne({ _id: doc._id });
    }
    for (const ceiling of byGroup.values()) {
      await IBAdminConfiguration.findOneAndUpdate(
        { groupId: ceiling.groupId },
        {
          groupId: ceiling.groupId,
          maximumCommission: ceiling.maximumCommission,
          defaultTimeInSeconds: ceiling.defaultTimeInSeconds,
        },
        { upsert: true, new: true },
      );
    }
    console.log("  ✅ Applied.");
  }

  // Step 2: assign root IBs their group's new ceiling (best-effort).
  const rootConfigs = await IBClientConfiguration.find({
    parent: null,
    maximumCommission: null,
  }).lean();

  const groups = await Group.find({}).lean();
  const groupByNameOrValue = new Map();
  for (const g of groups) {
    if (g.name) groupByNameOrValue.set(g.name, g);
    if (g.value) groupByNameOrValue.set(g.value, g);
  }

  console.log(`\n=== Step 2: Root IBs (${rootConfigs.length} found) ===`);
  let assigned = 0;
  let skipped = 0;
  for (const rootConfig of rootConfigs) {
    const account = await Account.findOne({ user: rootConfig.userId })
      .select("groupName")
      .lean();
    const group = account ? groupByNameOrValue.get(account.groupName) : null;
    const ceiling = group ? byGroup.get(group._id.toString()) : null;

    if (!ceiling) {
      console.log(
        `  ⏭️  Root IB ${rootConfig.userId} — no matching group/ceiling found, left pending.`,
      );
      skipped += 1;
      continue;
    }

    console.log(
      `  ✅ Root IB ${rootConfig.userId} → group ${group.name || group.value}, maximumCommission=${ceiling.maximumCommission}`,
    );
    assigned += 1;

    if (APPLY) {
      await IBClientConfiguration.updateOne(
        { _id: rootConfig._id },
        { maximumCommission: ceiling.maximumCommission, groupId: group._id },
      );
    }
  }

  console.log(`\n  Assigned: ${assigned}, left pending: ${skipped}`);

  // Step 3: non-root configs are intentionally left as-is (maximumCommission: null).
  const pendingNonRootCount = await IBClientConfiguration.countDocuments({
    parent: { $ne: null },
    maximumCommission: null,
  });
  console.log(
    `\n=== Step 3: Non-root IBs left pending assignment: ${pendingNonRootCount} ===`,
  );
  console.log(
    "  These will show up in each parent IB's 'pending downline' queue for manual assignment.",
  );

  if (!APPLY) {
    console.log(
      "\n⚠️ Dry run only — no changes were written. Re-run with --apply to persist.",
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((error) => {
  console.error("❌ Migration failed:", error);
  process.exit(1);
});

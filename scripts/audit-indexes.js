require("dotenv").config();

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

const models = [
  { label: "User", model: require("../models/User") },
  { label: "Account", model: require("../models/client/Account") },
  { label: "Deposit", model: require("../models/Deposit") },
  { label: "Withdrawal", model: require("../models/withdrawal") },
  { label: "Transfer", model: require("../models/client/Transfer") },
  {
    label: "IBClientConfiguration",
    model: require("../models/client/IBClientConfiguration"),
  },
  { label: "DeviceSession", model: require("../models/DeviceSession") },
];

const HOT_QUERY_INDEXES = [
  {
    model: "User",
    source: "adminDashboardController.getAdminDashboardStats",
    keys: { role: 1, createdAt: -1 },
    reason: "role-filtered growth and dashboard counts by createdAt range",
  },
  {
    model: "Account",
    source: [
      "adminDashboardController.getAdminDashboardStats",
      "statementController.getConsolidatedStatement",
    ].join(", "),
    keys: { status: 1, createdAt: -1 },
    reason: "status-filtered dashboard counts and recent account growth ranges",
  },
  {
    model: "Deposit",
    source: [
      "adminDashboardController.getAdminDashboardStats",
      "statementController.getConsolidatedStatement",
    ].join(", "),
    keys: { account: 1, status: 1, approvedDate: -1 },
    reason: "account + status + approvedDate range filters on approved deposits",
  },
  {
    model: "Withdrawal",
    source: [
      "adminDashboardController.getAdminDashboardStats",
      "statementController.getConsolidatedStatement",
    ].join(", "),
    keys: { account: 1, status: 1, approvedDate: -1 },
    reason: "account + status + approvedDate range filters on approved withdrawals",
  },
  {
    model: "Transfer",
    source: "adminDashboardController.getAdminDashboardStats",
    keys: { status: 1, createdAt: -1 },
    reason: "dashboard transfer status/date scans and recent transaction ordering",
  },
  {
    model: "Transfer",
    source: "statementController.getConsolidatedStatement",
    keys: { fromAccount: 1, status: 1, createdAt: -1 },
    reason: "completed transfer scans by source account over date range",
  },
  {
    model: "Transfer",
    source: "statementController.getConsolidatedStatement",
    keys: { toAccount: 1, status: 1, createdAt: -1 },
    reason: "completed transfer scans by destination account over date range",
  },
  {
    model: "IBClientConfiguration",
    source: "adminDashboardController.getAdminDashboardStats",
    keys: { status: 1, createdAt: -1 },
    reason: "status-filtered partner growth windows by createdAt range",
  },
];

const normalizeIndex = (keys, options = {}) => ({
  keys: Object.fromEntries(Object.entries(keys)),
  unique: Boolean(options.unique),
  sparse: Boolean(options.sparse),
  partialFilterExpression: options.partialFilterExpression || null,
});

const indexSignature = (indexLike) =>
  JSON.stringify({
    keys: indexLike.keys,
    unique: Boolean(indexLike.unique),
    sparse: Boolean(indexLike.sparse),
    partialFilterExpression: indexLike.partialFilterExpression || null,
  });

const dbIndexToComparable = (dbIndex) =>
  normalizeIndex(dbIndex.key, {
    unique: dbIndex.unique,
    sparse: dbIndex.sparse,
    partialFilterExpression: dbIndex.partialFilterExpression,
  });

const keySignature = (keys) => JSON.stringify(keys);

async function auditModel({ label, model }) {
  const declaredIndexes = model.schema
    .indexes()
    .map(([keys, options]) => normalizeIndex(keys, options));
  const actualIndexes = (await model.collection.indexes()).map(dbIndexToComparable);

  const actualByFullSignature = new Set(actualIndexes.map(indexSignature));
  const actualByKeys = new Set(actualIndexes.map((idx) => keySignature(idx.keys)));

  const missingSchemaIndexes = declaredIndexes.filter(
    (declared) => !actualByFullSignature.has(indexSignature(declared)),
  );

  const hotQueryIndexes = HOT_QUERY_INDEXES.filter((item) => item.model === label).map(
    (item) => ({
      ...item,
      declared: declaredIndexes.some(
        (declared) => keySignature(declared.keys) === keySignature(item.keys),
      ),
      presentInDb: actualByKeys.has(keySignature(item.keys)),
    }),
  );

  return {
    label,
    collectionName: model.collection.name,
    declaredIndexes,
    actualIndexes,
    missingSchemaIndexes,
    hotQueryIndexes,
  };
}

function printIndexList(title, indexes) {
  console.log(`  ${title}: ${indexes.length}`);
  for (const index of indexes) {
    const parts = [JSON.stringify(index.keys)];
    if (index.unique) parts.push("unique");
    if (index.sparse) parts.push("sparse");
    if (index.partialFilterExpression) {
      parts.push(
        `partial=${JSON.stringify(index.partialFilterExpression)}`,
      );
    }
    console.log(`    - ${parts.join(" | ")}`);
  }
}

function printHotQueryCoverage(items) {
  console.log(`  Hot Query Coverage: ${items.length}`);
  for (const item of items) {
    const status =
      item.declared && item.presentInDb
        ? "OK"
        : item.declared
          ? "DECLARED_NOT_IN_DB"
          : item.presentInDb
            ? "IN_DB_NOT_DECLARED"
            : "MISSING";

    console.log(`    - ${status} ${JSON.stringify(item.keys)}`);
    console.log(`      source: ${item.source}`);
    console.log(`      reason: ${item.reason}`);
  }
}

async function auditIndexes() {
  await connectDB();

  console.log("Index Audit Report");
  console.log("==================");
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Node environment: ${process.env.NODE_ENV || "undefined"}`);
  console.log("");

  const results = [];
  for (const entry of models) {
    results.push(await auditModel(entry));
  }

  let totalMissingSchemaIndexes = 0;
  let totalMissingHotQueryIndexes = 0;

  for (const result of results) {
    console.log(`[${result.label}] collection=${result.collectionName}`);
    printIndexList("Declared Schema Indexes", result.declaredIndexes);
    printIndexList("Actual DB Indexes", result.actualIndexes);
    printIndexList("Missing Schema Indexes In DB", result.missingSchemaIndexes);
    printHotQueryCoverage(result.hotQueryIndexes);
    console.log("");

    totalMissingSchemaIndexes += result.missingSchemaIndexes.length;
    totalMissingHotQueryIndexes += result.hotQueryIndexes.filter(
      (item) => !item.declared || !item.presentInDb,
    ).length;
  }

  console.log("Summary");
  console.log("=======");
  console.log(`Models audited: ${results.length}`);
  console.log(
    `Missing schema indexes in DB: ${totalMissingSchemaIndexes}`,
  );
  console.log(
    `Hot query index gaps: ${totalMissingHotQueryIndexes}`,
  );

  await mongoose.disconnect();
}

auditIndexes().catch(async (error) => {
  console.error("Index audit failed:", error);
  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    console.error("Disconnect failed:", disconnectError);
  }
  process.exit(1);
});

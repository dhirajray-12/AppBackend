const mongoose = require("mongoose");
const { connectDB } = require("../config/db");

async function analyzePerformance() {
  await connectDB();
  console.log("📊 Database Performance Analysis\n");

  const collections = [
    "users",
    "accounts",
    "deposits",
    "withdrawals",
    "transfers",
  ];

  for (const collection of collections) {
    const stats = await mongoose.connection.db.command({ collStats: collection });
    const indexes = await mongoose.connection.db
      .collection(collection)
      .indexes();

    console.log(`\n📁 Collection: ${collection}`);
    console.log(`   Documents: ${stats.count}`);
    console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Indexes: ${indexes.length}`);
    console.log(
      `   Index Size: ${(stats.totalIndexSize / 1024 / 1024).toFixed(2)} MB`,
    );

    // Check for missing indexes
    const hasCreatedAtIndex = indexes.some((i) => i.name.includes("created"));
    const hasUserIdIndex = indexes.some((i) => i.key.user || i.key.userId);

    if (!hasCreatedAtIndex) {
      console.log(`   ⚠️ Warning: Missing createdAt index on ${collection}`);
    }
    if (!hasUserIdIndex && collection !== "users") {
      console.log(`   ⚠️ Warning: Missing user/userId index on ${collection}`);
    }
  }

  // Run explain on common queries
  console.log("\n🔍 Query Performance Analysis:\n");

  const testQueries = [
    {
      name: "User by email",
      query: { email: "test@example.com" },
      collection: "users",
    },
    {
      name: "Deposits by user",
      query: { user: new mongoose.Types.ObjectId() },
      collection: "deposits",
    },
    {
      name: "Pending deposits",
      query: { status: "Pending" },
      collection: "deposits",
    },
  ];

  for (const test of testQueries) {
    try {
      const explain = await mongoose.connection.db
        .collection(test.collection)
        .find(test.query)
        .limit(1)
        .explain("executionStats");

      const executionTime = explain.executionStats.executionTimeMillis;
      const stage =
        explain.queryPlanner?.winningPlan?.stage ||
        explain.queryPlanner?.winningPlan?.queryPlan?.stage ||
        "UNKNOWN";
      const isCollScan = stage === "COLLSCAN";

      console.log(`   ${test.name}:`);
      console.log(`      Execution time: ${executionTime}ms`);
      console.log(`      Using: ${stage}`);
      if (isCollScan) {
        console.log(
          `      ⚠️ Warning: Collection scan detected! Add appropriate index.`,
        );
      }
    } catch (error) {
      console.log(`   ${test.name}: Error - ${error.message}`);
    }
  }

  await mongoose.disconnect();
  console.log("\n✅ Analysis complete");
}

analyzePerformance();

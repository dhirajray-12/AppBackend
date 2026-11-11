require("dotenv").config();
const mongoose = require("mongoose");
const IBClosedTrades = require("../models/IBClosedTrade");
const IBCommission = require("../models/IBCommission");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const trades = await IBClosedTrades.find({ commissionProcessed: true })
    .select("_id positionId mt5Account closeTime commissionProcessed processedAt")
    .lean();

  const tradeIds = trades.map((trade) => trade._id);
  const commissions = await IBCommission.find({
    tradeId: { $in: tradeIds },
  })
    .select("tradeId")
    .lean();

  const tradesWithCommission = new Set(
    commissions.map((commission) => commission.tradeId.toString()),
  );

  const missingTradeIds = trades
    .filter((trade) => !tradesWithCommission.has(trade._id.toString()))
    .map((trade) => trade._id);

  if (missingTradeIds.length === 0) {
    console.log("No processed trades without commissions were found.");
    await mongoose.disconnect();
    return;
  }

  const result = await IBClosedTrades.updateMany(
    { _id: { $in: missingTradeIds } },
    {
      $set: {
        commissionProcessed: false,
      },
      $unset: {
        processedAt: 1,
      },
    },
  );

  console.log(
    `Requeued ${result.modifiedCount} trades for commission processing.`,
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Failed to requeue missing commissions:", error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

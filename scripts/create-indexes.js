require("dotenv").config();

const { connectDB } = require("../config/db");

const models = [
  require("../models/User"),
  require("../models/client/Account"),
  require("../models/Deposit"),
  require("../models/withdrawal"),
  require("../models/client/Transfer"),
  require("../models/PaymentMethod"),
  require("../models/Group"),
  require("../models/client/profile"),
  require("../models/client/IBClientConfiguration"),
  require("../models/IBWithdrawal"),
  require("../models/IBCommission"),
  require("../models/IBClosedTrade"),
  require("../models/Notification"),
  require("../models/Ticket"),
  require("../models/Message"),
  require("../models/Copy"),
  require("../models/DeviceSession"),
];

async function createIndexes() {
  await connectDB();

  for (const model of models) {
    const existingIndexes = await model.collection.indexes();
    const existingKeySignatures = new Set(
      existingIndexes.map((index) => JSON.stringify(index.key)),
    );

    for (const [keys, options] of model.schema.indexes()) {
      const keySignature = JSON.stringify(keys);

      if (existingKeySignatures.has(keySignature)) {
        continue;
      }

      await model.collection.createIndex(keys, options);
      existingKeySignatures.add(keySignature);
      console.log(
        `Created index for ${model.modelName}: ${options.name || keySignature}`,
      );
    }

    console.log(`Indexes ensured for ${model.modelName}`);
  }
}

createIndexes()
  .then(() => {
    console.log("Index creation completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Index creation failed:", error);
    process.exit(1);
  });

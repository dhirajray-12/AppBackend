// backend/config/db.js - OPTIMIZED
const mongoose = require("mongoose");
const config = require("./config");

// Connection pool configuration
const POOL_SIZE = {
  min: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 5,
  max: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 50,
};

// Cache connection promise
let connectionPromise = null;

const connectDB = async () => {
  if (!config.MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      const opts = {
        maxPoolSize: POOL_SIZE.max,
        minPoolSize: POOL_SIZE.min,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
        connectTimeoutMS: 10000,
        heartbeatFrequencyMS: 5000,
        retryWrites: false,
        retryReads: false,
        // Compression is opt-in because some server environments lack native support.
        compressors:
          process.env.MONGO_COMPRESSORS
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean) || [],
        // Auto-indexing only in development
        autoIndex: process.env.NODE_ENV === "development",
      };

      const conn = await mongoose.connect(config.MONGO_URI, opts);

      // Keep DB debug logging opt-in because it adds overhead on every query.
      if (process.env.DEBUG_DB_QUERIES === "true") {
        mongoose.set("debug", (collectionName, method, query, doc) => {
          console.log(`🔍 ${collectionName}.${method}`, JSON.stringify(query));
        });
      }

      console.log(`✅ MongoDB Connected: ${conn.connection.name}`);
      return conn;
    } catch (error) {
      connectionPromise = null;
      console.error("❌ MongoDB connection error:", error);
      throw error;
    }
  })();

  return connectionPromise;
};

// Health check function
const checkDbHealth = async () => {
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch (error) {
    return false;
  }
};

// Pre-warm connections
const warmConnections = async () => {
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(mongoose.connection.db.command({ ping: 1 }));
  }
  await Promise.all(promises);
  console.log("🔥 Database connections warmed up");
};

module.exports = { connectDB, checkDbHealth, warmConnections };

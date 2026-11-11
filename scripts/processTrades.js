// backend/scripts/processTrades.js
// Utility script to manually process trades through the active sync service
// Usage: node scripts/processTrades.js [startDate] [endDate]

require('dotenv').config();
const mongoose = require('mongoose');
const tradeSyncService = require('../services/tradeSyncService');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
        process.exit(1);
    }
};

const main = async () => {
    try {
        await connectDB();

        // Get command line arguments
        const args = process.argv.slice(2);

        // Set default values
        const endTime = args[1] || new Date().toISOString();
        const startTime = args[0] || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        console.log('🚀 Starting manual trade processing...');
        console.log(`📅 Start Time: ${startTime}`);
        console.log(`📅 End Time: ${endTime}`);
        console.log('');

        const result = await tradeSyncService.processDateRange(startTime, endTime);

        console.log('');
        console.log('📊 Processing Results:');
        console.log(`✅ Trades Stored: ${result.tradesStored || 0}`);
        console.log(`📥 Total Trades Fetched: ${result.totalTrades || 0}`);
        console.log(`💰 Commissions Generated: ${result.commissionsCreated || 0}`);
        if (result.startTime && result.endTime) {
            console.log(`🕒 Synced Window: ${new Date(result.startTime).toISOString()} -> ${new Date(result.endTime).toISOString()}`);
        }
        console.log('');
        console.log('✅ Trade processing completed successfully!');

    } catch (error) {
        console.error('❌ Error processing trades:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('📴 Database connection closed');
        process.exit(0);
    }
};

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n⚠️ Process interrupted');
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n⚠️ Process terminated');
    await mongoose.disconnect();
    process.exit(0);
});

// Run the script
main();

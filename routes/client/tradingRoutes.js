// Backend/routes/client/tradingRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/auth');
const {
    getUserTrades,
    getUserOpenTrades,
    getUserClosedTrades,
    getUserForexForecast,
    getUserMarketForecast
} = require('../../controllers/client/tradingController');
const { getLiveChartData, getOrdersHistory, getDealsHistory, placeTrade, closeTrade, modifyTrade } = require('../../controllers/client/liveTradingController');

// Get all trades (open + closed) for authenticated user
router.get('/all', protect, getUserTrades);

// Get recent tick history for the live trade view chart
router.get('/live/chart-data', protect, getLiveChartData);

// Get paginated order history for the live trade view
router.get('/live/orders-history', protect, getOrdersHistory);

// Get paginated deal history for the live trade view
router.get('/live/deals-history', protect, getDealsHistory);

// Place a market order on one of the caller's own MT5 accounts
router.post('/live/place', protect, placeTrade);

// Close an open position on one of the caller's own MT5 accounts
router.post('/live/close', protect, closeTrade);

// Change Stop Loss / Take Profit on an already-open position
router.post('/live/modify', protect, modifyTrade);

// Get open trades for authenticated user
router.get('/open', protect, getUserOpenTrades);

// Get closed trades for authenticated user
router.get('/closed', protect, getUserClosedTrades);

// Get forex market intelligence and forecast suggestions
router.get('/forex-forecast', protect, getUserForexForecast);

// Get market intelligence for forex or crypto
router.get('/market-forecast', protect, getUserMarketForecast);

module.exports = router;

// Backend/controllers/client/tradingController.js - FULLY OPTIMIZED WITH CORRECT EXPORTS
const Account = require("../../models/client/Account");
const IBClosedTrades = require("../../models/IBClosedTrade");
require("dotenv").config();
const { metaApi } = require("../../API/metaApi");
const cacheService = require("../../services/cacheService");
const {
  getForexForecast,
  getMarketForecast,
  DEFAULT_INCLUDE_NEWS,
  DEFAULT_NEWS_LIMIT,
  ServiceError,
} = require("../../services/forexIntelligenceService");
const { AppError } = require("../../middlewares/errorHandler");

// Cache keys
const CACHE_KEYS = {
  USER_TRADES: (userId) => `trading:trades:${userId}`,
  USER_OPEN_TRADES: (userId) => `trading:open:${userId}`,
  USER_CLOSED_TRADES: (userId) => `trading:closed:${userId}`,
  USER_ACCOUNTS: (userId) => `trading:accounts:${userId}`,
  // Maintained by the background openTradeSyncService (not by request
  // handlers) — a continuously refreshed mirror of each user's open
  // trades, so requests can read a warm cache instead of blocking on a
  // live external MT5 call. See services/openTradeSyncService.js.
  USER_OPEN_TRADES_LIVE: (userId) => `trading:open-live:${userId}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_TRADES: 10, // Short cache to absorb duplicate dashboard requests
  USER_OPEN_TRADES: 5,
  USER_CLOSED_TRADES: 15, // Closed trades change less frequently
  // Longer than the sync interval (default 5s) so a single slow/failed
  // sync cycle doesn't cause a cache miss and fall back to a live call.
  USER_OPEN_TRADES_LIVE: 20,
};

// API timeout
const API_TIMEOUT = 8000;
const ACCOUNT_FETCH_CONCURRENCY = 4;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Sliding-window registry of users who have requested trading data
// recently. openTradeSyncService only polls open trades for these users
// instead of every account in the system — otherwise it would poll every
// account that ever existed (including inactive/stale ones) against the
// external MT5 bridge on every cycle regardless of whether anyone is
// actually looking at their trades right now.
const ACTIVE_WATCH_TTL_MS = 60 * 1000;
const activeWatchers = new Map(); // userId -> expiresAt

const markUserActive = (userId) => {
  const id = userId?.toString?.() || userId;
  if (!id) return;
  activeWatchers.set(id, Date.now() + ACTIVE_WATCH_TTL_MS);
};

const getActiveUserIds = () => {
  const now = Date.now();
  const active = [];
  for (const [id, expiresAt] of activeWatchers.entries()) {
    if (expiresAt <= now) {
      activeWatchers.delete(id);
    } else {
      active.push(id);
    }
  }
  return active;
};

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runner = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const concurrency = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  return results;
};

// Helper function to fetch data from external API with timeout and retry
const fetchExternalTradeData = async (
  mt5Account,
  managerIndex,
  type = "open",
  retryCount = 0,
  options = {},
) => {
  const maxRetries = type === "closed" ? 1 : 0;
  const { closedDays = 30 } = options;

  try {
    let url;
    if (type === "open") {
      url = `/GetOpenTradeByAccount?Manager_Index=${managerIndex}&MT5Accont=${mt5Account}`;
    } else {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - closedDays);

      const startTime = startDate.toISOString().slice(0, 19).replace("T", " ");
      const endTime = endDate.toISOString().slice(0, 19).replace("T", " ");

      url = `/GetCloseTradeAll?Manager_Index=${managerIndex}&MT5Accont=${mt5Account}&StartTime=${encodeURIComponent(startTime)}&EndTime=${encodeURIComponent(endTime)}`;
    }

    const response = await metaApi.get(url, { timeout: API_TIMEOUT });

    // Handle different response formats efficiently
    let trades = [];
    if (response.data) {
      if (Array.isArray(response.data)) {
        trades = response.data;
      } else if (typeof response.data === "object") {
        trades =
          response.data.data ||
          response.data.trades ||
          response.data.result ||
          [];
      }
    }

    return trades;
  } catch (error) {
    const statusCode = error?.response?.status;
    const shouldRetry =
      retryCount < maxRetries &&
      (!statusCode || RETRYABLE_STATUS_CODES.has(statusCode));

    if (shouldRetry) {
      console.log(
        `Retrying fetch for ${mt5Account} (${type}), attempt ${retryCount + 1}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      return fetchExternalTradeData(
        mt5Account,
        managerIndex,
        type,
        retryCount + 1,
        options,
      );
    }

    console.error(
      `Error fetching ${type} trades for account ${mt5Account}:`,
      statusCode ? `${statusCode} ${error.message}` : error.message,
    );
    return [];
  }
};

// Reshapes one IBClosedTrades DB doc back into the same field shape the
// live broker API returns so formatTradeData() below can stay unchanged.
const dbClosedTradeToApiShape = (trade) => ({
  MT5Account: trade.mt5Account,
  Symbol: trade.symbol,
  Open_Time: trade.openTime,
  Close_Time: trade.closeTime,
  Open_Price: trade.openPrice,
  Close_Price: trade.closePrice,
  Profit: trade.profit,
  Lot: trade.volume,
  Commission: trade.commission,
  Swap: trade.swap,
  Taxes: trade.taxes,
  Stop_Loss: trade.stopLoss,
  Target_Price: trade.targetPrice,
  Ticket: trade.ticket,
  PositionId: trade.positionId,
  Timestamp: trade.timestamp,
  Open_Time_Sec: trade.openTimeSec,
  uTradeFlag: trade.uTradeFlag,
  uPosStatus: trade.uPosStatus,
  oBSFlag: trade.oBSFlag,
  Comment: trade.comment,
});

// Fetches closed trades for every given account in one round trip instead
// of one query per account — fetchTradesForAccounts below used to run
// fetchClosedTradesFromDb once per account (even at concurrency 4, that's
// still ceil(N/4) DB round trips for N accounts). The {mt5Account:1,
// closeTime:-1} index already on IBClosedTrades covers an $in on
// mt5Account just as well as the single-account equality it was built for,
// so this returns the exact same rows, just grouped client-side instead of
// fetched N times. Returns a Map(mt5Account string -> trades[]).
const fetchClosedTradesFromDbBatch = async (mt5Accounts, closedDays = 30) => {
  const accountKeys = [...new Set(mt5Accounts.map((acc) => acc?.toString()))];
  const byAccount = new Map(accountKeys.map((key) => [key, []]));
  if (accountKeys.length === 0) return byAccount;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - closedDays);

  const trades = await IBClosedTrades.find({
    mt5Account: { $in: accountKeys },
    closeTime: { $gte: startDate },
  })
    .sort({ closeTime: -1 })
    .lean();

  for (const trade of trades) {
    const key = trade.mt5Account?.toString();
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(dbClosedTradeToApiShape(trade));
  }

  return byAccount;
};

// Helper function to determine trade type
const getTradeType = (trade, type) => {
  if (type === "open") {
    return trade.BUY_SELL === 0 ? "Buy" : "Sell";
  }
  return trade.uTradeFlag === 0 ? "Buy" : "Sell";
};

// Helper function to format trade data (optimized)
const formatTradeData = (trade, type = "open", accountInfo = {}) => {
  const profit = trade.Profit ? parseFloat(trade.Profit) : 0;
  const lotSize = Number(trade.Lot) || 0;
  const commission = Number(trade.Commission) || 0;
  const swap = Number(trade.Swap) || 0;
  const taxes = Number(trade.Taxes) || 0;
  const stopLoss = Number(trade.Stop_Loss) || 0;
  const takeProfit = Number(trade.Target_Price) || 0;

  const baseData = {
    account: trade.MT5Account?.toString() || "N/A",
    accountName: accountInfo.name || "Unknown",
    accountType: accountInfo.accountType || "Unknown",
    groupName: accountInfo.groupName || "Unknown",
    leverage: accountInfo.leverage || 0,
    symbol: trade.Symbol || "N/A",
    openTime: trade.Open_Time || "N/A",
    openPrice: trade.Open_Price?.toString() || "N/A",
    trade: getTradeType(trade, type),
    tradeType: getTradeType(trade, type).toLowerCase(),
    volume: lotSize.toFixed(2),
    lotSize: lotSize,
    profit: profit,
    profitFormatted:
      profit >= 0
        ? `+$${profit.toFixed(2)}`
        : `-$${Math.abs(profit).toFixed(2)}`,
    status: type,
    ticket: trade.Ticket?.toString() || "N/A",
    ticketNumber: trade.Ticket || 0,
    commission,
    swap,
    stopLoss,
    takeProfit,
    comment: trade.Comment || "",
    taxes,
  };

  if (type === "open") {
    baseData.currentPrice = trade.Price_Current?.toString() || "N/A";
    baseData.currentPriceValue = trade.Price_Current || 0;
    baseData.openTimeSec = trade.Open_Time_Sec || 0;
    baseData.volumeTotal = trade.Volume || 0;
  } else {
    baseData.closeTime = trade.Close_Time || "N/A";
    baseData.closePrice = trade.Close_Price?.toString() || "N/A";
    baseData.closePriceValue = trade.Close_Price || 0;
    baseData.positionId = trade.PositionId || 0;
    baseData.timestamp = trade.Timestamp || 0;
    baseData.openTimeSec = trade.Open_Time_Sec || 0;
    baseData.uPosStatus = trade.uPosStatus || 0;
    baseData.uTradeFlag = trade.uTradeFlag;
    baseData.oBSFlag = trade.oBSFlag || 0;
  }

  return baseData;
};

// Get user's MT5 accounts (cached)
const getUserAccounts = async (userId) => {
  const cacheKey = CACHE_KEYS.USER_ACCOUNTS(userId);
  const cached = await cacheService.get(cacheKey);

  if (cached) {
    if (Array.isArray(cached)) {
      return cached;
    }

    if (Array.isArray(cached.data)) {
      return cached.data;
    }

    console.warn(
      `Unexpected cached trading accounts shape for user ${userId}, refreshing cache`,
    );
  }

  const accounts = await Account.find({ user: userId, status: true })
    .select("mt5Account managerIndex name accountType groupName leverage")
    .lean();

  await cacheService.set(cacheKey, accounts, 30); // 30 seconds cache
  return accounts;
};

const buildProcessedAccount = (account) => ({
  mt5Account: account.mt5Account,
  name: account.name,
  accountType: account.accountType,
  groupName: account.groupName,
  leverage: account.leverage,
});

const buildAccountInfo = (account) => ({
  name: account.name,
  accountType: account.accountType,
  groupName: account.groupName,
  leverage: account.leverage,
});

const fetchTradesForAccounts = async (
  accounts,
  { includeOpen = true, includeClosed = true, closedDays = 30 } = {},
) => {
  // Closed trades come from our own DB, not an external call — fetch every
  // account's rows in one query up front instead of once per account inside
  // the per-account worker below.
  const closedTradesByAccount = includeClosed
    ? await fetchClosedTradesFromDbBatch(
        accounts.map((a) => a.mt5Account),
        closedDays,
      )
    : null;

  const settledResults = await runWithConcurrency(
    accounts,
    ACCOUNT_FETCH_CONCURRENCY,
    async (account) => {
      const accountInfo = buildAccountInfo(account);

      const openTrades = includeOpen
        ? await fetchExternalTradeData(
            account.mt5Account,
            account.managerIndex || "3",
            "open",
          )
        : [];

      const closedTrades = includeClosed
        ? closedTradesByAccount.get(account.mt5Account?.toString()) || []
        : [];

      return {
        account: buildProcessedAccount(account),
        accountInfo,
        openTrades: Array.isArray(openTrades) ? openTrades : [],
        closedTrades: Array.isArray(closedTrades) ? closedTrades : [],
      };
    },
  );

  const openTrades = [];
  const closedTrades = [];
  const processedAccounts = [];

  for (const result of settledResults) {
    if (!result) continue;

    const { account, accountInfo, openTrades: rawOpen, closedTrades: rawClosed } =
      result;
    processedAccounts.push(account);

    for (const trade of rawOpen) {
      openTrades.push(formatTradeData(trade, "open", accountInfo));
    }
    for (const trade of rawClosed) {
      closedTrades.push(formatTradeData(trade, "closed", accountInfo));
    }
  }

  return { processedAccounts, openTrades, closedTrades };
};

// Reads the background-maintained open-trades mirror for a user (kept warm
// by services/openTradeSyncService.js). Returns null on a cold cache (e.g.
// right after boot, or a brand-new account the sync loop hasn't reached
// yet) so callers can fall back to a live fetch.
const getWarmOpenTrades = async (userId) => {
  const cached = await cacheService.get(CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId));
  if (!cached || !Array.isArray(cached.trades)) {
    return null;
  }
  return cached;
};

// Calculate trade statistics (optimized)
const calculateTradeStats = (openTrades, closedTrades) => {
  let openProfit = 0,
    closedProfit = 0,
    totalCommission = 0,
    totalSwap = 0;
  let profitable = 0,
    losing = 0,
    buyTrades = 0,
    sellTrades = 0;
  const symbolsSet = new Set();

  // Process open trades
  for (const trade of openTrades) {
    openProfit += trade.profit || 0;
    totalCommission += trade.commission || 0;
    totalSwap += trade.swap || 0;
    if (trade.tradeType === "buy") buyTrades++;
    else if (trade.tradeType === "sell") sellTrades++;
    if (trade.symbol) symbolsSet.add(trade.symbol);
  }

  // Process closed trades
  for (const trade of closedTrades) {
    closedProfit += trade.profit || 0;
    totalCommission += trade.commission || 0;
    totalSwap += trade.swap || 0;
    if (trade.profit > 0) profitable++;
    else if (trade.profit < 0) losing++;
    if (trade.tradeType === "buy") buyTrades++;
    else if (trade.tradeType === "sell") sellTrades++;
    if (trade.symbol) symbolsSet.add(trade.symbol);
  }

  const totalProfit = openProfit + closedProfit;
  const totalTrades = openTrades.length + closedTrades.length;
  const winRate =
    closedTrades.length > 0
      ? ((profitable / closedTrades.length) * 100).toFixed(2)
      : 0;

  return {
    totalOpenTrades: openTrades.length,
    totalClosedTrades: closedTrades.length,
    totalTrades,
    openTradesProfit: openProfit,
    closedTradesProfit: closedProfit,
    totalProfit,
    profitableTrades: profitable,
    losingTrades: losing,
    totalCommission,
    totalSwap,
    symbols: Array.from(symbolsSet),
    buyTrades,
    sellTrades,
    winRate: parseFloat(winRate),
  };
};
// Get all trades (open + closed) for authenticated user
const getUserTrades = async (req, res, next) => {
  try {
    const userId = req.user._id;
    markUserActive(userId);
    const requestedClosedDays = parseInt(req.query.closedDays, 10);
    const requestedClosedLimit = parseInt(req.query.closedLimit, 10);
    const closedDays = Number.isFinite(requestedClosedDays)
      ? Math.min(Math.max(requestedClosedDays, 1), 30)
      : 30;
    const closedLimit = Number.isFinite(requestedClosedLimit)
      ? Math.min(Math.max(requestedClosedLimit, 50), 1000)
      : null;
    const cacheKey = `${CACHE_KEYS.USER_TRADES(userId)}:${closedDays}:${closedLimit || "all"}`;

    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        cached: true,
        timestamp: cached.timestamp,
        fromCache: true,
      });
    }

    const accounts = await getUserAccounts(userId);

    if (accounts.length === 0) {
      const emptyResponse = {
        success: true,
        data: {
          openTrades: [],
          closedTrades: [],
          totalOpenTrades: 0,
          totalClosedTrades: 0,
          accountsCount: 0,
          statistics: calculateTradeStats([], []),
          accounts: [],
        },
        message: "No MT5 accounts found",
      };
      return res.status(200).json(emptyResponse);
    }

    // Closed trades always come from our internal DB mirror already (fast,
    // no external call) — only fetch that part per-request.
    const { processedAccounts: closedAccounts, closedTrades: allClosedTrades } =
      await fetchTradesForAccounts(accounts, {
        includeOpen: false,
        includeClosed: true,
        closedDays,
      });

    // Fast path: read the continuously-refreshed background mirror instead
    // of blocking this request on a live external MT5 call per account.
    const warm = await getWarmOpenTrades(userId);
    let processedAccounts = closedAccounts;
    let allOpenTrades;
    if (warm) {
      allOpenTrades = warm.trades;
    } else {
      // Cold path (first request after boot / brand-new account) — fall
      // back to the live fetch exactly as before.
      const live = await fetchTradesForAccounts(accounts, {
        includeOpen: true,
        includeClosed: false,
      });
      allOpenTrades = live.openTrades;
      processedAccounts = live.processedAccounts;
    }

    // Sort trades
    allOpenTrades.sort((a, b) => new Date(b.openTime) - new Date(a.openTime));
    allClosedTrades.sort(
      (a, b) =>
        new Date(b.closeTime || b.openTime) -
        new Date(a.closeTime || a.openTime),
    );

    const limitedClosedTrades = closedLimit
      ? allClosedTrades.slice(0, closedLimit)
      : allClosedTrades;

    const statistics = calculateTradeStats(allOpenTrades, limitedClosedTrades);
    const timestamp = Date.now();

    const responseData = {
      openTrades: allOpenTrades,
      closedTrades: limitedClosedTrades,
      totalOpenTrades: allOpenTrades.length,
      totalClosedTrades: limitedClosedTrades.length,
      accountsCount: processedAccounts.length,
      statistics,
      accounts: processedAccounts,
      meta: {
        closedDays,
        closedLimit,
        closedTradesAvailable: allClosedTrades.length,
      },
    };

    // Cache the response
    await cacheService.set(
      cacheKey,
      { data: responseData, timestamp },
      CACHE_TTL.USER_TRADES,
    );

    res.status(200).json({
      success: true,
      data: responseData,
      timestamp,
    });
  } catch (error) {
    next(error);
  }
};

// Get only open trades for authenticated user
const getUserOpenTrades = async (req, res, next) => {
  try {
    const userId = req.user._id;
    markUserActive(userId);
    const cacheKey = CACHE_KEYS.USER_OPEN_TRADES(userId);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached.data,
        cached: true,
        timestamp: cached.timestamp,
        fromCache: true,
      });
    }

    const accounts = await getUserAccounts(userId);

    if (accounts.length === 0) {
      const emptyResponse = {
        success: true,
        data: {
          trades: [],
          total: 0,
          totalProfit: 0,
          accounts: [],
        },
        message: "No MT5 accounts found",
      };
      return res.status(200).json(emptyResponse);
    }

    // Fast path: read the continuously-refreshed background mirror instead
    // of blocking this request on a live external MT5 call per account.
    const warm = await getWarmOpenTrades(userId);
    let processedAccounts;
    let allOpenTrades;
    if (warm) {
      processedAccounts = warm.accounts;
      allOpenTrades = warm.trades;
    } else {
      // Cold path (first request after boot / brand-new account) — fall
      // back to the live fetch exactly as before.
      ({ processedAccounts, openTrades: allOpenTrades } =
        await fetchTradesForAccounts(accounts, {
          includeOpen: true,
          includeClosed: false,
        }));
    }

    allOpenTrades.sort((a, b) => new Date(b.openTime) - new Date(a.openTime));

    const totalProfit = allOpenTrades.reduce(
      (sum, trade) => sum + (trade.profit || 0),
      0,
    );
    const timestamp = Date.now();

    const responseData = {
      trades: allOpenTrades,
      total: allOpenTrades.length,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalProfitFormatted:
        totalProfit >= 0
          ? `+$${totalProfit.toFixed(2)}`
          : `-$${Math.abs(totalProfit).toFixed(2)}`,
      accounts: processedAccounts,
    };

    await cacheService.set(
      cacheKey,
      { data: responseData, timestamp },
      CACHE_TTL.USER_OPEN_TRADES,
    );

    res.status(200).json({
      success: true,
      data: responseData,
      timestamp,
    });
  } catch (error) {
    next(error);
  }
};

const buildClosedTradesResponse = (responseData, page, limit) => {
  const total = responseData.total || 0;
  const safeLimit = Math.max(1, limit);
  const safePage = Math.max(1, page);
  const pages = total === 0 ? 0 : Math.ceil(total / safeLimit);
  const currentPage = pages === 0 ? 1 : Math.min(safePage, pages);
  const startIndex = (currentPage - 1) * safeLimit;
  const paginatedTrades = responseData.trades.slice(
    startIndex,
    startIndex + safeLimit,
  );

  return {
    ...responseData,
    trades: paginatedTrades,
    pagination: {
      page: currentPage,
      limit: safeLimit,
      total,
      pages,
      hasNext: currentPage < pages,
      hasPrev: currentPage > 1,
    },
  };
};

// Get only closed trades for authenticated user
const getUserClosedTrades = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const cacheKey = CACHE_KEYS.USER_CLOSED_TRADES(userId);
    const hasPaginationQuery =
      req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      const responseData = hasPaginationQuery
        ? buildClosedTradesResponse(cached.data, page, limit)
        : cached.data;

      return res.status(200).json({
        success: true,
        data: responseData,
        cached: true,
        timestamp: cached.timestamp,
        fromCache: true,
      });
    }

    const accounts = await getUserAccounts(userId);

    if (accounts.length === 0) {
      const emptyData = {
        trades: [],
        total: 0,
        totalProfit: 0,
        profitableTrades: 0,
        losingTrades: 0,
        winRate: 0,
        accounts: [],
      };
      const emptyResponse = {
        success: true,
        data: hasPaginationQuery
          ? buildClosedTradesResponse(emptyData, page, limit)
          : emptyData,
        message: "No MT5 accounts found",
      };
      return res.status(200).json(emptyResponse);
    }

    const {
      processedAccounts,
      closedTrades: allClosedTrades,
    } = await fetchTradesForAccounts(accounts, {
      includeOpen: false,
      includeClosed: true,
    });

    allClosedTrades.sort(
      (a, b) =>
        new Date(b.closeTime || b.openTime) -
        new Date(a.closeTime || a.openTime),
    );

    let totalProfit = 0;
    let profitableTrades = 0;
    let losingTrades = 0;

    for (const trade of allClosedTrades) {
      totalProfit += trade.profit || 0;
      if (trade.profit > 0) profitableTrades++;
      else if (trade.profit < 0) losingTrades++;
    }

    const winRate =
      allClosedTrades.length > 0
        ? ((profitableTrades / allClosedTrades.length) * 100).toFixed(2)
        : 0;
    const timestamp = Date.now();

    const responseData = {
      trades: allClosedTrades,
      total: allClosedTrades.length,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalProfitFormatted:
        totalProfit >= 0
          ? `+$${totalProfit.toFixed(2)}`
          : `-$${Math.abs(totalProfit).toFixed(2)}`,
      profitableTrades,
      losingTrades,
      winRate: parseFloat(winRate),
      accounts: processedAccounts,
    };

    await cacheService.set(
      cacheKey,
      { data: responseData, timestamp },
      CACHE_TTL.USER_CLOSED_TRADES,
    );

    const responsePayload = hasPaginationQuery
      ? buildClosedTradesResponse(responseData, page, limit)
      : responseData;

    res.status(200).json({
      success: true,
      data: responsePayload,
      timestamp,
    });
  } catch (error) {
    next(error);
  }
};

// Get trade summary statistics only (lightweight)
const getTradeSummary = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const cacheKey = `trading:summary:${userId}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const accounts = await getUserAccounts(userId);

    if (accounts.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          totalOpenTrades: 0,
          totalClosedTrades: 0,
          totalProfit: 0,
          winRate: 0,
          activeAccounts: 0,
        },
      });
    }

    const { openTrades, closedTrades } = await fetchTradesForAccounts(accounts, {
      includeOpen: true,
      includeClosed: true,
    });

    let totalOpenTrades = 0;
    let totalClosedTrades = closedTrades.length;
    let totalProfit = 0;
    let profitableTrades = 0;
    totalOpenTrades = openTrades.length;

    for (const trade of closedTrades) {
      totalProfit += trade.profit || 0;
      if (trade.profit > 0) profitableTrades++;
    }

    const winRate =
      totalClosedTrades > 0
        ? ((profitableTrades / totalClosedTrades) * 100).toFixed(1)
        : 0;

    const summary = {
      totalOpenTrades,
      totalClosedTrades,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      winRate: parseFloat(winRate),
      activeAccounts: accounts.length,
    };

    await cacheService.set(cacheKey, summary, 10); // 10 seconds cache

    res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

const getUserForexForecast = async (req, res, next) => {
  try {
    const symbols = req.query.symbols;
    const requestedNewsLimit = parseInt(req.query.newsLimit, 10);
    const newsLimit = Number.isFinite(requestedNewsLimit)
      ? Math.min(Math.max(requestedNewsLimit, 1), 5)
      : DEFAULT_NEWS_LIMIT;
    const refresh = String(req.query.refresh || "").toLowerCase() === "true";
    const includeNews =
      String(req.query.includeNews || String(DEFAULT_INCLUDE_NEWS)).toLowerCase() ===
      "true";

    const data = await getForexForecast({
      symbols,
      newsLimit,
      refresh,
      includeNews,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const statusCode =
      error instanceof ServiceError && error.statusCode
        ? error.statusCode
        : 500;

    next(
      new AppError(
        error.message || "Failed to fetch forex market intelligence data.",
        statusCode,
      ),
    );
  }
};

const getUserMarketForecast = async (req, res, next) => {
  try {
    const symbols = req.query.symbols;
    const assetType = req.query.assetType || "forex";
    const requestedNewsLimit = parseInt(req.query.newsLimit, 10);
    const newsLimit = Number.isFinite(requestedNewsLimit)
      ? Math.min(Math.max(requestedNewsLimit, 1), 5)
      : DEFAULT_NEWS_LIMIT;
    const refresh = String(req.query.refresh || "").toLowerCase() === "true";
    const includeNews =
      String(req.query.includeNews || String(DEFAULT_INCLUDE_NEWS)).toLowerCase() ===
      "true";

    const data = await getMarketForecast({
      assetType,
      symbols,
      newsLimit,
      refresh,
      includeNews,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const statusCode =
      error instanceof ServiceError && error.statusCode
        ? error.statusCode
        : 500;

    next(
      new AppError(
        error.message || "Failed to fetch market forecast data.",
        statusCode,
      ),
    );
  }
};
// Invalidate trading caches for a user
const invalidateTradingCaches = async (userId) => {
  const patterns = [
    // getUserTrades keys this per {closedDays, closedLimit} suffix
    // (`${USER_TRADES(userId)}:${closedDays}:${closedLimit}`) - a bare,
    // non-wildcard pattern here would only ever match a key with no
    // suffix at all, which never exists, so this silently never cleared
    // it. The trailing "*" makes deletePattern match every variant.
    `${CACHE_KEYS.USER_TRADES(userId)}:*`,
    CACHE_KEYS.USER_OPEN_TRADES(userId),
    CACHE_KEYS.USER_CLOSED_TRADES(userId),
    `trading:summary:${userId}`,
    CACHE_KEYS.USER_ACCOUNTS(userId),
  ];

  for (const pattern of patterns) {
    await cacheService.deletePattern(pattern);
  }
  console.log(`🗑️ Trading caches invalidated for user: ${userId}`);
};
module.exports = {
  getUserTrades,
  getUserOpenTrades,
  getUserClosedTrades,
  getTradeSummary,
  getUserForexForecast,
  getUserMarketForecast,
  invalidateTradingCaches,
  // Exposed for services/openTradeSyncService.js — reuses the exact same
  // fetch/format/concurrency logic instead of duplicating it.
  CACHE_KEYS,
  CACHE_TTL,
  runWithConcurrency,
  fetchExternalTradeData,
  formatTradeData,
  buildAccountInfo,
  buildProcessedAccount,
  ACCOUNT_FETCH_CONCURRENCY,
  getActiveUserIds,
};

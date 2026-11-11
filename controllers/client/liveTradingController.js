// Backend/controllers/client/liveTradingController.js
//
// Proxies the trading bridge's chart endpoint, plus place/close order
// actions, so the client never needs the bridge's URL/API key directly and
// every action gets re-checked against the caller's own accounts here.
//
// The chart endpoint is a *different* bridge host than the one
// API/metaApi.js's `metaApi` instance talks to (MT5_API_URL /
// api3.infoapi.biz, used for account + closed/open trade reads) - that one
// had been timing out on every chart-data call (15s, 502) against a
// misconfigured upstream. This one (CHART_API_URL) was confirmed directly
// against the live API to respond in well under a second.
//
// place/close use yet another bridge host+path (`tradeActionApi`, see
// API/metaApi.js) documented in the "metatraderapp share" Postman
// collection - the account/trade-read bridge above has no order-placement
// endpoints at all.
const axios = require("axios");
require("dotenv").config();
const Account = require("../../models/client/Account");
const { tradeActionApi } = require("../../API/metaApi");
const cacheService = require("../../services/cacheService");
const {
  CACHE_KEYS,
  CACHE_TTL,
  fetchExternalTradeData,
  formatTradeData,
  buildAccountInfo,
  buildProcessedAccount,
  invalidateTradingCaches,
} = require("./tradingController");

const CHART_API_URL =
  process.env.CHART_API_URL || "https://chart.apirun.top/api/chart-data";
// Selects which broker/manager account group's price feed to read.
// Confirmed working for the symbols this endpoint is used for (BTCUSDs
// etc.) - if a symbol needs a different manager, this may need to become
// per-symbol rather than a single default.
const CHART_MANAGER_INDEX = parseInt(process.env.CHART_MANAGER_INDEX, 10) || 1;
const CHART_API_TIMEOUT = 8000;

// Yet another bridge host (mt6.apirun.top, confirmed directly against the
// live API) - order/deal history straight from the broker, paginated, both
// sharing the same request body shape ({Manager_Index, MT5Account,
// page_size, page}) and response envelope ({status, message, total_<kind>,
// page_size, current_page, total_pages, <kind>: [...]}). Separate from
// tradingController.js's getUserClosedTrades, which reads our own DB mirror
// (tradeSyncService) instead of calling out live. Trade-view's History tab
// only - the Positions tab (currently open trades) is real-time over
// Socket.IO instead, see mt5TradeWebSocketService.js's "open_trades_updated"
// push.
const HISTORY_API_TIMEOUT = 10000;
const HISTORY_MAX_PAGE_SIZE = 200;
const ORDERS_HISTORY_API_URL =
  process.env.ORDERS_HISTORY_API_URL ||
  "https://mt6.apirun.top/api/get-orders-history";
const DEALS_HISTORY_API_URL =
  process.env.DEALS_HISTORY_API_URL ||
  "https://mt6.apirun.top/api/get-deals-history";

const DEFAULT_MANAGER_INDEX =
  Number.parseInt(process.env.MANAGER_INDEX, 10) || 1;
const TRADE_ACTION_TIMEOUT = 10000;

// Thrown by assertBridgeSuccess below for a broker-side rejection that
// still came back as HTTP 200 - kept distinct from a real bug so the catch
// block can tell "the broker said no" (400, message shown to the user)
// apart from "our code/the network broke" (502/504/500).
class BridgeRejectionError extends Error {}

// The bridge sometimes answers a rejected order with HTTP 200 and an error
// inside the body rather than a non-2xx status - normalize both shapes
// into a thrown error so callers only need one code path.
const assertBridgeSuccess = (response, fallbackMessage) => {
  const data = response.data;
  if (data && typeof data === "object") {
    if (data.success === false || data.error) {
      throw new BridgeRejectionError(
        data.message || data.error || fallbackMessage,
      );
    }
    // MT5's own convention: retcode 10009 (TRADE_RETCODE_DONE) is success,
    // anything else on a response that bothers to include retcode is not.
    if (
      data.retcode !== undefined &&
      Number(data.retcode) !== 0 &&
      Number(data.retcode) !== 10009
    ) {
      throw new BridgeRejectionError(
        data.comment || data.message || fallbackMessage,
      );
    }
  }
  return data;
};

// Reads the current warm open-trades cache entry (or an empty shell if
// there isn't one yet), lets `mutate` return the new trades array, and
// writes it straight back - a synchronous, all-in-memory operation (no
// external call), so this is safe to await directly in the request path.
const patchOpenTradesCache = async (userId, mutate) => {
  const key = CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId);
  const current = (await cacheService.get(key)) || {
    trades: [],
    accounts: [],
  };
  const trades = mutate(Array.isArray(current.trades) ? current.trades : []);

  await cacheService.set(
    key,
    { ...current, trades, updatedAt: Date.now() },
    CACHE_TTL.USER_OPEN_TRADES_LIVE,
  );
};

// Same idea as patchOpenTradesCache, specialized for closing a ticket: pulls
// the matching entry out of the cache (so the caller can reuse its fields
// to build a closed-trade record) and returns it alongside the write.
const removeOpenTradeFromCache = async (userId, ticket) => {
  const key = CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId);
  const current = (await cacheService.get(key)) || { trades: [], accounts: [] };
  const trades = Array.isArray(current.trades) ? current.trades : [];
  const index = trades.findIndex(
    (t) => String(t.ticketNumber ?? t.ticket) === ticket,
  );
  const removed = index >= 0 ? trades[index] : null;
  const nextTrades =
    index >= 0
      ? [...trades.slice(0, index), ...trades.slice(index + 1)]
      : trades;

  await cacheService.set(
    key,
    { ...current, trades: nextTrades, updatedAt: Date.now() },
    CACHE_TTL.USER_OPEN_TRADES_LIVE,
  );

  return removed;
};

// Builds the same shape formatTradeData("open", ...) produces, straight
// from our own place-trade request/response, so a just-placed trade can be
// pushed into the cache immediately instead of waiting on a fresh broker
// fetch to learn about the trade *we ourselves* just placed.
const buildOptimisticOpenTrade = (
  account,
  { symbol, price, lot, type, sl, tp },
  bridgeData,
) => {
  const details = bridgeData?.trade_details || bridgeData?.details || {};
  const ticket = details.PositionID ?? details.ticket ?? details.Ticket;
  if (!ticket) return null; // unrecognized response shape - skip the optimistic add, background refresh will catch it

  const raw = {
    MT5Account: account.mt5Account,
    Symbol: symbol,
    Open_Time: new Date().toISOString(),
    Open_Time_Sec: Math.floor(Date.now() / 1000),
    Open_Price: details.price ?? price,
    Price_Current: details.price ?? price,
    BUY_SELL: type,
    Lot: details.lot ?? lot,
    Volume: Math.round((details.lot ?? lot) * 100),
    Profit: 0,
    Ticket: ticket,
    Commission: 0,
    Swap: 0,
    Stop_Loss: sl || 0,
    Target_Price: tp || 0,
    Comment: "",
    Taxes: 0,
  };

  return formatTradeData(raw, "open", buildAccountInfo(account));
};

// Rebuilds this user's warm open-trades cache (the one getUserTrades/
// getUserOpenTrades read as their fast path) straight from the REST bridge
// instead of waiting for mt5TradeWebSocketService's own WS mirror.
//
// That WS mirror's "trades" channel has been observed to not reflect a
// given account's real open positions at all (confirmed directly against
// the bridge: subscribing to it for an account with two real open trades,
// and even a full manager-wide snapshot, both came back missing them,
// while the same account's "accounts"/balance channel and the plain REST
// GetOpenTradeByAccount call both show them fine) - so a warm cache populated
// only from that channel can get permanently stuck reporting "no open
// trades" for an account despite the broker showing real ones.
//
// This is run as a *background* reconciliation only (see
// notifyTradingDataChanged) - it's a real network call per account, which
// used to sit directly in the place/close request path and added a second
// several-second broker round-trip on top of the trade action itself
// before responding. The immediate cache correctness right after our own
// place/close comes from patchOpenTradesCache above instead; this just
// mops up anything the optimistic patch couldn't know (other tabs/devices,
// admin-side actions, a partial fill, etc.).
// [reconcile] lets a caller that just placed/closed a trade tell this
// refresh "I already know the true state of this one ticket regardless of
// what the broker's REST snapshot says" - without it, this unconditional
// overwrite would silently revert the exact trade the user just acted on
// back to its pre-action state whenever the broker's own snapshot hasn't
// settled yet (a real, observed race - see notifyTradingDataChanged's own
// comment), and the client would sit on that wrong state until the next
// 15s poll happened to land after the broker finally caught up.
//   - reconcile.ensurePresentTrade: keep/re-add this exact trade object if
//     the fresh snapshot doesn't have it yet (a just-placed order).
//   - reconcile.ensureAbsentTicket: drop this ticket if the fresh snapshot
//     still has it (a just-closed position).
// Returns the trades actually written, so callers can tell whether the
// reconciliation changed anything relative to what was already cached.
const refreshUserOpenTradesCache = async (userId, reconcile = {}) => {
  const accounts = await Account.find({ user: userId, status: true })
    .select("mt5Account managerIndex name accountType groupName leverage")
    .lean();

  if (accounts.length === 0) return [];

  const perAccountTrades = await Promise.all(
    accounts.map(async (account) => {
      const managerIndex =
        Number.parseInt(account.managerIndex, 10) || DEFAULT_MANAGER_INDEX;
      const rawTrades = await fetchExternalTradeData(
        account.mt5Account,
        managerIndex,
        "open",
      );
      const accountInfo = buildAccountInfo(account);
      return (rawTrades || []).map((trade) =>
        formatTradeData(trade, "open", accountInfo),
      );
    }),
  );

  let trades = perAccountTrades.flat();

  if (reconcile.ensureAbsentTicket) {
    trades = trades.filter(
      (t) =>
        String(t.ticketNumber ?? t.ticket) !== reconcile.ensureAbsentTicket,
    );
  }
  if (
    reconcile.ensurePresentTrade &&
    !trades.some(
      (t) =>
        String(t.ticketNumber ?? t.ticket) ===
        String(reconcile.ensurePresentTrade.ticketNumber),
    )
  ) {
    trades = [reconcile.ensurePresentTrade, ...trades];
  }

  trades.sort((a, b) => new Date(b.openTime) - new Date(a.openTime));

  await cacheService.set(
    CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId),
    {
      trades,
      accounts: accounts.map(buildProcessedAccount),
      updatedAt: Date.now(),
    },
    CACHE_TTL.USER_OPEN_TRADES_LIVE,
  );

  return trades;
};

// Same "your trading data changed, refetch" signal
// mt5TradeWebSocketService/tradeSyncService push for a tick/close arriving
// off the feed - place/close here bypass that feed's own detection lag
// (and, per the note above, its unreliable "trades" channel) so the acting
// user sees their own action reflected immediately.
//
// Only the cheap, in-memory cache invalidation + socket emit happen
// synchronously here. The broker-reconciling refreshUserOpenTradesCache is
// deliberately NOT awaited - it's a real network call, and awaiting it here
// used to add a second several-second broker round-trip to every
// place/close response on top of the trade action itself. The caller
// should patch the cache for its own known trade (see
// buildOptimisticOpenTrade / patchOpenTradesCache) *before* calling this,
// so the emitted invalidation already has correct data to refetch - this
// background refresh just reconciles anything that patch couldn't know.
const notifyTradingDataChanged = async (io, userId, reconcile = {}) => {
  await invalidateTradingCaches(userId).catch(() => {});

  if (io?.emitCacheInvalidation) {
    io.emitCacheInvalidation(userId, ["tradingData"]);
  }

  // reconcile is forwarded so this background pass can't clobber the
  // optimistic patch the caller already applied (see
  // refreshUserOpenTradesCache's own doc comment) - and a second
  // invalidation fires once it actually lands, in case a client's own
  // manual refetch had already raced ahead of this background call
  // finishing (unlikely given it's usually fast, but not guaranteed).
  refreshUserOpenTradesCache(userId, reconcile)
    .then(() => {
      if (io?.emitCacheInvalidation) {
        io.emitCacheInvalidation(userId, ["tradingData"]);
      }
    })
    .catch((err) => {
      console.error(
        `Background open-trades refresh failed for user ${userId}:`,
        err.message,
      );
    });
};

const handleTradeActionError = (error, res, next) => {
  if (error instanceof BridgeRejectionError) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (error?.response) {
    const bridgeMessage =
      error.response.data?.message || error.response.data?.error;
    const status = error.response.status;
    return res.status(status >= 400 && status < 500 ? status : 502).json({
      success: false,
      message: bridgeMessage || "The broker rejected the request",
    });
  }
  if (error.code === "ECONNABORTED") {
    return res.status(504).json({
      success: false,
      message: "Request to the broker timed out",
    });
  }
  next(error);
};

// Thrown by the *Core functions below for a plain validation/ownership
// failure (bad input, account/position not found, etc.) - the same
// {status, json} shape a REST route would have responded with directly,
// just carried as a thrown error so the identical core logic can serve
// both the Express route AND the Socket.IO handler in utils/socketServer.js
// without duplicating a second copy of place/close/modify's real logic
// for the socket path.
class TradeHttpError extends Error {
  constructor(status, json) {
    super(json?.message || "Trade action failed");
    this.status = status;
    this.json = json;
  }
}

// Socket.IO equivalent of handleTradeActionError - there's no `res` to
// write to over a socket ack callback, so this returns the same
// {success, message} shape as a plain object instead. Mirrors that
// function's branches exactly (status folded into the payload as
// `status` rather than a real HTTP status line).
const buildSocketErrorPayload = (error) => {
  if (error instanceof TradeHttpError) {
    return { ...error.json, status: error.status };
  }
  if (error instanceof BridgeRejectionError) {
    return { success: false, message: error.message, status: 400 };
  }
  if (error?.response) {
    const bridgeMessage =
      error.response.data?.message || error.response.data?.error;
    const status = error.response.status;
    return {
      success: false,
      message: bridgeMessage || "The broker rejected the request",
      status: status >= 400 && status < 500 ? status : 502,
    };
  }
  if (error.code === "ECONNABORTED") {
    return {
      success: false,
      message: "Request to the broker timed out",
      status: 504,
    };
  }
  console.error("Trade socket action failed:", error.message);
  return { success: false, message: "Internal server error", status: 500 };
};

// Locates which of the user's own accounts an open position ticket belongs
// to (the client only sends positionId/price, not the account) - checked
// only against this user's own accounts, so a ticket belonging to someone
// else's account is never resolved. Tries the warm open-trades mirror
// first (see mt5TradeWebSocketService), then falls back to a live
// per-account lookup on a cold cache. Also returns the trade's current lot
// size - update-trade's Ticket-based modify call requires a Lot field
// alongside SL/TP, so callers that only change SL/TP still need to echo
// the position's real, unchanged volume back.
const resolveAccountForTicket = async (userId, positionId) => {
  const ticket = String(positionId);

  const accounts = await Account.find({ user: userId, status: true })
    .select("mt5Account managerIndex")
    .lean();

  const cached = await cacheService.get(
    CACHE_KEYS.USER_OPEN_TRADES_LIVE(userId),
  );
  const cachedTrade = Array.isArray(cached?.trades)
    ? cached.trades.find((t) => String(t.ticketNumber ?? t.ticket) === ticket)
    : null;

  if (cachedTrade) {
    const owner = accounts.find(
      (a) => String(a.mt5Account) === String(cachedTrade.account),
    );
    if (owner) {
      return {
        mt5Account: owner.mt5Account,
        managerIndex:
          Number.parseInt(owner.managerIndex, 10) || DEFAULT_MANAGER_INDEX,
        lot: cachedTrade.lotSize,
        stopLoss: cachedTrade.stopLoss,
        takeProfit: cachedTrade.takeProfit,
      };
    }
  }

  // Cold cache (or the trade hasn't landed there yet) - fall back to a
  // live per-account lookup, same helper the old REST-poll sync used.
  for (const account of accounts) {
    const managerIndex =
      Number.parseInt(account.managerIndex, 10) || DEFAULT_MANAGER_INDEX;
    const trades = await fetchExternalTradeData(
      account.mt5Account,
      managerIndex,
      "open",
    );
    const match = (trades || []).find(
      (t) => String(t.Ticket ?? t.ticket ?? t.order) === ticket,
    );
    if (match) {
      return {
        mt5Account: account.mt5Account,
        managerIndex,
        lot: Number(match.Lot) || undefined,
        stopLoss: Number(match.Stop_Loss) || 0,
        takeProfit: Number(match.Target_Price) || 0,
      };
    }
  }

  return null;
};

// Place a market order on one of the caller's own MT5 accounts. Shared
// core, called from both the REST route below AND utils/socketServer.js's
// `trade:place` handler (see the module doc comment at the top of this
// file's export list) - identical validation, bridge call, optimistic
// cache patch and socket push either way; only how the caller was reached
// (HTTP vs a Socket.IO ack) differs, at the two thin wrappers.
const placeTradeCore = async (io, userId, body) => {
  const { accountId, symbol, price, lot, type, sl, tp } = body;

  if (!accountId || !symbol || !price || !lot || (type !== 0 && type !== 1)) {
    throw new TradeHttpError(400, {
      success: false,
      message:
        "accountId, symbol, price, lot and type (0 = Buy, 1 = Sell) are required",
    });
  }

  const account = await Account.findOne({
    _id: accountId,
    user: userId,
    status: true,
  })
    .select("mt5Account managerIndex")
    .lean();

  if (!account) {
    throw new TradeHttpError(404, {
      success: false,
      message: "Account not found",
    });
  }

  const managerIndex =
    Number.parseInt(account.managerIndex, 10) || DEFAULT_MANAGER_INDEX;

  const response = await tradeActionApi.post(
    "/place-trade",
    {
      Manager_Index: managerIndex,
      MT5Account: Number(account.mt5Account),
      Symbol: symbol,
      Price: Number(price),
      Lot: Number(lot),
      Type: type,
      SL: Number(sl) || 0,
      TP: Number(tp) || 0,
    },
    {
      headers: { "X-MANAGER-ID": managerIndex },
      timeout: TRADE_ACTION_TIMEOUT,
    },
  );

  const data = assertBridgeSuccess(
    response,
    "Trade was rejected by the broker",
  );

  // Instant, in-memory cache patch (no network call) so the very next
  // /trading/all fetch the frontend triggers already shows this trade,
  // instead of waiting on a second broker round-trip to find out about
  // the trade we ourselves just placed.
  const optimisticTrade = buildOptimisticOpenTrade(
    account,
    { symbol, price, lot, type, sl, tp },
    data,
  );
  if (optimisticTrade) {
    await patchOpenTradesCache(userId, (trades) => [
      optimisticTrade,
      ...trades,
    ]);

    // Push the actual trade straight over the socket instead of just an
    // invalidation flag - every open tab/device for this user patches its
    // own tradingData cache directly with this payload (see
    // useRealtimeSync's trade_opened handler on the frontend), so seeing
    // it appear costs zero extra HTTP round trips.
    if (io?.emitEntityUpdate) {
      io.emitEntityUpdate(
        userId,
        "trade",
        optimisticTrade.ticketNumber,
        "opened",
        optimisticTrade,
      );
    }
  }

  await notifyTradingDataChanged(
    io,
    userId,
    optimisticTrade ? { ensurePresentTrade: optimisticTrade } : {},
  );

  return { status: 200, json: { success: true, data } };
};

const placeTrade = async (req, res, next) => {
  try {
    const result = await placeTradeCore(
      req.app.get("io"),
      req.user._id,
      req.body,
    );
    return res.status(result.status).json(result.json);
  } catch (error) {
    if (error instanceof TradeHttpError) {
      return res.status(error.status).json(error.json);
    }
    if (!(error instanceof BridgeRejectionError) && !error?.response) {
      console.error("placeTrade failed:", error.message);
    }
    return handleTradeActionError(error, res, next);
  }
};

// Close an open position on one of the caller's own MT5 accounts. Shared
// core - see placeTradeCore's doc comment above for why.
const closeTradeCore = async (io, userId, body) => {
  const { positionId, price } = body;

  if (positionId === undefined || positionId === null || !price) {
    throw new TradeHttpError(400, {
      success: false,
      message: "positionId and price are required",
    });
  }

  const owner = await resolveAccountForTicket(userId, positionId);
  if (!owner) {
    throw new TradeHttpError(404, {
      success: false,
      message: "Open position not found on any of your accounts",
    });
  }

  const response = await tradeActionApi.post(
    "/close-trade",
    {
      Manager_Index: owner.managerIndex,
      positionId: Number(positionId),
      Price: Number(price),
    },
    {
      headers: { "X-MANAGER-ID": owner.managerIndex },
      timeout: TRADE_ACTION_TIMEOUT,
    },
  );

  const data = assertBridgeSuccess(
    response,
    "Trade close was rejected by the broker",
  );

  // Instant, in-memory removal (no network call) - same reasoning as
  // placeTrade's optimistic add above. Keep the removed entry: it has
  // everything (symbol, lot, openTime/openPrice, last-known floating
  // profit, ...) needed to synthesize a closed-trade record below,
  // without an extra broker call.
  const ticket = String(positionId);
  const removedTrade = await removeOpenTradeFromCache(userId, ticket);

  const closedTrade = removedTrade
    ? {
        ...removedTrade,
        status: "closed",
        closeTime: new Date().toISOString(),
        closePrice: String(price),
        closePriceValue: Number(price),
        // The floating P&L we last saw for this ticket was computed by
        // the broker moments ago at essentially this same price, so it's
        // an accurate enough realized-profit estimate to show instantly;
        // tradeSyncService's own DB-backed sync reconciles the exact
        // final figure (commission/swap settled at close, etc.) on its
        // normal cycle, replacing this estimate once it lands.
        profit: removedTrade.profit,
        profitFormatted: removedTrade.profitFormatted,
        positionId: Number(positionId),
        timestamp: Date.now(),
      }
    : null;

  // Same reasoning as placeTrade's push above - every open tab/device for
  // this user removes the position and (if we could build one) upserts
  // the closed record directly, with zero extra HTTP round trips.
  if (io?.emitEntityUpdate) {
    io.emitEntityUpdate(
      userId,
      "trade",
      Number(positionId),
      "closed",
      closedTrade || { ticketNumber: Number(positionId) },
    );
  }

  await notifyTradingDataChanged(io, userId, { ensureAbsentTicket: ticket });

  return { status: 200, json: { success: true, data } };
};

const closeTrade = async (req, res, next) => {
  try {
    const result = await closeTradeCore(
      req.app.get("io"),
      req.user._id,
      req.body,
    );
    return res.status(result.status).json(result.json);
  } catch (error) {
    if (error instanceof TradeHttpError) {
      return res.status(error.status).json(error.json);
    }
    if (!(error instanceof BridgeRejectionError) && !error?.response) {
      console.error("closeTrade failed:", error.message);
    }
    return handleTradeActionError(error, res, next);
  }
};

// Change Stop Loss / Take Profit on an already-open position on one of the
// caller's own MT5 accounts (the broker's update-trade call - unlike
// place-trade, this doesn't open/close anything, just edits the existing
// ticket's SL/TP). Shared core - see placeTradeCore's doc comment above.
const modifyTradeCore = async (io, userId, body) => {
  const { positionId, sl, tp } = body;

  if (
    positionId === undefined ||
    positionId === null ||
    (sl === undefined && tp === undefined)
  ) {
    throw new TradeHttpError(400, {
      success: false,
      message: "positionId and at least one of sl/tp are required",
    });
  }

  const owner = await resolveAccountForTicket(userId, positionId);
  if (!owner) {
    throw new TradeHttpError(404, {
      success: false,
      message: "Open position not found on any of your accounts",
    });
  }

  if (owner.lot === undefined) {
    // update-trade requires echoing the position's current lot size back
    // alongside SL/TP (it isn't a lot-only-optional "patch" call) - if we
    // couldn't determine it (very cold cache and the broker's own open
    // trade list didn't have it either), refuse rather than risk sending
    // a wrong volume that actually changes the position's size.
    throw new TradeHttpError(409, {
      success: false,
      message:
        "Could not determine the position's current lot size - try again in a moment",
    });
  }

  // Always send both fields (never omit one) - we don't know whether the
  // bridge treats a missing SL/TP as "leave unchanged" or "clear to 0",
  // so whichever one the caller isn't changing is echoed back at its
  // current value rather than left out.
  const finalSl = sl !== undefined ? Number(sl) || 0 : (owner.stopLoss ?? 0);
  const finalTp = tp !== undefined ? Number(tp) || 0 : (owner.takeProfit ?? 0);

  const response = await tradeActionApi.post(
    "/update-trade",
    {
      Manager_Index: owner.managerIndex,
      Ticket: Number(positionId),
      Lot: owner.lot,
      SL: finalSl,
      TP: finalTp,
    },
    {
      headers: { "X-MANAGER-ID": owner.managerIndex },
      timeout: TRADE_ACTION_TIMEOUT,
    },
  );

  const data = assertBridgeSuccess(
    response,
    "SL/TP change was rejected by the broker",
  );

  // Instant, in-memory patch (no network call) - merge the new SL/TP into
  // the existing cached entry rather than replacing it, same reasoning as
  // place/closeTrade's optimistic updates above.
  const ticket = String(positionId);
  let updatedTrade = null;
  await patchOpenTradesCache(userId, (trades) =>
    trades.map((t) => {
      if (String(t.ticketNumber ?? t.ticket) !== ticket) return t;
      updatedTrade = {
        ...t,
        stopLoss: finalSl,
        takeProfit: finalTp,
      };
      return updatedTrade;
    }),
  );

  if (io?.emitEntityUpdate) {
    io.emitEntityUpdate(
      userId,
      "trade",
      Number(positionId),
      "updated",
      updatedTrade || { ticketNumber: Number(positionId) },
    );
  }

  await notifyTradingDataChanged(io, userId);

  return { status: 200, json: { success: true, data } };
};

const modifyTrade = async (req, res, next) => {
  try {
    const result = await modifyTradeCore(
      req.app.get("io"),
      req.user._id,
      req.body,
    );
    return res.status(result.status).json(result.json);
  } catch (error) {
    if (error instanceof TradeHttpError) {
      return res.status(error.status).json(error.json);
    }
    if (!(error instanceof BridgeRejectionError) && !error?.response) {
      console.error("modifyTrade failed:", error.message);
    }
    return handleTradeActionError(error, res, next);
  }
};

// Get recent tick history for a symbol from the trading bridge.
const getLiveChartData = async (req, res, next) => {
  try {
    const { symbol, start, range } = req.query;

    if (!symbol || typeof symbol !== "string") {
      return res.status(400).json({
        success: false,
        message: "symbol is required",
      });
    }

    const startValue = Number.parseInt(start, 10) || 0;
    const rangeValue = Number.parseInt(range, 10) || 200;

    const response = await axios.post(
      CHART_API_URL,
      {
        Manager_Index: CHART_MANAGER_INDEX,
        symbol,
        start: startValue,
        range: rangeValue,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: CHART_API_TIMEOUT,
        // The bridge answers "no tick data for this window" (a normal
        // state - e.g. a closed market) with a 404 rather than a 200 -
        // treat that as a real response to pass through, not a failure.
        validateStatus: (status) => status < 500,
      },
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    const isTimeout = error.code === "ECONNABORTED";
    console.error(
      "Failed to fetch chart data:",
      isTimeout ? "timeout" : error.message,
    );
    return res.status(502).json({
      success: false,
      message: isTimeout
        ? "Chart data request timed out"
        : "Failed to fetch chart data",
    });
  }
};

// Shared by getPositionsHistory/getOrdersHistory/getDealsHistory below -
// same ownership check + request/response shape against mt6.apirun.top,
// only the bridge path and the response's error label differ.
const getBridgeHistoryPage = async (req, res, url, label) => {
  try {
    const { accountId } = req.query;
    const page = Number.parseInt(req.query.page, 10) || 1;
    const pageSize = Math.min(
      Number.parseInt(req.query.page_size, 10) || 50,
      HISTORY_MAX_PAGE_SIZE,
    );

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: "accountId is required",
      });
    }

    const account = await Account.findOne({
      _id: accountId,
      user: req.user._id,
      status: true,
    })
      .select("mt5Account managerIndex")
      .lean();

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const managerIndex =
      Number.parseInt(account.managerIndex, 10) || DEFAULT_MANAGER_INDEX;

    const response = await axios.post(
      url,
      {
        Manager_Index: managerIndex,
        MT5Account: Number(account.mt5Account),
        page_size: pageSize,
        page,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: HISTORY_API_TIMEOUT,
      },
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    const isTimeout = error.code === "ECONNABORTED";
    console.error(
      `Failed to fetch ${label} history:`,
      isTimeout ? "timeout" : error.message,
    );
    return res.status(502).json({
      success: false,
      message: isTimeout
        ? `${label} history request timed out`
        : `Failed to fetch ${label} history`,
    });
  }
};

// Paginated order history for one of the caller's own MT5 accounts,
// straight from the broker bridge - confirmed live against
// ORDERS_HISTORY_API_URL (Manager_Index/MT5Account/page_size/page body,
// {status, total_orders, page_size, current_page, total_pages, orders: [...]}
// response).
const getOrdersHistory = (req, res, next) =>
  getBridgeHistoryPage(req, res, ORDERS_HISTORY_API_URL, "orders");

// Same as getOrdersHistory but the broker's executed-deal log - confirmed
// live against DEALS_HISTORY_API_URL ({..., total_deals, deals: [...]}
// response).
const getDealsHistory = (req, res, next) =>
  getBridgeHistoryPage(req, res, DEALS_HISTORY_API_URL, "deals");

module.exports = {
  getLiveChartData,
  getOrdersHistory,
  getDealsHistory,
  placeTrade,
  closeTrade,
  modifyTrade,
  // Exported for utils/socketServer.js's trade:place/close/modify handlers
  // — the exact same validation/bridge-call/optimistic-cache logic the
  // REST routes above use, just reached over the socket's own ack
  // callback instead of an HTTP round trip, so a client already holding
  // an open connection doesn't pay a fresh TCP/TLS/CORS-preflight cost
  // per trade action. See placeTradeCore's doc comment.
  placeTradeCore,
  closeTradeCore,
  modifyTradeCore,
  buildSocketErrorPayload,
};

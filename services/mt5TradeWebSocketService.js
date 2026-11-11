// Backend/services/mt5TradeWebSocketService.js
//
// Real-time OPEN trade feed driven by the MT5 info-feed WebSocket — replaces
// openTradeSyncService's REST-polling loop (kept on disk, no longer wired
// into index.js — same relationship as accountSyncService.js).
//
// One WS connection per distinct managerIndex, reusing the manager list /
// mt5Account -> {accountId, userId, ...} directory that
// mt5AccountWebSocketService already builds from the DB (so we don't poll
// it a second time) - but, unlike that sibling service, NOT scoped to
// users who currently have a Socket.IO connection open. A trade placed
// directly in the MT5 terminal (not through our app) isn't tied to any
// online/offline state on our side at all, so gating the subscribe by
// "online" accounts meant those trades never showed up here until the
// owner happened to have the dashboard open AND the online-set changed
// after the trade was placed - broken for exactly the case that matters.
// Instead we ask the feed for every account on the manager:
//   { "mode": "trades", "manager_index": <n>, "all_accounts": true }
// (confirmed live) and the server replies with TWO kinds of messages:
//   1. One full snapshot right away:
//      { "type": "trades", "data": [ { ...every currently-open trade... } ] }
//   2. A continuous stream of single-trade tick updates (P&L moving with
//      price) as they happen:
//      { "type": "live", "data": { ...one trade... } }
// Ticks never announce a trade closing, so we keep a per-manager registry of
// open trades (keyed by the feed's own composite_key) that a "live" tick
// updates in place, and periodically re-send the subscribe message on the
// same socket to get a fresh full snapshot — which we use to replace the
// registry outright, dropping anything no longer present (i.e. closed).
//
// No REST fallback while a manager's socket is down - reconnecting (with
// backoff, see scheduleReconnect) is the recovery path; a per-account REST
// poll across every account on a manager (thousands, not just whoever's
// online) would be far too expensive to run on a timer.
//
// DB is never touched here (open trades aren't persisted — the existing
// tradeSyncService handles CLOSED trade history) and cache writes are
// batched on a short flush interval instead of firing per-tick.

const WebSocket = require("ws");
const accountDirectory = require("./mt5AccountWebSocketService");
require("dotenv").config();

const WS_URL = process.env.MT5_WS_URL || "ws://socket.infoapi.biz/ws/mt5";

const MANAGER_RECONCILE_MS = 60000; // pick up managerIndexes newly known to accountDirectory
const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
// A full snapshot is small, so resyncing often is cheap. This is the only
// way to detect a closed trade ("live" ticks never announce it).
const RESUBSCRIBE_MS = 5000;
const FLUSH_MS = 500; // how often batched cache writes / invalidation pushes fire

const toNumber = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null);

// Mirrors tradingController.formatTradeData()'s "open" shape exactly, so
// the cache this writes is a drop-in for what openTradeSyncService used to
// write and getUserTrades/getUserOpenTrades need no changes.
const formatTrade = (trade, accountEntry) => {
  const tradeType = firstDefined(trade.buy_sell_display, null)
    ? trade.buy_sell_display
    : firstDefined(trade.BUY_SELL, trade.buy_sell, trade.type, trade.side) === 0
      ? "Buy"
      : "Sell";

  const profit = Number(firstDefined(trade.Profit, trade.profit, 0)) || 0;
  const lot = Number(firstDefined(trade.Lot, trade.lot, trade.volume, trade.Volume, 0)) || 0;

  return {
    account: String(firstDefined(trade.MT5Account, trade.mt5_account, trade.login, trade.Login, "")),
    accountName: accountEntry.name || "Unknown",
    accountType: accountEntry.accountType || "Unknown",
    groupName: accountEntry.groupName || "Unknown",
    leverage: accountEntry.leverage || 0,
    symbol: firstDefined(trade.Symbol, trade.symbol, "N/A"),
    openTime: firstDefined(trade.Open_Time, trade.open_time, "N/A"),
    openPrice: String(firstDefined(trade.Open_Price, trade.open_price, "N/A")),
    trade: tradeType,
    tradeType: tradeType.toLowerCase(),
    volume: lot.toFixed(2),
    lotSize: lot,
    profit: parseFloat(profit.toFixed(2)),
    profitFormatted:
      profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`,
    status: "open",
    ticket: String(firstDefined(trade.Ticket, trade.ticket, trade.order, "N/A")),
    ticketNumber: Number(firstDefined(trade.Ticket, trade.ticket, trade.order, 0)) || 0,
    commission: Number(firstDefined(trade.Commission, trade.commission, 0)) || 0,
    swap: Number(firstDefined(trade.Swap, trade.swap, 0)) || 0,
    stopLoss: Number(firstDefined(trade.Stop_Loss, trade.stop_loss, 0)) || 0,
    takeProfit: Number(firstDefined(trade.Target_Price, trade.target_price, 0)) || 0,
    comment: firstDefined(trade.Comment, trade.comment, ""),
    taxes: Number(firstDefined(trade.Taxes, trade.taxes, 0)) || 0,
    currentPrice: String(firstDefined(trade.Price_Current, trade.price_current, "N/A")),
    currentPriceValue: Number(firstDefined(trade.Price_Current, trade.price_current, 0)) || 0,
    openTimeSec: Number(firstDefined(trade.Open_Time_Sec, trade.open_time_sec, 0)) || 0,
    volumeTotal: Number(firstDefined(trade.Volume, trade.volume, 0)) || 0,
  };
};

const compositeKey = (managerIndex, trade) =>
  trade.composite_key ??
  `${managerIndex}_${trade.MT5Account ?? trade.mt5_account ?? trade.login ?? trade.Login}_${
    trade.Ticket ?? trade.ticket ?? trade.order
  }`;

class Mt5TradeWebSocketService {
  constructor() {
    this.io = null;
    this.isRunning = false;
    this.connections = new Map(); // managerIndex -> conn

    // managerIndex -> Map(compositeKey -> { trade: raw item, userId })
    this.openTradesByManager = new Map();

    this.pendingUserIds = new Set();
    // Subset of pendingUserIds whose open-ticket SET changed (a real
    // open/close), not just a P&L tick on an already-known ticket - see
    // flush() for why this is invalidated separately from the socket push.
    this.pendingCacheInvalidationUserIds = new Set();
    this.flushInterval = null;

    this.stats = {
      lastMessageTime: null,
      messagesReceived: 0,
      errorCount: 0,
    };

    // Lazily required to avoid a require cycle at module-load time
    // (tradingController doesn't require this service).
    this._trading = null;
  }

  get trading() {
    if (!this._trading) {
      this._trading = require("../controllers/client/tradingController");
    }
    return this._trading;
  }

  setSocketServer(io) {
    this.io = io;
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  async startAutoSync() {
    if (this.isRunning) {
      console.log("⚠️ MT5 WebSocket open-trade sync is already running");
      return;
    }
    this.isRunning = true;
    console.log("🔄 MT5 WebSocket open-trade sync started");

    this.reconcileConnections();

    this.reconcileInterval = setInterval(
      () => this.reconcileConnections(),
      MANAGER_RECONCILE_MS
    );
    this.flushInterval = setInterval(() => this.flush(), FLUSH_MS);
  }

  async stopAutoSync() {
    this.isRunning = false;
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    if (this.flushInterval) clearInterval(this.flushInterval);

    for (const [managerIndex, conn] of this.connections) {
      clearTimeout(conn.reconnectTimer);
      clearInterval(conn.heartbeatTimer);
      clearInterval(conn.resubscribeTimer);
      try {
        conn.ws?.removeAllListeners();
        conn.ws?.close();
      } catch (_) {}
      this.connections.delete(managerIndex);
    }
    console.log("⏹️ MT5 WebSocket open-trade sync stopped");
  }

  // opens a connection for any managerIndex we now know about but aren't
  // connected to yet (picked up from accountDirectory's own DB-backed
  // account map - not an online-user concept, just "which managers exist").
  reconcileConnections() {
    for (const managerIndex of accountDirectory.getManagerIndexes()) {
      if (!this.connections.has(managerIndex)) this.connect(managerIndex);
    }
  }

  // ─── per-manager WS connection ───────────────────────────────────────────

  connect(managerIndex) {
    if (!this.isRunning) return;

    const existing = this.connections.get(managerIndex);
    const reconnectAttempts = existing?.reconnectAttempts || 0;

    const conn = existing || {
      ws: null,
      reconnectAttempts,
      reconnectTimer: null,
      heartbeatTimer: null,
      resubscribeTimer: null,
      lastMessageAt: Date.now(),
      lastError: null,
    };
    conn.reconnectAttempts = reconnectAttempts;
    this.connections.set(managerIndex, conn);

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error(`MT5 trade WS (manager ${managerIndex}): failed to construct socket -`, err.message);
      this.scheduleReconnect(managerIndex);
      return;
    }
    conn.ws = ws;

    // Every account on this manager, not just whoever's currently online -
    // see the header comment above for why.
    const subscribe = () => {
      ws.send(
        JSON.stringify({ mode: "trades", manager_index: managerIndex, all_accounts: true }),
      );
    };
    conn.subscribe = subscribe;

    ws.on("open", () => {
      conn.reconnectAttempts = 0;
      conn.lastMessageAt = Date.now();
      console.log(`✅ MT5 trade WS connected (manager ${managerIndex})`);

      subscribe();

      conn.heartbeatTimer = setInterval(() => {
        if (Date.now() - conn.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
          console.warn(`⚠️ MT5 trade WS (manager ${managerIndex}): stale connection, reconnecting`);
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch (_) {}
      }, HEARTBEAT_MS);

      // "live" ticks never announce a close — only a fresh full snapshot
      // can tell us a ticket disappeared, so ask for one periodically
      conn.resubscribeTimer = setInterval(() => {
        try {
          subscribe();
        } catch (_) {}
      }, RESUBSCRIBE_MS);
    });

    ws.on("message", (raw) => {
      conn.lastMessageAt = Date.now();
      this.stats.messagesReceived++;
      this.stats.lastMessageTime = new Date();
      try {
        this.handleMessage(managerIndex, raw);
      } catch (err) {
        this.stats.errorCount++;
        console.error(`MT5 trade WS (manager ${managerIndex}): message handling error -`, err.message);
      }
    });

    ws.on("pong", () => {
      conn.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      this.stats.errorCount++;
      conn.lastError = err.message;
      console.error(`MT5 trade WS (manager ${managerIndex}) error:`, err.message);
    });

    ws.on("close", () => {
      clearInterval(conn.heartbeatTimer);
      clearInterval(conn.resubscribeTimer);
      if (this.isRunning) {
        console.warn(`MT5 trade WS (manager ${managerIndex}) closed, reconnecting…`);
        this.scheduleReconnect(managerIndex);
      }
    });
  }

  scheduleReconnect(managerIndex) {
    const conn = this.connections.get(managerIndex);
    if (!conn || !this.isRunning) return;

    conn.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (conn.reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    conn.reconnectTimer = setTimeout(() => this.connect(managerIndex), delay);
  }

  // ─── message processing ─────────────────────────────────────────────────

  handleMessage(managerIndex, raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (payload.type === "trades" && Array.isArray(payload.data)) {
      this.replaceSnapshot(managerIndex, payload.data);
    } else if (payload.type === "live" && payload.data) {
      this.applyTick(managerIndex, payload.data);
    }
  }

  // full snapshot replaces the registry outright — this is the only signal
  // that tells us a trade closed (it just stops appearing). We diff against
  // the previous registry per-user and only queue a flush for users whose
  // actual open-ticket set changed.
  replaceSnapshot(managerIndex, trades) {
    const previousRegistry = this.openTradesByManager.get(managerIndex);
    const registry = new Map();

    for (const trade of trades) {
      const entry = this.resolveAccountEntry(managerIndex, trade);
      if (!entry || !entry.userId) continue;
      registry.set(compositeKey(managerIndex, trade), { trade, userId: entry.userId });
    }

    this.openTradesByManager.set(managerIndex, registry);

    // Anything in the previous registry that isn't in this fresh snapshot
    // just closed - push it to History immediately (see emitClosedTrade)
    // instead of waiting on tradeSyncService's own ~30s DB-backed sync
    // cycle, which is the only other thing that currently tells a client
    // "your closed trades changed". Covers a close made directly in MT5,
    // not just one made through this app (placeTradeCore/closeTradeCore
    // already emit this same event for their own actions).
    if (previousRegistry) {
      for (const [key, { trade, userId }] of previousRegistry) {
        if (!registry.has(key)) this.emitClosedTrade(managerIndex, trade, userId);
      }
    }

    for (const userId of this.usersWithChangedTickets(previousRegistry, registry)) {
      this.pendingUserIds.add(userId);
      // An actual open/close (ticket set changed), not just a P&L tick -
      // also invalidate the REST-layer caches (getUserTrades/
      // getUserOpenTrades) so a trade placed straight in MT5 shows up on
      // the very next REST refresh instead of sitting stale for that
      // cache's TTL.
      this.pendingCacheInvalidationUserIds.add(userId);
    }
  }

  // Synthesizes a closed-trade record from the position's last-known state
  // (same reasoning as closeTradeCore's own optimistic closedTrade in
  // liveTradingController.js: the floating P&L this feed last saw for this
  // ticket was computed by the broker moments ago at essentially the close
  // price, so it's an accurate enough realized-profit estimate to show
  // instantly - tradeSyncService's own DB-backed sync reconciles the exact
  // final figure, commission/swap settled at close, on its normal cycle,
  // replacing this estimate once it lands with the same ticket id) - and
  // emits it as "trade_closed", the exact event closeTradeCore already
  // emits for its own close actions, so every existing listener (web's
  // patchTradeClosedCache, the app's onTradeEvent) picks up a close made
  // straight in MT5 too, with no client-side changes needed.
  emitClosedTrade(managerIndex, trade, userId) {
    const entry = this.resolveAccountEntry(managerIndex, trade);
    if (!entry) return;

    const formatted = formatTrade(trade, entry);
    const closedTrade = {
      ...formatted,
      status: "closed",
      closeTime: new Date().toISOString(),
      closePrice: formatted.currentPrice,
      closePriceValue: formatted.currentPriceValue,
      positionId: formatted.ticketNumber,
      timestamp: Date.now(),
    };

    this.io?.emitEntityUpdate?.(userId, "trade", formatted.ticketNumber, "closed", closedTrade);
  }

  usersWithChangedTickets(previousRegistry, nextRegistry) {
    const ticketsByUser = (registry) => {
      const map = new Map();
      for (const [key, { userId }] of registry || []) {
        if (!map.has(userId)) map.set(userId, new Set());
        map.get(userId).add(key);
      }
      return map;
    };

    const before = ticketsByUser(previousRegistry);
    const after = ticketsByUser(nextRegistry);
    const changed = new Set();

    for (const userId of new Set([...before.keys(), ...after.keys()])) {
      const beforeSet = before.get(userId) || new Set();
      const afterSet = after.get(userId) || new Set();
      const same =
        beforeSet.size === afterSet.size && [...beforeSet].every((k) => afterSet.has(k));
      if (!same) changed.add(userId);
    }

    return changed;
  }

  // a single-trade tick updates (or inserts) one entry in the registry
  applyTick(managerIndex, trade) {
    const entry = this.resolveAccountEntry(managerIndex, trade);
    if (!entry || !entry.userId) return;

    if (!this.openTradesByManager.has(managerIndex)) {
      this.openTradesByManager.set(managerIndex, new Map());
    }
    const registry = this.openTradesByManager.get(managerIndex);
    const key = compositeKey(managerIndex, trade);
    const isNewTicket = !registry.has(key); // a trade just opened, mid-cycle
    registry.set(key, { trade, userId: entry.userId });

    this.pendingUserIds.add(entry.userId);
    if (isNewTicket) this.pendingCacheInvalidationUserIds.add(entry.userId);
  }

  resolveAccountEntry(managerIndex, trade) {
    const mt5Account = toNumber(
      trade.MT5Account ?? trade.mt5_account ?? trade.login ?? trade.Login
    );
    if (!mt5Account) return null;
    return accountDirectory.getAccountEntry(managerIndex, mt5Account);
  }

  // ─── flush: push the live open-trades list straight over Socket.IO ─────
  // Batched instead of per-tick (the "live" feed can fire many times/sec —
  // FLUSH_MS above caps how often this runs, so a fast-moving position
  // doesn't turn into a flood of socket emits).
  //
  // No intermediate cache WRITE here — the positions panel gets the actual
  // trade list directly via open_trades_updated, so there's nothing for a
  // cache to serve. (getWarmOpenTrades() in tradingController.js is what
  // the REST endpoints fall back to for an initial page load before a
  // socket connects; it now simply always takes its "cold" live-fetch
  // branch since nothing populates that cache anymore.) We DO still
  // invalidate the REST endpoints' own short-TTL response caches below -
  // without that, a trade placed straight in MT5 (no socket, no app
  // action of ours to trigger the usual invalidateTradingCaches call)
  // would sit stale in trading:trades:*/trading:open:* until that TTL
  // (5-10s) expired on its own, even after clicking "refresh".

  async flush() {
    if (this.pendingUserIds.size === 0) return;

    const userIds = [...this.pendingUserIds];
    this.pendingUserIds.clear();
    const cacheInvalidationUserIds = [...this.pendingCacheInvalidationUserIds];
    this.pendingCacheInvalidationUserIds.clear();

    await Promise.all(
      userIds.map(async (userId) => {
        const trades = this.buildUserOpenTrades(userId);
        trades.sort((a, b) => new Date(b.openTime) - new Date(a.openTime));
        const accounts = accountDirectory.getUserAccountMetas(userId);
        const updatedAt = Date.now();

        // Push the actual open-positions list straight to the user's own
        // room — only sockets logged in as this user ever receive it.
        this.io?.to?.(`user_${userId}`)?.emit("open_trades_updated", {
          trades,
          accounts,
          updatedAt,
        });
      })
    );

    if (cacheInvalidationUserIds.length > 0) {
      const { invalidateTradingCaches } = this.trading;
      await Promise.all(
        cacheInvalidationUserIds.map((userId) =>
          invalidateTradingCaches(userId).catch((err) =>
            console.error(
              `MT5 trade WS: cache invalidation failed for user ${userId}:`,
              err.message,
            ),
          ),
        ),
      );
    }
  }

  buildUserOpenTrades(userId) {
    const trades = [];
    for (const [managerIndex, registry] of this.openTradesByManager) {
      for (const { trade, userId: tradeUserId } of registry.values()) {
        if (tradeUserId !== userId) continue;
        const entry = this.resolveAccountEntry(managerIndex, trade);
        if (!entry) continue;
        trades.push(formatTrade(trade, entry));
      }
    }
    return trades;
  }

  // ─── status ──────────────────────────────────────────────────────────────

  getSyncStatus() {
    let openTradeCount = 0;
    for (const registry of this.openTradesByManager.values()) openTradeCount += registry.size;

    return {
      isRunning: this.isRunning,
      connections: [...this.connections.entries()].map(([managerIndex, conn]) => ({
        managerIndex,
        connected: conn.ws?.readyState === WebSocket.OPEN,
        reconnectAttempts: conn.reconnectAttempts,
      })),
      openTradeCount,
      ...this.stats,
    };
  }
}

module.exports = new Mt5TradeWebSocketService();

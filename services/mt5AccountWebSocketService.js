// Backend/services/mt5AccountWebSocketService.js
//
// Real-time account (balance/equity) sync driven by the MT5 info-feed
// WebSocket instead of polling GetUserInfoByAccounts over HTTP every 30s
// (see the old services/accountSyncService.js, kept on disk but no longer
// wired into index.js — same relationship as the REST-polling service it
// replaces there).
//
// One WS connection is opened per distinct managerIndex found in the
// Account collection. On connect (and immediately whenever the online-user
// set changes, see below) we send a subscribe message naming exactly the
// MT5 logins we care about right now:
//   { "mode": "accounts", "manager_index": <n>, "accounts": [<login>, ...] }
// and the server replies with TWO kinds of messages, scoped to just the
// accounts list we sent:
//   1. One full snapshot right away:
//      { "type": "accounts", "data": [ { login, balance, equity, margin,
//        free_margin, margin_level, profit, credit, leverage, isEnable,
//        group_name, updated_at, ... }, ... ] }
//   2. A continuous firehose of single-account tick updates as they change:
//      { "type": "live", "data": { ...same fields, one account... } }
// Re-sending the same subscribe message on the already-open socket makes
// the server push a fresh full "accounts" snapshot again — we do that
// periodically as a safety-net reconcile (catches anything a dropped
// message might have missed).
//
// The "accounts" list is further narrowed to only logins belonging to a
// user who is *currently connected to our own Socket.IO*
// (setUserOnline/setUserOffline below, wired from utils/socketServer.js's
// connection/disconnect handlers) — an account nobody has the dashboard
// open for right now doesn't need a live tick stream. Balance/equity for
// offline users just serves from whatever was last persisted to Mongo
// (updated live any time they were last online, or via deposit/withdrawal/
// transfer, which write straight to the DB regardless of this feed) until
// they reconnect, at which point subscribe() picks their accounts back up
// immediately.
//
// Given the tick volume, we don't write to Mongo / emit on every message —
// we update an in-memory cache synchronously (cheap) and flush accumulated
// changes to the DB + Socket.IO on a short interval (FLUSH_MS), so the
// frontend still feels live (sub-second) without hammering Mongo or the
// socket transport thousands of times a second.
//
// For every changed account we persist balance/equity to the Account
// document and, if a socket server has been attached (setSocketServer),
// call io.emitAccountUpdate(userId, account) — the same push this repo's
// controllers already use after a deposit/withdrawal/transfer — so an
// online user's dashboard updates live with no extra polling.

const WebSocket = require("ws");
const { EventEmitter } = require("events");
const Account = require("../models/client/Account");
const { metaApi } = require("../API/metaApi");
require("dotenv").config();

const WS_URL = process.env.MT5_WS_URL || "ws://socket.infoapi.biz/ws/mt5";
const DEFAULT_MANAGER_INDEX = Number.parseInt(process.env.MANAGER_INDEX, 10) || 1;

const MAP_REFRESH_MS = 60000; // pick up newly-created accounts
const FULL_REBUILD_MS = 30 * 60 * 1000; // reconcile renames/deletes
const HEARTBEAT_MS = 30000; // client-side liveness ping
// While a manager's WS connection is down, poll GetUserInfoByAccounts for
// that manager's (online-user) accounts on this interval instead of leaving
// balance/equity stuck on whatever the last good tick was. Skipped entirely
// for any manager whose socket is open.
const REST_FALLBACK_POLL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 45000; // if no pong/message in this long, reconnect
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const RESUBSCRIBE_MS = 30000; // periodic full-snapshot reconcile
const FLUSH_MS = 250; // how often batched DB writes / socket emits fire
// A page refresh (or a flaky connection) drops a Socket.IO socket and opens
// a new one within milliseconds — don't drop a user's MT5 subscription (and
// force a resubscribe round-trip) for that. setUserOffline only takes effect
// if the user hasn't reconnected within this window.
const OFFLINE_DEBOUNCE_MS = 8000;

const toNumber = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

class Mt5AccountWebSocketService extends EventEmitter {
  constructor() {
    super();
    this.io = null;
    this.isRunning = false;

    // managerIndex (number) -> { ws, reconnectAttempts, reconnectTimer,
    //                            heartbeatTimer, lastMessageAt }
    this.connections = new Map();

    // managerIndex (number) -> Map(mt5Account number -> account meta)
    this.accountsByManager = new Map();
    // userId (string) -> Set(mt5Account number) for aggregation on emit
    this.accountsByUser = new Map();
    // accountId (string) -> latest merged live fields
    this.liveCache = new Map();

    // userId (string) currently holding at least one open Socket.IO
    // connection — see setUserOnline/setUserOffline. Drives which accounts
    // subscribe() actually asks the MT5 feed for.
    this.onlineUserIds = new Set();
    // userId (string) -> setTimeout handle for a pending (debounced) offline
    this.pendingOfflineTimers = new Map();

    // accumulated since last flush
    this.pendingAccountIds = new Set();
    this.flushInterval = null;

    // managerIndex (number) -> true while a REST fallback poll for that
    // manager is in flight, so the watchdog never overlaps two calls to the
    // same manager if one poll runs long.
    this.restFallbackInFlight = new Set();
    this.restFallbackInterval = null;

    this.mapBuiltAt = 0;
    this.lastFullBuildAt = 0;
    this.knownAccountIds = new Set();

    this.stats = {
      status: "idle",
      lastMessageTime: null,
      messagesReceived: 0,
      writesApplied: 0,
      errorCount: 0,
    };
  }

  // ─── socket server wiring ────────────────────────────────────────────────

  setSocketServer(io) {
    this.io = io;
  }

  // ─── account map (DB) ───────────────────────────────────────────────────

  async buildAccountMap(full = true) {
    const filter = full ? {} : { createdAt: { $gt: new Date(this.mapBuiltAt || 0) } };

    const accounts = await Account.find(filter)
      .select("mt5Account managerIndex _id user accountType name groupName platform leverage status")
      .lean();

    if (full) {
      this.accountsByManager = new Map();
      this.accountsByUser = new Map();
      this.knownAccountIds.clear();
    }

    let addedCount = 0;
    for (const account of accounts) {
      const mt5Account = toNumber(account.mt5Account);
      if (!mt5Account || this.knownAccountIds.has(mt5Account)) continue;

      const managerIndex = toNumber(account.managerIndex) ?? DEFAULT_MANAGER_INDEX;
      const userId = account.user?.toString();

      if (!this.accountsByManager.has(managerIndex)) {
        this.accountsByManager.set(managerIndex, new Map());
      }
      this.accountsByManager.get(managerIndex).set(mt5Account, {
        accountId: account._id,
        userId,
        mt5Account: account.mt5Account,
        accountType: account.accountType,
        name: account.name,
        groupName: account.groupName,
        platform: account.platform,
        leverage: account.leverage,
        status: account.status,
      });

      if (userId) {
        if (!this.accountsByUser.has(userId)) this.accountsByUser.set(userId, new Set());
        this.accountsByUser.get(userId).add(mt5Account);
      }

      this.knownAccountIds.add(mt5Account);
      addedCount++;
    }

    this.mapBuiltAt = Date.now();
    if (full) this.lastFullBuildAt = this.mapBuiltAt;

    if (!full && addedCount > 0) {
      console.log(`➕ MT5 WS sync: picked up ${addedCount} new account(s)`);
      await this.reconcileConnections();
    } else if (full) {
      await this.reconcileConnections();
    }

    return this.accountsByManager;
  }

  async refreshAccountMapIfDue() {
    const now = Date.now();
    if (this.mapBuiltAt === 0) {
      await this.buildAccountMap(true);
    } else if (now - this.lastFullBuildAt > FULL_REBUILD_MS) {
      await this.buildAccountMap(true);
    } else if (now - this.mapBuiltAt > MAP_REFRESH_MS) {
      await this.buildAccountMap(false);
    }
  }

  // opens a connection for any managerIndex we now know about but aren't
  // connected to yet, and for a manager whose socket is already open,
  // re-sends the subscribe message so any account/online-set change is
  // picked up immediately instead of waiting for the next resubscribe tick.
  async reconcileConnections() {
    for (const managerIndex of this.accountsByManager.keys()) {
      const conn = this.connections.get(managerIndex);
      if (!conn) {
        this.connect(managerIndex);
      } else if (conn.ws?.readyState === WebSocket.OPEN && conn.subscribe) {
        try {
          conn.subscribe();
        } catch (_) {}
      }
    }
  }

  // ─── online-user tracking ───────────────────────────────────────────────
  // Wired from utils/socketServer.js's Socket.IO connection/disconnect
  // handlers. Narrows what subscribe() actually asks the MT5 feed for down
  // to accounts belonging to a user who currently has the dashboard open.

  setUserOnline(userId) {
    if (!userId) return;
    userId = userId.toString();

    const pendingTimer = this.pendingOfflineTimers.get(userId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.pendingOfflineTimers.delete(userId);
    }

    if (this.onlineUserIds.has(userId)) return; // already tracked as online
    this.onlineUserIds.add(userId);
    this.onOnlineSetChanged();
  }

  setUserOffline(userId) {
    if (!userId) return;
    userId = userId.toString();
    if (!this.onlineUserIds.has(userId)) return;
    if (this.pendingOfflineTimers.has(userId)) return; // already scheduled

    const timer = setTimeout(() => {
      this.pendingOfflineTimers.delete(userId);
      if (this.onlineUserIds.delete(userId)) this.onOnlineSetChanged();
    }, OFFLINE_DEBOUNCE_MS);
    this.pendingOfflineTimers.set(userId, timer);
  }

  onOnlineSetChanged() {
    this.reconcileConnections().catch((err) =>
      console.error("MT5 WS sync: reconcile after online-set change failed:", err.message)
    );
    this.emit("onlineUsersChanged");
  }

  // mt5Account numbers, for this manager, belonging to a currently-online user
  getOnlineAccountsForManager(managerIndex) {
    const accountMap = this.accountsByManager.get(managerIndex);
    if (!accountMap) return [];
    const accounts = [];
    for (const [mt5Account, entry] of accountMap) {
      if (entry.userId && this.onlineUserIds.has(entry.userId)) accounts.push(mt5Account);
    }
    return accounts;
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  async startAutoSync() {
    if (this.isRunning) {
      console.log("⚠️ MT5 WebSocket account sync is already running");
      return;
    }
    this.isRunning = true;

    await this.buildAccountMap(true);
    console.log(
      `🔄 MT5 WebSocket account sync started for manager(s): ${[...this.accountsByManager.keys()].join(", ") || "(none yet)"}`
    );

    this.mapRefreshInterval = setInterval(() => {
      this.refreshAccountMapIfDue().catch((err) =>
        console.error("MT5 WS sync: account map refresh failed:", err.message)
      );
    }, MAP_REFRESH_MS);

    this.flushInterval = setInterval(() => this.flush(), FLUSH_MS);

    this.restFallbackInterval = setInterval(() => {
      this.pollDisconnectedManagersViaRest().catch((err) =>
        console.error("MT5 WS sync: REST fallback watchdog failed:", err.message)
      );
    }, REST_FALLBACK_POLL_MS);
  }

  async stopAutoSync() {
    this.isRunning = false;
    if (this.mapRefreshInterval) clearInterval(this.mapRefreshInterval);
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.restFallbackInterval) clearInterval(this.restFallbackInterval);
    for (const timer of this.pendingOfflineTimers.values()) clearTimeout(timer);
    this.pendingOfflineTimers.clear();

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
    console.log("⏹️ MT5 WebSocket account sync stopped");
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
      lastMessageAt: Date.now(),
      lastError: null,
    };
    conn.reconnectAttempts = reconnectAttempts;
    this.connections.set(managerIndex, conn);

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error(`MT5 WS (manager ${managerIndex}): failed to construct socket -`, err.message);
      this.scheduleReconnect(managerIndex);
      return;
    }
    conn.ws = ws;

    const subscribe = () => {
      const accounts = this.getOnlineAccountsForManager(managerIndex);
      if (accounts.length === 0) return; // nobody online for this manager right now
      ws.send(JSON.stringify({ mode: "accounts", manager_index: managerIndex, accounts }));
    };
    // exposed so reconcileConnections() can push an updated account list to
    // an already-open socket without waiting for the next resubscribe tick
    conn.subscribe = subscribe;

    ws.on("open", () => {
      conn.reconnectAttempts = 0;
      conn.lastMessageAt = Date.now();
      console.log(`✅ MT5 WS connected (manager ${managerIndex})`);

      subscribe();

      conn.heartbeatTimer = setInterval(() => {
        if (Date.now() - conn.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
          console.warn(`⚠️ MT5 WS (manager ${managerIndex}): stale connection, reconnecting`);
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch (_) {}
      }, HEARTBEAT_MS);

      // periodic full-snapshot reconcile (safety net for any missed "live" ticks)
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
        console.error(`MT5 WS (manager ${managerIndex}): message handling error -`, err.message);
      }
    });

    ws.on("pong", () => {
      conn.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      this.stats.errorCount++;
      conn.lastError = err.message;
      console.error(`MT5 WS (manager ${managerIndex}) error:`, err.message);
    });

    ws.on("close", () => {
      clearInterval(conn.heartbeatTimer);
      clearInterval(conn.resubscribeTimer);
      if (this.isRunning) {
        console.warn(`MT5 WS (manager ${managerIndex}) closed, reconnecting…`);
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
      return; // not JSON (e.g. a plain pong frame) — ignore
    }

    let items;
    if (payload.type === "accounts" && Array.isArray(payload.data)) {
      items = payload.data;
    } else if (payload.type === "live" && payload.data) {
      items = [payload.data];
    } else {
      return;
    }

    const accountMap = this.accountsByManager.get(managerIndex);
    if (!accountMap || accountMap.size === 0) return;

    for (const item of items) {
      const mt5Account = toNumber(item.login ?? item.Login ?? item.MT5Account);
      if (!mt5Account) continue;

      this.applyLiveUpdate(accountMap, mt5Account, {
        balance: Number(item.balance ?? 0),
        equity: Number(item.equity ?? 0),
        margin: Number(item.margin ?? 0),
        freeMargin: Number(item.free_margin ?? 0),
        profit: Number(item.profit ?? 0),
        credit: Number(item.credit ?? 0),
        marginLevel: Number(item.margin_level ?? 0),
        leverage: item.leverage,
        isEnable: item.isEnable,
        groupName: item.group_name,
      });
    }
  }

  // Shared by both the WS tick handler above and the REST fallback watchdog
  // below — updates the in-memory live cache for one account and marks it
  // pending for the next flush() (DB write + Socket.IO emit), regardless of
  // which source the fresh numbers came from.
  applyLiveUpdate(accountMap, mt5Account, fields) {
    const entry = accountMap.get(mt5Account);
    if (!entry) return; // not one of our accounts

    const { balance, equity } = fields;
    const accountKey = entry.accountId.toString();
    const previous = this.liveCache.get(accountKey);
    const changed = !previous || previous.balance !== balance || previous.equity !== equity;

    this.liveCache.set(accountKey, {
      balance,
      equity,
      margin: fields.margin ?? 0,
      freeMargin: fields.freeMargin ?? 0,
      marginLevel: fields.marginLevel ?? 0,
      profit: fields.profit ?? 0,
      credit: fields.credit ?? 0,
      leverage: fields.leverage ?? entry.leverage,
      isEnable: fields.isEnable,
      groupName: fields.groupName ?? entry.groupName,
      updatedAt: new Date(),
    });

    if (changed) this.pendingAccountIds.add(accountKey);
  }

  // ─── REST fallback watchdog ──────────────────────────────────────────────

  isManagerConnected(managerIndex) {
    return this.connections.get(managerIndex)?.ws?.readyState === WebSocket.OPEN;
  }

  async pollDisconnectedManagersViaRest() {
    const managerIndexes = [...this.accountsByManager.keys()].filter(
      (managerIndex) =>
        !this.isManagerConnected(managerIndex) &&
        !this.restFallbackInFlight.has(managerIndex)
    );

    await Promise.allSettled(
      managerIndexes.map((managerIndex) => this.restPollManager(managerIndex))
    );
  }

  async restPollManager(managerIndex) {
    const accountMap = this.accountsByManager.get(managerIndex);
    if (!accountMap || accountMap.size === 0) return;

    // Same online-only scoping as the WS subscribe — no point polling for a
    // user who doesn't have the dashboard open right now.
    const mt5Accounts = this.getOnlineAccountsForManager(managerIndex);
    if (mt5Accounts.length === 0) return;

    this.restFallbackInFlight.add(managerIndex);
    try {
      const response = await metaApi.post("/GetUserInfoByAccounts", {
        Manager_Index: managerIndex,
        MT5Accounts: mt5Accounts,
      });

      if (!Array.isArray(response.data)) return;

      for (const item of response.data) {
        const mt5Account = toNumber(item.MT5Account ?? item.Login ?? item.login);
        if (!mt5Account) continue;

        this.applyLiveUpdate(accountMap, mt5Account, {
          balance: Number(item.Balance ?? item.balance ?? 0),
          equity: Number(item.Equity ?? item.equity ?? 0),
          margin: Number(item.Margin ?? item.margin ?? 0),
          freeMargin: Number(item.Marginfree ?? item.free_margin ?? 0),
          profit: Number(item.Profit ?? item.profit ?? 0),
          credit: Number(item.Credit ?? item.credit ?? 0),
          marginLevel: Number(item.Marginlevel ?? item.margin_level ?? 0),
          leverage: item.Leverage,
          isEnable: item.Enable,
          groupName: item.Group_Name,
        });
      }
    } catch (err) {
      console.error(
        `MT5 WS sync: REST fallback poll failed for manager ${managerIndex}:`,
        err.message
      );
    } finally {
      this.restFallbackInFlight.delete(managerIndex);
    }
  }

  // batched DB write + Socket.IO emit, called on FLUSH_MS interval instead
  // of per-message (the "live" feed can fire many times/sec)
  async flush() {
    if (this.pendingAccountIds.size === 0) return;

    const accountIds = [...this.pendingAccountIds];
    this.pendingAccountIds.clear();

    const bulkOps = accountIds
      .map((accountKey) => {
        const live = this.liveCache.get(accountKey);
        if (!live) return null;
        return {
          updateOne: {
            filter: { _id: accountKey },
            update: { $set: { balance: live.balance, equity: live.equity, updatedAt: new Date() } },
          },
        };
      })
      .filter(Boolean);

    if (bulkOps.length > 0) {
      try {
        const result = await Account.bulkWrite(bulkOps, { ordered: false });
        this.stats.writesApplied += (result.modifiedCount || 0) + (result.upsertedCount || 0);
      } catch (err) {
        this.stats.errorCount++;
        console.error("MT5 WS sync: bulkWrite failed -", err.message);
      }
    }

    if (this.io?.emitAccountUpdate) {
      for (const accountKey of accountIds) {
        const entry = this.findAccountEntry(accountKey);
        const live = this.liveCache.get(accountKey);
        if (!entry || !live || !entry.userId) continue;
        this.io.emitAccountUpdate(entry.userId, {
          _id: entry.accountId,
          mt5Account: entry.mt5Account,
          name: entry.name,
          accountType: entry.accountType,
          groupName: live.groupName ?? entry.groupName,
          platform: entry.platform,
          leverage: live.leverage ?? entry.leverage,
          status: entry.status,
          balance: live.balance,
          equity: live.equity,
          margin: live.margin,
          freeMargin: live.freeMargin,
          marginLevel: live.marginLevel,
          profit: live.profit,
          credit: live.credit,
          updatedAt: live.updatedAt,
        });
      }
    }
  }

  findAccountEntry(accountId) {
    for (const managerAccountMap of this.accountsByManager.values()) {
      for (const entry of managerAccountMap.values()) {
        if (entry.accountId.toString() === accountId) return entry;
      }
    }
    return null;
  }

  // Read API for controllers that want this cache directly instead of the
  // DB — mirrors the same-named method on the sibling repo's service.
  // Returns null if the map isn't built yet or the user has no live data.
  getUserAccountsSnapshot(userId) {
    if (!this.isRunning || this.mapBuiltAt === 0) return null;
    userId = userId?.toString();

    const mt5Accounts = this.accountsByUser.get(userId);
    if (!mt5Accounts || mt5Accounts.size === 0) return [];

    const accounts = [];
    let hasLiveData = false;
    for (const managerAccountMap of this.accountsByManager.values()) {
      for (const [mt5Account, entry] of managerAccountMap) {
        if (entry.userId !== userId || !mt5Accounts.has(mt5Account)) continue;
        const live = this.liveCache.get(entry.accountId.toString());
        if (live) hasLiveData = true;
        accounts.push({
          _id: entry.accountId,
          mt5Account: entry.mt5Account,
          name: entry.name,
          accountType: entry.accountType,
          groupName: live?.groupName ?? entry.groupName,
          platform: entry.platform,
          leverage: live?.leverage ?? entry.leverage,
          status: entry.status,
          balance: live?.balance ?? 0,
          equity: live?.equity ?? 0,
          margin: live?.margin ?? 0,
          freeMargin: live?.freeMargin ?? 0,
          marginLevel: live?.marginLevel ?? 0,
          profit: live?.profit ?? 0,
          credit: live?.credit ?? 0,
          updatedAt: live?.updatedAt ?? null,
        });
      }
    }
    return hasLiveData ? accounts : null;
  }

  // ─── account directory (available for a future trade-feed port) ────────

  getManagerIndexes() {
    return [...this.accountsByManager.keys()];
  }

  getAccountEntry(managerIndex, mt5Account) {
    return this.accountsByManager.get(managerIndex)?.get(mt5Account);
  }

  // All of a user's accounts (metadata only, not live balance/equity) in the
  // same {mt5Account, name, accountType, groupName, leverage} shape
  // tradingController.buildProcessedAccount() returns — used by
  // mt5TradeWebSocketService to populate its cache's "accounts" list with
  // every account the user has, not just ones with an open trade right now.
  getUserAccountMetas(userId) {
    userId = userId?.toString();
    const metas = [];
    for (const managerAccountMap of this.accountsByManager.values()) {
      for (const entry of managerAccountMap.values()) {
        if (entry.userId !== userId) continue;
        metas.push({
          mt5Account: entry.mt5Account,
          name: entry.name,
          accountType: entry.accountType,
          groupName: entry.groupName,
          leverage: entry.leverage,
        });
      }
    }
    return metas;
  }

  // ─── status ──────────────────────────────────────────────────────────────

  getSyncStatus() {
    return {
      isRunning: this.isRunning,
      connections: [...this.connections.entries()].map(([managerIndex, conn]) => ({
        managerIndex,
        connected: conn.ws?.readyState === WebSocket.OPEN,
        reconnectAttempts: conn.reconnectAttempts,
      })),
      totalAccounts: this.knownAccountIds.size,
      onlineUsers: this.onlineUserIds.size,
      ...this.stats,
    };
  }
}

module.exports = new Mt5AccountWebSocketService();

// Backend/services/mt5PriceWebSocketService.js
//
// Real-time symbol price (bid/ask) feed for the trade-view chart/price
// panel, driven by ws://socket.infoapi.biz/ws/symbol-prices/ — sibling to
// mt5AccountWebSocketService.js and mt5TradeWebSocketService.js but scoped
// per-symbol instead of per-manager, since prices aren't account-specific.
//
// Subscribe contract (per the infoapi symbol-prices channel):
//   -> { "action": "subscribe", "symbols": ["XAUUSDs", "AUDUSD.s", ...] }
//   <- ticks referencing those symbols as they move.
// Re-sending "subscribe" with the full desired list is how the sibling
// services (accounts/trades) reconcile scope on the same upstream family,
// so that's what this does too: the "symbols" list sent is always the
// complete authoritative set we currently want, not a delta.
//
// Load control (this is the point of the whole service, not an afterthought):
//   - We only ever ask the upstream feed for symbols at least one connected
//     Socket.IO client is *actually looking at* right now (subscribe_prices
//     from the frontend when a chart/price panel mounts for a symbol,
//     unsubscribe_prices when it unmounts or the user switches symbols) —
//     see viewersBySymbol below. Nobody watching XAUUSDs -> we don't ask
//     the feed for XAUUSDs.
//   - Changes are debounced (SUBSCRIBE_DEBOUNCE_MS) so a user flipping
//     through symbols quickly doesn't fire a subscribe message per click.
//   - When the desired symbol set drops to empty (no client viewing any
//     price/chart right now) the upstream connection itself is closed
//     rather than left open idling — reopened lazily the next time someone
//     subscribes.
//   - Ticks are cached in memory and pushed to the frontend on a short
//     flush interval (FLUSH_MS), batched per symbol, instead of relaying
//     every single upstream message straight through Socket.IO.
//   - Each tick is emitted only to the Socket.IO room for that symbol
//     (`price:<symbol>`), never broadcast to every connected client.

const WebSocket = require("ws");
require("dotenv").config();

const WS_URL =
  process.env.MT5_PRICE_WS_URL || "ws://socket.infoapi.biz/ws/symbol-prices/";

const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
// Safety-net reconcile in case a subscribe message was dropped mid-flight —
// harmless to repeat since it's just the same "symbols" list already sent.
const RESUBSCRIBE_MS = 60000;
const FLUSH_MS = 200; // how often batched ticks are pushed to Socket.IO
const SUBSCRIBE_DEBOUNCE_MS = 300; // coalesce rapid subscribe/unsubscribe bursts
const MAX_SYMBOLS_PER_SOCKET = 25; // guards against one client flooding the feed

// Broker symbols look like "XAUUSDs" / "AUDUSD.s" / "BTCUSDs" — letters,
// digits, dot and dash only, and short.
const SYMBOL_RE = /^[A-Za-z0-9._-]{1,20}$/;

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null);

const normalizeSymbols = (input) => {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const out = new Set();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const symbol = value.trim();
    if (!symbol || !SYMBOL_RE.test(symbol)) continue;
    out.add(symbol);
  }
  return [...out];
};

class Mt5PriceWebSocketService {
  constructor() {
    this.io = null;
    this.isRunning = false;

    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.resubscribeTimer = null;
    this.lastMessageAt = 0;
    this.lastError = null;

    // symbol -> Set(socket.id) currently viewing it
    this.viewersBySymbol = new Map();
    // symbols we've last told upstream we want (mirrors viewersBySymbol keys
    // once a debounced subscribe round-trip has actually gone out)
    this.lastSubscribedSymbols = new Set();
    this.subscribeDebounceTimer = null;

    // symbol -> latest { bid, ask, last, time, updatedAt }
    this.liveCache = new Map();
    this.pendingSymbols = new Set();
    this.flushInterval = null;

    this.stats = {
      messagesReceived: 0,
      lastMessageTime: null,
      errorCount: 0,
    };
  }

  // ─── wiring ──────────────────────────────────────────────────────────────

  setSocketServer(io) {
    this.io = io;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.flushInterval = setInterval(() => this.flush(), FLUSH_MS);
    console.log("🔄 MT5 price WebSocket service started (lazy-connect on first viewer)");
    // Pick up symbols a client may have subscribed to before start() ran.
    if (this.desiredSymbols().length > 0) this.connect();
  }

  stop() {
    this.isRunning = false;
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.subscribeDebounceTimer) clearTimeout(this.subscribeDebounceTimer);
    this.disconnect();
    this.viewersBySymbol.clear();
    this.lastSubscribedSymbols.clear();
    console.log("⏹️ MT5 price WebSocket service stopped");
  }

  // ─── viewer tracking (drives what we ask upstream for) ─────────────────

  desiredSymbols() {
    const out = [];
    for (const [symbol, viewers] of this.viewersBySymbol) {
      if (viewers.size > 0) out.push(symbol);
    }
    return out;
  }

  subscribe(socketId, symbols) {
    const wanted = normalizeSymbols(symbols);
    if (!socketId || wanted.length === 0) return [];

    let changed = false;
    for (const symbol of wanted) {
      let viewers = this.viewersBySymbol.get(symbol);
      if (!viewers) {
        viewers = new Set();
        this.viewersBySymbol.set(symbol, viewers);
      }
      if (viewers.size === 0) changed = true;
      viewers.add(socketId);
    }

    if (changed) this.scheduleSubscriptionSync();
    return wanted;
  }

  unsubscribe(socketId, symbols) {
    const drop = normalizeSymbols(symbols);
    if (!socketId || drop.length === 0) return;
    this.removeSocketFromSymbols(socketId, drop);
  }

  // Called on Socket.IO disconnect — a client that goes away shouldn't keep
  // its symbols subscribed upstream on its behalf.
  unsubscribeAll(socketId) {
    if (!socketId) return;
    this.removeSocketFromSymbols(socketId, [...this.viewersBySymbol.keys()]);
  }

  removeSocketFromSymbols(socketId, symbols) {
    let changed = false;
    for (const symbol of symbols) {
      const viewers = this.viewersBySymbol.get(symbol);
      if (!viewers || !viewers.has(socketId)) continue;
      viewers.delete(socketId);
      if (viewers.size === 0) {
        this.viewersBySymbol.delete(symbol);
        this.liveCache.delete(symbol);
        changed = true;
      }
    }
    if (changed) this.scheduleSubscriptionSync();
  }

  // How many symbols one socket is already subscribed to — used to cap
  // per-client subscriptions before adding more.
  viewerSymbolCount(socketId) {
    let count = 0;
    for (const viewers of this.viewersBySymbol.values()) {
      if (viewers.has(socketId)) count++;
    }
    return count;
  }

  maxSymbolsPerSocket() {
    return MAX_SYMBOLS_PER_SOCKET;
  }

  scheduleSubscriptionSync() {
    if (this.subscribeDebounceTimer) clearTimeout(this.subscribeDebounceTimer);
    this.subscribeDebounceTimer = setTimeout(() => {
      this.subscribeDebounceTimer = null;
      this.applySubscriptionChange();
    }, SUBSCRIBE_DEBOUNCE_MS);
  }

  applySubscriptionChange() {
    if (!this.isRunning) return;
    const desired = this.desiredSymbols();

    if (desired.length === 0) {
      // Nobody is watching anything — don't leave a socket idling upstream.
      this.disconnect();
      this.lastSubscribedSymbols.clear();
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect(); // open handler sends the subscribe once connected
      return;
    }

    const desiredSet = new Set(desired);
    const same =
      desiredSet.size === this.lastSubscribedSymbols.size &&
      [...desiredSet].every((s) => this.lastSubscribedSymbols.has(s));
    if (same) return;

    this.sendSubscribe(desired);
  }

  sendSubscribe(symbols) {
    try {
      this.ws.send(JSON.stringify({ action: "subscribe", symbols }));
      this.lastSubscribedSymbols = new Set(symbols);
    } catch (err) {
      console.error("MT5 price WS: failed to send subscribe -", err.message);
    }
  }

  // ─── connection lifecycle ───────────────────────────────────────────────

  connect() {
    if (!this.isRunning) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("MT5 price WS: failed to construct socket -", err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      console.log("✅ MT5 price WS connected");

      const desired = this.desiredSymbols();
      if (desired.length === 0) {
        // Last viewer left while we were connecting — close right back down.
        this.disconnect();
        return;
      }
      this.sendSubscribe(desired);

      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
          console.warn("⚠️ MT5 price WS: stale connection, reconnecting");
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch (_) {}
      }, HEARTBEAT_MS);

      this.resubscribeTimer = setInterval(() => {
        const symbols = this.desiredSymbols();
        if (symbols.length > 0) this.sendSubscribe(symbols);
      }, RESUBSCRIBE_MS);
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      this.stats.messagesReceived++;
      this.stats.lastMessageTime = new Date();
      try {
        this.handleMessage(raw);
      } catch (err) {
        this.stats.errorCount++;
        console.error("MT5 price WS: message handling error -", err.message);
      }
    });

    ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      this.stats.errorCount++;
      this.lastError = err.message;
      console.error("MT5 price WS error:", err.message);
    });

    ws.on("close", () => {
      clearInterval(this.heartbeatTimer);
      clearInterval(this.resubscribeTimer);
      this.heartbeatTimer = null;
      this.resubscribeTimer = null;
      if (this.ws === ws) this.ws = null;

      // Only auto-reconnect if someone still wants live prices — otherwise
      // this was a deliberate disconnect() from the desired set hitting zero.
      if (this.isRunning && this.desiredSymbols().length > 0) {
        console.warn("MT5 price WS closed, reconnecting…");
        this.scheduleReconnect();
      }
    });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer);
    this.heartbeatTimer = null;
    this.resubscribeTimer = null;
    this.reconnectAttempts = 0;

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }

  scheduleReconnect() {
    if (!this.isRunning) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ─── message processing ─────────────────────────────────────────────────

  handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (_) {
      return; // not JSON (e.g. a plain pong frame) — ignore
    }

    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.data)
        ? payload.data
        : payload.data
          ? [payload.data]
          : payload.symbol || payload.Symbol
            ? [payload]
            : [];

    for (const item of items) {
      const symbol = firstDefined(item.symbol, item.Symbol);
      if (!symbol || typeof symbol !== "string") continue;

      // Ignore ticks for symbols nobody's watching anymore (e.g. arrived
      // just after an unsubscribe went out) instead of caching them.
      if (!this.viewersBySymbol.has(symbol)) continue;

      const bid = Number(firstDefined(item.bid, item.Bid));
      const ask = Number(firstDefined(item.ask, item.Ask));
      const last = firstDefined(item.last, item.Last, item.price, item.Price);

      const previous = this.liveCache.get(symbol);
      const changed =
        !previous ||
        previous.bid !== bid ||
        previous.ask !== ask ||
        previous.last !== last;

      this.liveCache.set(symbol, {
        symbol,
        bid: Number.isFinite(bid) ? bid : previous?.bid ?? null,
        ask: Number.isFinite(ask) ? ask : previous?.ask ?? null,
        last: last !== undefined ? Number(last) : previous?.last ?? null,
        time: firstDefined(item.time, item.Time, item.timestamp) ?? null,
        updatedAt: new Date().toISOString(),
      });

      if (changed) this.pendingSymbols.add(symbol);
    }
  }

  // batched Socket.IO emit, called on FLUSH_MS instead of per-tick — and
  // scoped to just the room for that symbol, not a global broadcast.
  flush() {
    if (!this.io || this.pendingSymbols.size === 0) return;

    const symbols = [...this.pendingSymbols];
    this.pendingSymbols.clear();

    for (const symbol of symbols) {
      const tick = this.liveCache.get(symbol);
      if (!tick) continue;
      this.io.to(`price:${symbol}`).emit("price_update", tick);
    }
  }

  // ─── read API ────────────────────────────────────────────────────────────

  getSnapshot(symbol) {
    if (!symbol) return null;
    return this.liveCache.get(symbol) || null;
  }

  getSyncStatus() {
    return {
      isRunning: this.isRunning,
      connected: this.ws?.readyState === WebSocket.OPEN,
      reconnectAttempts: this.reconnectAttempts,
      subscribedSymbols: [...this.lastSubscribedSymbols],
      watchedSymbols: this.desiredSymbols().length,
      lastError: this.lastError,
      ...this.stats,
    };
  }
}

module.exports = new Mt5PriceWebSocketService();

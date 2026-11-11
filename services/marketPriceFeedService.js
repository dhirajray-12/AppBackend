// Backend/services/marketPriceFeedService.js
//
// Real-time symbol price push, replacing the Flutter client's own
// 1s/2s HTTP polling of GET /api/trading/live/chart-data for live ticks
// (see controllers/client/liveTradingController.js::getLiveChartData,
// still used unmodified for the one-time 6h chart-history fetch).
//
// Same "one shared upstream WS connection, subscribe with a JSON message
// naming exactly what we need right now, rebroadcast over our own
// Socket.IO" shape as services/mt5AccountWebSocketService.js (same vendor
// host family — socket.apirun.top) — modelled directly on that file's
// connect/heartbeat/reconnect-backoff structure rather than reinvented.
//
// Upstream contract (confirmed live): connect to
//   ws://socket.apirun.top/ws/mt5/live/
// and send:
//   {
//     "action": "subscribe",
//     "group": "SK GROUP\\M8\\GROUP5",
//     "manager_index": 1,
//     "symbols": ["BTCUSDs", ...]
//   }
// The group is a single fixed value for this feed (GROUP below, not
// resolved per-account/per-viewer - see MARKET_PRICE_GROUP), and the
// request always asks for the full fixed symbol list (SYMBOLS below), not
// just whatever a client happens to be looking at right now: with only one
// group in play there's nothing per-viewer left to scope by, and it means a
// symbol switch on the client is instant (no new subscribe round-trip
// needed).
// The exact shape of the price messages that come back afterward hasn't
// been confirmed against a live capture yet (markets were closed during
// testing), so handleMessage() below parses leniently (several plausible
// field-name variants) and logs the first few raw frames at startup to
// make that easy to tighten up once real traffic has been observed.
//
// Whether the upstream connection is kept open at all is driven by
// Socket.IO room membership: whichever "market:<symbol>" rooms currently
// have at least one client in them determine subscriberCounts below - see
// addSubscriber/removeSubscriber, called from utils/socketServer.js's
// market:subscribe/unsubscribe handlers.
const WebSocket = require("ws");

const WS_URL =
  process.env.MARKET_PRICE_WS_URL || "ws://socket.apirun.top/ws/mt5/live/";

// Manager index is a single deployment-wide default from .env — same
// pattern as CHART_MANAGER_INDEX in liveTradingController.js — rather than
// the per-account value some other endpoints use.
const MANAGER_INDEX = Number.parseInt(process.env.MANAGER_INDEX, 10) || 1;

// Fixed broker group this feed subscribes as - confirmed against the live
// API, not looked up per-account.
const GROUP = process.env.MARKET_PRICE_GROUP || "SK GROUP\\M8\\GROUP5";

// Full symbol list requested from upstream. Comma-separated override via
// MARKET_PRICE_SYMBOLS if the tradable list ever changes without a deploy.
const DEFAULT_SYMBOLS = [
  "ETCUSD.S",
  "ETHUSDs",
  "DSHUSD.S",
  "TRXUSD.S",
  "WTIs",
  "LTCUSD.S",
  "XRPUSD.s",
  "NGAS.s",
  "BTCUSDs",
  "XTI.s",
  "XAUUSDs",
  "XAGUSDs",
  "USDCNH.s",
  "EURUSD.s",
  "XPTUSDs",
];
const SYMBOLS = process.env.MARKET_PRICE_SYMBOLS
  ? process.env.MARKET_PRICE_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SYMBOLS;

const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const RESUBSCRIBE_MS = 30000; // periodic re-send, safety net for a missed subscribe ack
const RAW_LOG_SAMPLE_COUNT = 5; // log the first few raw frames only, not the whole firehose

class MarketPriceFeedService {
  constructor() {
    this.io = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.resubscribeTimer = null;
    this.lastMessageAt = 0;
    this.rawLogCount = 0;

    // symbol (string) -> subscriber count (how many Socket.IO clients are
    // currently in that symbol's room) — only the keys with count > 0 are
    // sent to the upstream feed's subscribe message.
    this.subscriberCounts = new Map();

    this.stats = {
      status: "idle",
      lastMessageTime: null,
      messagesReceived: 0,
      errorCount: 0,
    };
  }

  setSocketServer(io) {
    this.io = io;
  }

  getSyncStatus() {
    return {
      ...this.stats,
      managerIndex: MANAGER_INDEX,
      group: GROUP,
      subscribedSymbols: [...this.subscriberCounts.keys()],
    };
  }

  start() {
    if (this.ws) return;
    this.connect();
  }

  stop() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.resubscribeTimer);
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch (_) {}
    this.ws = null;
  }

  // ─── symbol subscription (driven by Socket.IO room membership) ─────────

  addSubscriber(symbol) {
    if (!symbol) return;
    const count = this.subscriberCounts.get(symbol) || 0;
    this.subscriberCounts.set(symbol, count + 1);
    if (count === 0) this.sendSubscribe();
  }

  removeSubscriber(symbol) {
    if (!symbol || !this.subscriberCounts.has(symbol)) return;
    const count = this.subscriberCounts.get(symbol) - 1;
    if (count <= 0) {
      this.subscriberCounts.delete(symbol);
      // No explicit "unsubscribe" message is sent — re-sending the full
      // current symbol list on the next subscribe is simpler and the
      // upstream feed only sees a shrinking list either way.
    } else {
      this.subscriberCounts.set(symbol, count);
    }
  }

  sendSubscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // connect()'s "open" handler subscribes once it's up
    if (this.subscriberCounts.size === 0) return;
    try {
      this.ws.send(
        JSON.stringify({
          action: "subscribe",
          group: GROUP,
          manager_index: MANAGER_INDEX,
          symbols: SYMBOLS,
        }),
      );
    } catch (err) {
      console.error("Market price feed: failed to send subscribe -", err.message);
    }
  }

  // ─── connection lifecycle ────────────────────────────────────────────────

  connect() {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("Market price feed: failed to construct socket -", err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.stats.status = "connecting";

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.stats.status = "connected";
      console.log(`✅ Market price feed connected (${WS_URL})`);

      this.sendSubscribe();

      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
          console.warn("⚠️ Market price feed: stale connection, reconnecting");
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch (_) {}
      }, HEARTBEAT_MS);

      // Periodic re-subscribe — safety net in case the upstream feed ever
      // drops a symbol from its own subscription list without telling us.
      this.resubscribeTimer = setInterval(() => {
        try {
          this.sendSubscribe();
        } catch (_) {}
      }, RESUBSCRIBE_MS);
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      this.stats.messagesReceived++;
      this.stats.lastMessageTime = new Date();

      if (this.rawLogCount < RAW_LOG_SAMPLE_COUNT) {
        this.rawLogCount++;
        console.log(`Market price feed raw sample #${this.rawLogCount}:`, raw.toString());
      }

      try {
        this.handleMessage(raw);
      } catch (err) {
        this.stats.errorCount++;
        console.error("Market price feed: message handling error -", err.message);
      }
    });

    ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      this.stats.errorCount++;
      console.error("Market price feed error:", err.message);
    });

    ws.on("close", () => {
      this.stats.status = "disconnected";
      clearInterval(this.heartbeatTimer);
      clearInterval(this.resubscribeTimer);
      this.ws = null;
      console.warn("Market price feed closed, reconnecting…");
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ─── message processing ─────────────────────────────────────────────────

  // Accepts whichever of these shapes the upstream feed actually sends —
  // a bare tick object, a {type, data} envelope (same convention the
  // sibling MT5 feed uses), or an array of either. Each recognized tick
  // is normalized into the SAME field shape the chart-data bridge already
  // returns (bid/ask/time) and re-emitted to "market:<symbol>" — so the
  // Flutter client's existing normalizeTicks() (utils/live_candles.dart)
  // parses it completely unchanged, with zero client-side branching
  // between the REST history fetch and this live feed.
  handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (_) {
      return; // not JSON (e.g. a plain-text ack) — nothing to do with it
    }

    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : payload?.data && typeof payload.data === "object"
          ? [payload.data]
          : [payload];

    for (const item of items) {
      const tick = this.normalizeIncomingTick(item);
      if (!tick) continue;

      const io = this.io;
      if (!io) continue;
      io.to(`market:${tick.symbol}`).emit("market:tick", {
        symbol: tick.symbol,
        ticks: [{ bid: tick.bid, ask: tick.ask, time: tick.time }],
      });
    }
  }

  normalizeIncomingTick(item) {
    if (!item || typeof item !== "object") return null;
    const symbol = item.symbol || item.Symbol || item.s;
    if (!symbol || !this.subscriberCounts.has(symbol)) return null; // ignore anything nobody asked for

    const bid = toNumber(item.bid ?? item.Bid ?? item.b);
    const ask = toNumber(item.ask ?? item.Ask ?? item.a);
    const last = toNumber(item.last ?? item.price ?? item.Last ?? item.p);
    if (bid === undefined && ask === undefined && last === undefined) return null;

    const time =
      toEpochSeconds(item.time) ??
      toEpochSeconds(item.timestamp) ??
      toEpochSeconds(item.t) ??
      Math.floor(Date.now() / 1000);

    return {
      symbol,
      bid: bid ?? last,
      ask: ask ?? last,
      time,
    };
  }
}

const toNumber = (value) => {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Accepts an epoch already in seconds, an epoch in milliseconds (13
// digits), or an ISO/parseable date string.
const toEpochSeconds = (value) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toEpochSeconds(asNumber);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
};

module.exports = new MarketPriceFeedService();

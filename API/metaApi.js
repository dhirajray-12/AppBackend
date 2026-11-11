// Backend/API/metaApi.js
const axios = require("axios");
const http = require("http");
const https = require("https");

// ✅ Without keep-alive, every call to these bridges pays a fresh TCP
// handshake (+ TLS negotiation, since both hosts are https) even though
// they're hit constantly against the same host — this is the single
// biggest fixed cost on the live-trading path (chart ticks, place/close
// order) since it's paid on every request in addition to the broker's own
// processing time. Reusing sockets cuts that connection overhead out
// entirely. Set explicitly here (not just via index.js's global
// axios.defaults) so these two clients keep it even if required before
// that global default is set, or from a script that never loads index.js.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const metaApi = axios.create({
  baseURL: process.env.MT5_API_URL,
  headers: {
    "x-api-key": process.env.MT5_API_KEY,
  },
  httpAgent,
  httpsAgent,
});

// Trade-action bridge (place/close/update order, get-open-trade, etc.) — a
// separate host from MT5_API_URL, documented in the "metatraderapp share"
// Postman collection. Every call there also expects an X-MANAGER-ID header
// naming which manager the target MT5 account lives under (in addition to
// Manager_Index in the body), so that header is set per-call rather than
// fixed here — see liveTradingController.js.
const tradeActionApi = axios.create({
  baseURL: process.env.TRADE_ACTION_API_URL,
  headers: {
    "X-API-KEY": process.env.MT5_API_KEY,
  },
  httpAgent,
  httpsAgent,
});

module.exports = { metaApi, tradeActionApi };

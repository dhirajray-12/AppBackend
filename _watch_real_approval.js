// Read-only observation: connect to the REAL production socket server as the
// exact client user under test, and log every frame we receive, so we can
// independently confirm whether deposit_updated actually reaches this user's
// room during a real admin approval. No mutations.
require("dotenv").config();
const fs = require("fs");
const { io } = require("C:/Site/AegonFrontend/node_modules/socket.io-client");

const token = fs.readFileSync(
  "C:/Users/ADMINI~1/AppData/Local/Temp/2/claude/c--Site-New-Demo-CRM/7bf60bb6-2679-4643-b342-857d13c39e27/scratchpad/real_client_token.txt",
  "utf8",
).trim();
const USER_ID = "69fb0f77545f39349cc6ce93";

const client = io("https://nserver.testcrm.co.in", {
  auth: { token: `Bearer ${token}` },
  query: { userId: USER_ID, activeRole: "client" },
  transports: ["websocket"],
  extraHeaders: { Origin: "https://dcrm.testcrm.co.in" },
  reconnection: true,
});

client.on("connect", () => {
  console.log(new Date().toISOString(), "CONNECTED as client", USER_ID, "socket.id =", client.id);
});

client.on("connect_error", (err) => {
  console.log(new Date().toISOString(), "CONNECT_ERROR:", err.message);
});

client.onAny((event, ...args) => {
  console.log(new Date().toISOString(), `EVENT [${event}]`, JSON.stringify(args).slice(0, 400));
});

console.log("Listening for", process.argv[2] || "180", "seconds as this exact client user...");
setTimeout(() => {
  client.disconnect();
  process.exit(0);
}, (Number(process.argv[2]) || 180) * 1000);

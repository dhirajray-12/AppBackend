class CacheService {
  constructor() {
    this.isConnected = true;
    this.store = new Map();
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredEntries(),
      60 * 1000,
    );

    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  async connect() {
    return true;
  }

  generateKey(prefix, params = {}) {
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        if (params[key] !== undefined) acc[key] = params[key];
        return acc;
      }, {});
    const hash = require("crypto")
      .createHash("md5")
      .update(JSON.stringify(sortedParams))
      .digest("hex");
    return `${prefix}:${hash}`;
  }

  cleanupExpiredEntries() {
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  async get(key) {
    if (typeof key !== "string") {
      return null;
    }

    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key, data, ttl = 60) {
    if (typeof key !== "string") {
      return true;
    }

    const ttlSeconds = Number(ttl);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      this.store.delete(key);
      return true;
    }

    this.store.set(key, {
      value: data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return true;
  }

  // Returns [{ key, value }] for every live (non-expired) entry whose key
  // starts with `prefix`. Used by aggregation endpoints (e.g. the admin
  // risk-exposure dashboard) that need to fan out across all per-user cache
  // entries a background sync service wrote — get()/set() alone can't do
  // that since they only address one key at a time.
  entriesWithPrefix(prefix) {
    if (typeof prefix !== "string" || !prefix) {
      return [];
    }

    const now = Date.now();
    const entries = [];

    for (const [key, entry] of this.store.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (!entry || entry.expiresAt <= now) continue;
      entries.push({ key, value: entry.value });
    }

    return entries;
  }

  async deletePattern(pattern) {
    if (typeof pattern !== "string") {
      return;
    }

    if (!pattern.includes("*")) {
      this.store.delete(pattern);
      return;
    }

    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escapedPattern.replace(/\\\*/g, ".*")}$`);

    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
      }
    }
  }
}

module.exports = new CacheService();

const crypto = require("crypto");
const getHeaderValue = (value) => {
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return value || "";
};

const getClientIpAddress = (req) => {
  const forwardedFor = getHeaderValue(req.headers["x-forwarded-for"]);
  const realIp = getHeaderValue(req.headers["x-real-ip"]);
  const vercelIp = getHeaderValue(req.headers["x-vercel-forwarded-for"]);
  const candidate =
    forwardedFor.split(",")[0]?.trim() ||
    realIp ||
    vercelIp ||
    req.ip ||
    req.socket?.remoteAddress ||
    "";

  return candidate.replace("::ffff:", "");
};

const getIpLocationFromRequest = (req) => {
  const city = getHeaderValue(req.headers["x-vercel-ip-city"]);
  const region =
    getHeaderValue(req.headers["x-vercel-ip-country-region"]) ||
    getHeaderValue(req.headers["x-appengine-region"]);
  const country =
    getHeaderValue(req.headers["x-vercel-ip-country"]) ||
    getHeaderValue(req.headers["cf-ipcountry"]);

  const label = [city, region, country].filter(Boolean).join(", ") || "Unknown";

  return {
    city,
    region,
    country,
    label,
    source: "ip",
  };
};

const getExplicitCoordinates = (req) => {
  const locationContext = req.body?.locationContext;

  if (
    locationContext?.permission === "granted" &&
    typeof locationContext?.latitude === "number" &&
    typeof locationContext?.longitude === "number"
  ) {
    return {
      latitude: locationContext.latitude,
      longitude: locationContext.longitude,
      accuracy:
        typeof locationContext.accuracy === "number"
          ? locationContext.accuracy
          : null,
    };
  }

  return null;
};

const getLocationFromRequest = async (req) => {
  const coordinates = getExplicitCoordinates(req);

  if (coordinates) {
    return {
      city: "",
      region: "",
      country: "",
      label: `${coordinates.latitude}, ${coordinates.longitude}`,
      source: "gps",
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      accuracy: coordinates.accuracy,
    };
  }

  return getIpLocationFromRequest(req);
};

const detectDeviceType = (userAgent) => {
  if (!userAgent) return "unknown";

  if (/bot|crawler|spider/i.test(userAgent)) return "bot";
  if (/tablet|ipad/i.test(userAgent)) return "tablet";
  if (/mobile|android|iphone/i.test(userAgent)) return "mobile";
  if (/windows|macintosh|linux|x11/i.test(userAgent)) return "desktop";

  return "unknown";
};

const detectBrowser = (userAgent) => {
  if (!userAgent) return "Unknown browser";
  if (/edg/i.test(userAgent)) return "Edge";
  if (/opr|opera/i.test(userAgent)) return "Opera";
  if (/chrome/i.test(userAgent) && !/edg|opr|opera/i.test(userAgent)) {
    return "Chrome";
  }
  if (/safari/i.test(userAgent) && !/chrome|chromium|edg|opr|opera/i.test(userAgent)) {
    return "Safari";
  }
  if (/firefox/i.test(userAgent)) return "Firefox";

  return "Unknown browser";
};

const detectOperatingSystem = (userAgent) => {
  if (!userAgent) return "Unknown OS";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/android/i.test(userAgent)) return "Android";
  if (/iphone|ipad|ios/i.test(userAgent)) return "iOS";
  if (/macintosh|mac os x/i.test(userAgent)) return "macOS";
  if (/linux/i.test(userAgent)) return "Linux";

  return "Unknown OS";
};

const getDeviceMetadataFromRequest = async (req) => {
  const userAgent = getHeaderValue(req.headers["user-agent"]);
  const browser = detectBrowser(userAgent);
  const os = detectOperatingSystem(userAgent);
  const deviceType = detectDeviceType(userAgent);
  const explicitName = getHeaderValue(req.headers["x-device-name"]).trim();
  const deviceName =
    explicitName || [os, browser].filter(Boolean).join(" • ") || "Unknown device";

  return {
    deviceName,
    deviceType,
    browser,
    os,
    userAgent,
    ipAddress: getClientIpAddress(req),
    location: await getLocationFromRequest(req),
  };
};

const getDeviceIdFromRequest = (req) => {
  const headerDeviceId = getHeaderValue(req.headers["x-device-id"]).trim();
  const bodyDeviceId =
    typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";

  return headerDeviceId || bodyDeviceId || "";
};

const ensureDeviceId = (req) => {
  const deviceId = getDeviceIdFromRequest(req);
  return deviceId || crypto.randomUUID();
};

const shouldUpdateLastActive = (lastActiveAt) => {
  if (!lastActiveAt) return true;
  return Date.now() - new Date(lastActiveAt).getTime() > 60 * 1000;
};

module.exports = {
  ensureDeviceId,
  getClientIpAddress,
  getDeviceIdFromRequest,
  getDeviceMetadataFromRequest,
  shouldUpdateLastActive,
};

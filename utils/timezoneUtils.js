/**
 * CRM-wide timezone conversion utilities.
 *
 * Dates are always stored in MongoDB as UTC `Date`s and all business logic
 * (filtering, sorting, day-boundary math, etc.) keeps operating on those raw
 * UTC values exactly as before. This module only affects the *strings* sent
 * to clients: it re-expresses a UTC instant using the superadmin-configured
 * timezone's offset, so the underlying instant in time never changes.
 */
const cacheService = require("../services/cacheService");
const AppSetting = require("../models/AppSetting");

const DEFAULT_TIMEZONE = "UTC";
const TIMEZONE_CACHE_KEY = "appSettings:timezone";
const TIMEZONE_CACHE_TTL = 15; // seconds — matches suspensionService's access-payload TTL

// Matches exactly what Date.prototype.toJSON() / Mongoose Date serialization produces.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let validTimezoneSet = null;
const getValidTimezoneSet = () => {
  if (!validTimezoneSet) {
    try {
      validTimezoneSet = new Set(Intl.supportedValuesOf("timeZone"));
    } catch (err) {
      // Extremely old/limited ICU builds may not support this — fail open
      // rather than block every timezone value.
      validTimezoneSet = null;
    }
  }
  return validTimezoneSet;
};

const isValidTimezone = (timezone) => {
  if (!timezone || typeof timezone !== "string") return false;
  const known = getValidTimezoneSet();
  if (known) return known.has(timezone);

  try {
    // Fallback validation: constructing a formatter throws on an invalid zone.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
};

/**
 * Reads the superadmin-configured timezone, cached briefly so this can be
 * called cheaply on every request (including unauthenticated ones, unlike
 * suspensionService's access-payload cache which only primes on the auth path).
 */
const getConfiguredTimezone = async () => {
  const cached = await cacheService.get(TIMEZONE_CACHE_KEY);
  if (cached) return cached;

  const settings = await AppSetting.findOne().select("timezone").lean();
  const timezone = settings?.timezone && isValidTimezone(settings.timezone)
    ? settings.timezone
    : DEFAULT_TIMEZONE;

  await cacheService.set(TIMEZONE_CACHE_KEY, timezone, TIMEZONE_CACHE_TTL);
  return timezone;
};

/**
 * Call after the superadmin changes the timezone so the next read picks up
 * the new value immediately instead of waiting out the TTL.
 */
const invalidateConfiguredTimezoneCache = async () => {
  await cacheService.deletePattern(TIMEZONE_CACHE_KEY);
};

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Re-expresses a UTC ISO-8601 instant string as the same instant with the
 * target timezone's offset, e.g. "2026-08-20T10:15:30.123Z" + "Asia/Kolkata"
 * -> "2026-08-20T15:45:30.123+05:30". Still a valid, parseable timestamp
 * representing the exact same moment.
 */
const convertIsoToTz = (isoString, timezone) => {
  if (!timezone || timezone === "UTC") return isoString;

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;

  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
  } catch (err) {
    return isoString;
  }

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const localAsUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );

  let offsetMinutes = Math.round((localAsUtc - date.getTime()) / 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  offsetMinutes = Math.abs(offsetMinutes);
  const offsetStr = `${sign}${pad2(Math.floor(offsetMinutes / 60))}:${pad2(offsetMinutes % 60)}`;

  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}:${get("second")}.${ms}${offsetStr}`;
};

/**
 * Human-readable date/time for exports (PDF/Excel/docx), formatted in the
 * configured timezone instead of the previous hardcoded en-US/server-local time.
 */
const formatDateForDisplay = (date, timezone = DEFAULT_TIMEZONE, opts = {}) => {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || DEFAULT_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      ...opts,
    }).format(d);
  } catch (err) {
    return d.toLocaleString("en-US", opts);
  }
};

module.exports = {
  DEFAULT_TIMEZONE,
  ISO_DATE_REGEX,
  isValidTimezone,
  getConfiguredTimezone,
  invalidateConfiguredTimezoneCache,
  convertIsoToTz,
  formatDateForDisplay,
};

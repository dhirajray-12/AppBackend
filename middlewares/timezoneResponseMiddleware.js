
const {
  ISO_DATE_REGEX,
  getConfiguredTimezone,
  convertIsoToTz,
} = require("../utils/timezoneUtils");

const timezoneResponseMiddleware = async (req, res, next) => {
  // Resolved once up front (usually served from the 15s cache in
  // getConfiguredTimezone, so this rarely costs a real DB round trip) so
  // res.json itself stays synchronous, matching what the rest of the app expects.
  let timezone = "UTC";
  try {
    timezone = await getConfiguredTimezone();
  } catch (err) {
    timezone = "UTC";
  }

  if (timezone && timezone !== "UTC") {
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      if (body === undefined || body === null) {
        return originalJson(body);
      }

      const rewritten = JSON.stringify(body, (key, value) => {
        if (typeof value === "string" && ISO_DATE_REGEX.test(value)) {
          return convertIsoToTz(value, timezone);
        }
        return value;
      });

      res.set("Content-Type", "application/json; charset=utf-8");
      return res.send(rewritten);
    };
  }

  next();
};

module.exports = timezoneResponseMiddleware;

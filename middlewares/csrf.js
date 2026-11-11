// Backend\middlewares\csrf.js
// Double-submit-cookie CSRF protection: a non-httpOnly cookie holds a random
// token, and every state-changing request must echo it back in a header.
// A cross-site attacker can make the browser send the cookie automatically,
// but (thanks to same-origin policy) can't read the cookie to put it in the
// header, so a forged request fails the comparison.
const crypto = require("crypto");

const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";

// Public auth entry points that run before any session cookie exists yet -
// there's no authenticated state for a forged cross-site request to abuse.
const EXEMPT_PATHS = [
  "/api/auth/signup",
  "/api/auth/resend-verification",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/login",
  "/api/auth/google",
  "/api/auth/refresh",
  "/api/auth/check-role",
  "/api/auth/check-verification-status",
];

const getCsrfCookieOptions = () => ({
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  // The double-submit pattern requires the frontend to read this cookie via
  // document.cookie. Without an explicit Domain, the cookie is scoped to the
  // exact API host, which the browser still attaches to requests but which
  // frontend JS on a different subdomain (e.g. dcrm.testcrm.co.in calling
  // nserver.testcrm.co.in) can never read. Scope it to the shared parent
  // domain so both subdomains see it.
  ...(process.env.CSRF_COOKIE_DOMAIN
    ? { domain: process.env.CSRF_COOKIE_DOMAIN }
    : {}),
  maxAge: 24 * 60 * 60 * 1000,
});

exports.CSRF_COOKIE_NAME = CSRF_COOKIE_NAME;
exports.CSRF_HEADER_NAME = CSRF_HEADER_NAME;

exports.ensureCsrfCookie = (req, res, next) => {
  if (!req.cookies[CSRF_COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE_NAME, token, getCsrfCookieOptions());
    req.cookies[CSRF_COOKIE_NAME] = token;
  }

  // Browsers sent before CSRF_COOKIE_DOMAIN was introduced may still be
  // carrying a host-only cookie (no Domain attribute) alongside the new
  // domain-scoped one - a different cookie by browser identity despite the
  // same name, since Domain is part of what makes a cookie unique. Both get
  // sent on requests to the API host, and cookie-parser only keeps one, so
  // clear the legacy one to avoid a stale value winning.
  if (process.env.CSRF_COOKIE_DOMAIN) {
    res.cookie(CSRF_COOKIE_NAME, "", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      expires: new Date(0),
    });
  }

  next();
};

exports.verifyCsrfToken = (req, res, next) => {
  const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  // Server-to-server calls authenticate with a shared secret, not an
  // ambient browser cookie, so there's no CSRF surface to protect here.
  if (
    req.headers["x-api-key"] &&
    req.headers["x-api-key"] === process.env.INTERNAL_API_KEY
  ) {
    return next();
  }

  if (EXEMPT_PATHS.includes(req.path)) {
    return next();
  }

  const cookieToken = req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({
      success: false,
      message: "Invalid or missing CSRF token",
    });
  }

  next();
};

// backend/controllers/authController.js - ULTRA FAST VERSION
const crypto = require("crypto");
const User = require("../models/User");
const DeviceSession = require("../models/DeviceSession");
const IBClientConfiguration = require("../models/client/IBClientConfiguration");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require("../services/emailService");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const { signupSchema } = require("../Validator/Auth.validate");
const {
  asyncHandler,
  ValidationError,
  AuthenticationError,
  ConflictError,
  AuthorizationError,
} = require("../middlewares/errorHandler");
const logger = require("../utils/logger");
const cacheService = require("../services/cacheService");
const {
  ensureDeviceId,
  getDeviceMetadataFromRequest,
} = require("../utils/deviceSessionUtils");
const { getBlockedDeviceRecord } = require("../services/deviceSessionService");
const { buildAccessPayload } = require("../services/suspensionService");
const { OAuth2Client } = require("google-auth-library");

// Cache keys
const CACHE_KEYS = {
  USER_BY_EMAIL: (email) => `auth:user:email:${email.toLowerCase()}`,
  USER_BY_EMAIL_AUTH: (email) => `auth:user:email:auth:${email.toLowerCase()}`,
  USER_BY_ID: (id) => `auth:user:id:${id}`,
  VERIFICATION_STATUS: (email) => `auth:verified:${email.toLowerCase()}`,
  USER_ROLE: (email) => `auth:role:${email.toLowerCase()}`,
  REFERRAL_CODE: (code) => `auth:referral:${code}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_BY_EMAIL: 300, // 5 minutes
  USER_BY_ID: 300, // 5 minutes
  VERIFICATION_STATUS: 60, // 1 minute
  USER_ROLE: 300, // 5 minutes
  REFERRAL_CODE: 3600, // 1 hour
};

const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const USER_ROLES = ["client", "admin", "superadmin", "agent", "subadmin"];

const getAccessCookieName = (role) => `auth_token_${role}`;
const getRefreshCookieName = (role) => `refresh_token_${role}`;

const getCookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: `${process.env.NODE_ENV === "production" ? "none" : "lax"}`,
  maxAge,
});

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const getRefreshExpiryDate = () =>
  new Date(Date.now() + REFRESH_COOKIE_MAX_AGE);

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

// GOOGLE_CLIENT_ID may be a single id or a comma-separated list (Google
// issues a distinct OAuth client id per platform — Android, iOS, Web —
// and the mobile app's own idToken's `aud` claim will match whichever one
// it was signed for). verifyIdToken accepts an array as `audience`.
const googleAudiences = () =>
  String(config.GOOGLE_CLIENT_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const googleOAuthClient = new OAuth2Client();

// Verifies a Google ID token's signature, expiry and audience server-side
// (never trust a client-supplied "this is a verified Google user" claim
// without this) and returns its payload. Throws on anything invalid —
// callers convert that into a 401, not a 500.
const verifyGoogleIdToken = async (idToken) => {
  const audiences = googleAudiences();
  const ticket = await googleOAuthClient.verifyIdToken({
    idToken,
    audience: audiences,
  });
  return ticket.getPayload();
};

// A real Google ID token payload normally carries given_name/family_name
// (and always a combined `name`) whenever the `profile` scope was granted
// — which the app's own GoogleSignIn(scopes: ['email','profile']) call
// always requests — so this should be the real name in the overwhelming
// majority of cases. `name` is split defensively (same approach the
// Flutter client's own User.fromJson uses for other endpoints) only for
// the rare case where given_name/family_name are absent but a combined
// name is present. "Google"/"User" is the absolute last resort — it
// should realistically never trigger, but a literal placeholder that's
// obviously wrong beats an empty name field, and the account-linking path
// above recognizes and repairs it later if a subsequent sign-in does
// supply a real name.
const deriveNameFromGooglePayload = (payload) => {
  if (payload.given_name || payload.family_name) {
    return {
      firstName: payload.given_name || "Google",
      lastName: payload.family_name || "User",
    };
  }
  const fullName = String(payload.name || "").trim();
  if (fullName) {
    const parts = fullName.split(/\s+/);
    return {
      firstName: parts[0],
      lastName: parts.length > 1 ? parts.slice(1).join(" ") : "",
    };
  }
  return { firstName: "Google", lastName: "User" };
};

// Generate JWT token (synchronous for speed)
const generateToken = (id, role, sessionData = {}) => {
  return jwt.sign(
    { userId: id, Role: role, ...sessionData },
    config.JWT_SECRET,
    {
      expiresIn: config.JWT_EXPIRE,
    },
  );
};

const generateRefreshToken = (id, role, sessionData = {}) => {
  return jwt.sign(
    { userId: id, Role: role, type: "refresh", ...sessionData },
    config.JWT_REFRESH_SECRET,
    {
      expiresIn: config.JWT_REFRESH_EXPIRE,
    },
  );
};

const setAuthCookies = (res, role, accessToken, refreshTokenValue) => {
  res.cookie(
    getAccessCookieName(role),
    accessToken,
    getCookieOptions(ACCESS_COOKIE_MAX_AGE),
  );

  if (refreshTokenValue) {
    res.cookie(
      getRefreshCookieName(role),
      refreshTokenValue,
      getCookieOptions(REFRESH_COOKIE_MAX_AGE),
    );
  }
};

const clearAuthCookies = (res, role) => {
  const expiredCookieOptions = {
    ...getCookieOptions(0),
    expires: new Date(0),
  };

  res.cookie(getAccessCookieName(role), "", expiredCookieOptions);
  res.cookie(getRefreshCookieName(role), "", expiredCookieOptions);
};

const findRefreshCookie = (req) => {
  const activeRoleHeader = req.headers["x-active-role"];
  const activeRole = Array.isArray(activeRoleHeader)
    ? activeRoleHeader[0]
    : activeRoleHeader;

  if (activeRole && USER_ROLES.includes(activeRole)) {
    const refreshTokenValue = req.cookies[getRefreshCookieName(activeRole)];
    if (refreshTokenValue) {
      return { role: activeRole, refreshTokenValue };
    }
  }

  for (const role of USER_ROLES) {
    const refreshTokenValue = req.cookies[getRefreshCookieName(role)];
    if (refreshTokenValue) {
      return { role, refreshTokenValue };
    }
  }

  return null;
};

// Helper to get user with caching
const getUserByEmailCached = async (email, selectPassword = false) => {
  const normalizedEmail = normalizeEmail(email);

  if (selectPassword) {
    return User.findOne({ email: normalizedEmail }).select("+password").lean();
  }

  const cacheKey = CACHE_KEYS.USER_BY_EMAIL(normalizedEmail);

  let user = await cacheService.get(cacheKey);
  if (user) {
    return user;
  }

  user = await User.findOne({ email: normalizedEmail }).lean();

  if (user) {
    await cacheService.set(cacheKey, user, CACHE_TTL.USER_BY_EMAIL);
  }

  return user;
};

// Helper to invalidate user caches
const invalidateUserCaches = async (email, userId) => {
  const normalizedEmail = normalizeEmail(email);
  const patterns = [
    CACHE_KEYS.USER_BY_EMAIL(normalizedEmail),
    CACHE_KEYS.USER_BY_EMAIL_AUTH(normalizedEmail),
    CACHE_KEYS.USER_BY_ID(userId),
    CACHE_KEYS.VERIFICATION_STATUS(normalizedEmail),
    CACHE_KEYS.USER_ROLE(normalizedEmail),
  ];

  await Promise.all(
    patterns.map((pattern) => cacheService.deletePattern(pattern)),
  );
};

// @desc    Register a new user
// @route   POST /api/auth/signup
// @access  Public
exports.signup = asyncHandler(async (req, res) => {
  // Validation
  const result = signupSchema.safeParse(req.body);
  if (!result.success) {
    console.error(
      "Signup validation failed:",
      result.error.flatten().fieldErrors,
    );
    throw new ValidationError(
      "Validation failed",
      result.error.flatten().fieldErrors,
    );
  }

  const data = result.data;

  const {
    firstName,
    lastName,
    email,
    password,
    country,
    phone,
    dateofbirth,
    referralCode,
    zipCode,
    state,
  } = data;
  const normalizedEmail = normalizeEmail(email);

  // Check if user already exists (using cache)
  const existingUser = await getUserByEmailCached(normalizedEmail);
  if (existingUser) {
    throw new ConflictError("User with this email already exists");
  }

  // Validate referral code if provided (cached)
  let validReferral = null;
  let referringIBConfig = null;

  if (referralCode) {
    const cacheKey = CACHE_KEYS.REFERRAL_CODE(referralCode);
    let ibConfiguration = await cacheService.get(cacheKey);

    if (!ibConfiguration) {
      ibConfiguration = await IBClientConfiguration.findOne({
        referralCode,
        status: "active",
      }).lean();

      if (ibConfiguration) {
        await cacheService.set(
          cacheKey,
          ibConfiguration,
          CACHE_TTL.REFERRAL_CODE,
        );
      }
    }

    if (!ibConfiguration) {
      throw new ValidationError("Invalid or inactive referral code");
    }

    validReferral = referralCode;
    referringIBConfig = ibConfiguration;
  }

  // Create new user
  const user = new User({
    firstName,
    lastName,
    email: normalizedEmail,
    password,
    country: {
      name: country,
      state: state || "",
    },
    phone,
    zipCode: zipCode || "",
    state: state || "",
    dateofbirth: new Date(dateofbirth),
    role: "client",
    referredBy: validReferral,
  });

  // Generate verification token
  const verificationToken = user.generateEmailVerificationToken();

  // Send verification email (fire and forget - non-blocking)
  sendVerificationEmail(user, verificationToken).catch((err) => {
    logger.error("Failed to send verification email:", {
      error: err.message,
      userId: user._id,
      email: user.email,
    });
  });

  await user.save();

  // Auto-create IB configuration if user signed up through referral
  if (validReferral && referringIBConfig) {
    IBClientConfiguration.create({
      userId: user._id,
      referralCode: null,
      parent: referringIBConfig._id,
      level: referringIBConfig.level + 1,
      status: "pending",
      referredBy: validReferral,
    }).catch((ibError) => {
      logger.error("Error creating IB configuration during signup:", {
        error: ibError.message,
        userId: user._id,
      });
    });
  }

  // Invalidate caches
  await invalidateUserCaches(normalizedEmail, user._id);

  res.status(201).json({
    success: true,
    message:
      "Registration successful! Please check your email to verify your account.",
    data: {
      hasReferral: !!validReferral,
      referralCode: validReferral,
    },
  });
});

// Shared by `login` and `google` (and nothing else) — everything past
// "credentials/token are valid, this really is `user`" is identical
// regardless of how that was established: suspension/blocked-device
// checks, device-session bookkeeping, JWT issuance, cookies, and the
// response shape. Pulled out so Google sign-in gets the exact same
// security checks (blocked-device, suspension) a password login gets,
// instead of a second, easily-drifting copy of this logic.
const establishSessionAndRespond = async (
  req,
  res,
  user,
  { loginType, successMessage } = {},
) => {
  const deviceId = ensureDeviceId(req);
  const [accessPayload, blockedDevice, existingDeviceRecord] =
    await Promise.all([
      buildAccessPayload({
        io: req.app.get("io"),
      }),
      getBlockedDeviceRecord(user._id, deviceId),
      DeviceSession.findOne({
        user: user._id,
        deviceId,
      })
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

  if (loginType !== "superadmin" && accessPayload.currentState.isSuspended) {
    const message =
      loginType === "admin" || loginType === "agent" || loginType === "subadmin"
        ? accessPayload.currentState.adminMessage
        : accessPayload.currentState.maintenanceMessage;

    res.status(423).json({
      success: false,
      message,
      suspension: accessPayload.currentState,
    });
    return;
  }

  if (blockedDevice) {
    throw new AuthorizationError(
      "This device has been blocked. An administrator must mark it safe before it can log in again.",
    );
  }

  const sessionId = crypto.randomUUID();
  const deviceMetadata = await getDeviceMetadataFromRequest(req);

  // Create tokens
  const token = generateToken(user._id, user.role, { sessionId, deviceId });
  const refreshTokenValue = generateRefreshToken(user._id, user.role, {
    sessionId,
    deviceId,
  });

  const refreshTokenHash = hashToken(refreshTokenValue);
  const refreshTokenExpires = getRefreshExpiryDate();

  const deviceSessionPayload = {
    role: user.role,
    sessionId,
    refreshTokenHash,
    refreshTokenExpires,
    isTrusted: existingDeviceRecord?.isTrusted || false,
    ...deviceMetadata,
    status: "active",
    loggedInAt: new Date(),
    lastActiveAt: new Date(),
    isBlocked: false,
    blockedAt: null,
    blockedBy: null,
    forcedLogoutAt: null,
    forcedLogoutBy: null,
  };

  await Promise.all([
    User.findByIdAndUpdate(user._id, {
      refreshToken: refreshTokenHash,
      refreshTokenExpires,
    }),
    existingDeviceRecord?._id
      ? DeviceSession.deleteMany({
          user: user._id,
          deviceId,
          _id: { $ne: existingDeviceRecord._id },
        })
      : Promise.resolve(),
  ]);

  await DeviceSession.findOneAndUpdate(
    {
      user: user._id,
      deviceId,
    },
    {
      $set: deviceSessionPayload,
      $setOnInsert: {
        user: user._id,
        deviceId,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  // Log successful login (async, don't await)
  logger.info(
    `Successful login - User: ${user.email}, Role: ${user.role}, IP: ${req.ip}`,
  );

  // Set cookie and send response
  setAuthCookies(res, user.role, token, refreshTokenValue);

  res.status(200).json({
    success: true,
    message: successMessage || "Login successful",
    user: {
      id: user._id,
      firstname: user.firstName,
      lastname: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    },
    session: {
      sessionId,
      deviceId,
      isTrusted: existingDeviceRecord?.isTrusted || false,
    },
    suspension: accessPayload.currentState,
    // Neither cookie is actually read by this app's own Flutter client
    // (its real session lives in the httpOnly cookies set above) — this
    // is only here because the client's own AuthService.loginWithGoogle
    // opportunistically stores it if present. Harmless either way.
    token,
  });
};

// @desc    Login user with role-based validation
// @route   POST /api/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res) => {
  const { email, password, loginType } = req.body;
  const normalizedEmail = normalizeEmail(email);

  // Quick validation
  if (!normalizedEmail || !password) {
    throw new ValidationError("Please provide email and password");
  }

  // Get user with password (using cache)
  const user = await getUserByEmailCached(normalizedEmail, true);

  if (!user) {
    throw new AuthenticationError("Invalid credentials");
  }

  if (user.authProvider === "google" && !user.password) {
    throw new AuthenticationError(
      'This account signs in with Google. Use "Continue with Google" instead of a password.',
    );
  }

  // Check if email is verified
  if (!user.isEmailVerified) {
    throw new AuthenticationError("Please verify your email before logging in");
  }

  // Check password (bcrypt is async but we need it)
  const isMatch = await User.prototype.isPasswordCorrect.call(
    { password: user.password },
    password,
  );

  if (!isMatch) {
    throw new AuthenticationError("Invalid credentials");
  }

  // Role-based login validation
  if (loginType && user.role !== loginType) {
    throw new AuthorizationError(
      `Access denied. This login interface is for ${loginType}s only. Your account role is ${user.role}.`,
    );
  } else if (!loginType && user.role !== "client") {
    throw new AuthorizationError(
      `This is the client login interface. Your account role is ${user.role}. Please use the correct login interface.`,
    );
  }

  await establishSessionAndRespond(req, res, user, { loginType });
});
// @desc    Get user role and suggested login path
// @route   POST /api/auth/check-role
// @access  Public
// Public endpoint: look up a user by phone number, no auth required
exports.getUserByPhone = async (req, res, next) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    const user = await User.findOne({ phone })
      .select(
        "-password -refreshToken -passwordResetToken -emailVerificationToken",
      )
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

exports.checkUserRole = async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const cacheKey = CACHE_KEYS.USER_ROLE(normalizedEmail);

    // Try cache first
    let cachedRole = await cacheService.get(cacheKey);
    if (cachedRole) {
      return res.status(200).json(cachedRole);
    }

    const user = await User.findOne({ email: normalizedEmail })
      .select("role isEmailVerified")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Determine login path
    let loginPath = "/login";
    if (user.role === "admin") loginPath = "/login/admin";
    else if (user.role === "superadmin") loginPath = "/login/superadmin";
    else if (user.role === "agent") loginPath = "/login/agent";
    else if (user.role === "subadmin") loginPath = "/login/subadmin";

    const response = {
      success: true,
      role: user.role,
      loginPath: loginPath,
      isVerified: user.isEmailVerified,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.USER_ROLE);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Check email verification status
// @route   POST /api/auth/check-verification-status
// @access  Public
exports.checkVerificationStatus = async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const cacheKey = CACHE_KEYS.VERIFICATION_STATUS(normalizedEmail);

    // Try cache first
    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const user = await User.findOne({ email: normalizedEmail })
      .select("isEmailVerified")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const response = {
      success: true,
      isVerified: user.isEmailVerified,
    };

    await cacheService.set(cacheKey, response, CACHE_TTL.VERIFICATION_STATUS);

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
// @desc    Resend verification email
// @route   POST /api/auth/resend-verification
// @access  Public
exports.resendVerificationEmail = async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified",
      });
    }

    // Generate new verification token
    const verificationToken = user.generateEmailVerificationToken();
    await user.save();

    // Send verification email (fire and forget)
    sendVerificationEmail(user, verificationToken).catch((err) => {
      console.error("Failed to send verification email:", err);
    });

    res.status(200).json({
      success: true,
      message: "Verification email sent successfully",
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Forgot password
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new ValidationError("Email is required");
  }

  // Find user by email
  const user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    // Don't reveal that user doesn't exist for security
    return res.status(200).json({
      success: true,
      message:
        "If an account exists with that email, a reset link has been sent.",
    });
  }

  // Generate reset token
  const resetToken = user.generatePasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // Send email (fire and forget)
  sendPasswordResetEmail(user, resetToken).catch((emailError) => {
    // If email fails, remove reset token from user
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.save({ validateBeforeSave: false }).catch(console.error);

    logger.error("Failed to send password reset email:", {
      error: emailError.message,
      userId: user._id,
      email: user.email,
    });
  });

  res.status(200).json({
    success: true,
    message: "Password reset email sent successfully",
  });
});
// @desc    Reset password
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    throw new ValidationError("Token and password are required");
  }

  if (password.length < 6) {
    throw new ValidationError("Password must be at least 6 characters long");
  }

  // Get hashed token
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  // Find user with matching token and not expired
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    throw new ValidationError("Invalid or expired reset token");
  }

  // Set new password
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // Invalidate user cache
  await invalidateUserCaches(user.email, user._id);

  logger.info(`Password reset successful for user: ${user.email}`);

  res.status(200).json({
    success: true,
    message: "Password reset successful. You can now log in.",
  });
});
// @desc    Register a new admin user (superadmin only)
// @route   POST /api/auth/admin/signup
// @access  Private (superadmin)
exports.adminSignup = async (req, res, next) => {
  try {
    const {
      firstname,
      lastname,
      firstName,
      lastName,
      email,
      password,
      country,
      phone,
      dateofbirth,
    } = req.body;

    const normalizedFirstName = (firstName || firstname || "").trim();
    const normalizedLastName = (lastName || lastname || "").trim();
    const normalizedEmail = (email || "").toLowerCase().trim();
    const normalizedCountry =
      typeof country === "string"
        ? { name: country.trim(), state: "" }
        : {
            name: country?.name?.trim?.() || country?.[0] || "",
            state: country?.state?.trim?.() || country?.[1] || "",
          };

    if (
      !normalizedFirstName ||
      !normalizedLastName ||
      !normalizedEmail ||
      !password ||
      !phone ||
      !normalizedCountry.name ||
      !dateofbirth
    ) {
      return res.status(400).json({
        success: false,
        message:
          "First name, last name, email, password, phone, country, and date of birth are required",
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    // Create new admin user
    const user = new User({
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      email: normalizedEmail,
      password,
      country: normalizedCountry,
      phone,
      dateofbirth: new Date(dateofbirth),
      role: "admin",
    });

    const verificationToken = user.generateEmailVerificationToken();
    await sendVerificationEmail(user, verificationToken);
    await user.save();

    // Invalidate cache for this email
    await invalidateUserCaches(normalizedEmail, user._id);

    res.status(201).json({
      success: true,
      message:
        "Admin registration successful! Please check your email to verify your account.",
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Register a new agent user (admin, superadmin)
// @route   POST /api/auth/agent/signup
// @access  Private (admin, superadmin)
exports.agentSignup = async (req, res, next) => {
  try {
    const {
      firstname,
      lastname,
      firstName,
      lastName,
      email,
      password,
      country,
      phone,
      dateofbirth,
    } = req.body;

    const normalizedFirstName = (firstName || firstname || "").trim();
    const normalizedLastName = (lastName || lastname || "").trim();
    const normalizedEmail = (email || "").toLowerCase().trim();
    const normalizedCountry =
      typeof country === "string"
        ? { name: country.trim(), state: "" }
        : {
            name: country?.name?.trim?.() || "",
            state: country?.state?.trim?.() || "",
          };

    if (
      !normalizedFirstName ||
      !normalizedLastName ||
      !normalizedEmail ||
      !password ||
      !phone ||
      !normalizedCountry.name ||
      !dateofbirth
    ) {
      return res.status(400).json({
        success: false,
        message:
          "First name, last name, email, password, phone, country, and date of birth are required",
      });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    const user = new User({
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      email: normalizedEmail,
      password,
      country: normalizedCountry,
      phone,
      dateofbirth: new Date(dateofbirth),
      role: "agent",
      isEmailVerified: true,
    });

    await user.save();

    await invalidateUserCaches(normalizedEmail, user._id);

    res.status(201).json({
      success: true,
      message: "Agent registration successful.",
      data: {
        _id: user._id,
        firstname: user.firstName,
        lastname: user.lastName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Verify email
// @route   GET /api/auth/verify-email/:token
// @access  Public
exports.verifyEmail = async (req, res, next) => {
  try {
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    // Invalidate caches
    await invalidateUserCaches(user.email, user._id);

    res.redirect(`${config.CLIENT_URL}/?verified=true`);
  } catch (error) {
    next(error);
  }
};
// @desc    Generate token for client impersonation by admin
// @route   POST /api/auth/admin/impersonate/:clientId
// @access  Private (admin and superadmin only)
exports.impersonateClient = async (req, res, next) => {
  try {
    if (!req.user || !["admin", "superadmin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin or superadmin privileges required.",
      });
    }

    const adminId = req.user.id || req.user._id;
    const { clientId } = req.params;

    const clientUser = await User.findById(clientId);

    if (!clientUser) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    if (clientUser.role !== "client" && clientUser.role !== "agent") {
      return res.status(400).json({
        success: false,
        message: "You can only impersonate client or agent accounts",
      });
    }

    const clientToken = jwt.sign(
      {
        userId: clientId,
        id: clientId,
        role: clientUser.role,
        impersonatedBy: adminId,
        isImpersonating: true,
      },
      config.JWT_SECRET,
      { expiresIn: "1h" },
    );

    res
      .status(200)
      .cookie(
        "auth_token_client",
        clientToken,
        getCookieOptions(ACCESS_COOKIE_MAX_AGE),
      )
      .json({
        success: true,
        user: {
          id: clientUser._id,
          firstname: clientUser.firstName,
          lastname: clientUser.lastName,
          email: clientUser.email,
          role: clientUser.role,
          isEmailVerified: clientUser.isEmailVerified,
        },
      });
  } catch (error) {
    next(error);
  }
};
// @desc    Logout user (clear specific role token)
// @route   POST /api/auth/logout
// @access  Private
exports.logout = asyncHandler(async (req, res) => {
  const userRole = req.user.role;

  logger.info(
    `User logout - ID: ${req.user.id}, Role: ${userRole}, IP: ${req.ip}`,
  );

  if (req.deviceSession?.sessionId) {
    await DeviceSession.findOneAndUpdate(
      {
        user: req.user.id,
        sessionId: req.deviceSession.sessionId,
      },
      {
        $set: {
          status: "logged_out",
          refreshTokenHash: null,
          refreshTokenExpires: null,
          lastActiveAt: new Date(),
        },
      },
    );
  } else {
    await User.findByIdAndUpdate(req.user.id, {
      $unset: {
        refreshToken: 1,
        refreshTokenExpires: 1,
      },
    });
  }

  clearAuthCookies(res, userRole);

  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

exports.refreshToken = asyncHandler(async (req, res) => {
  const refreshCookie = findRefreshCookie(req);

  if (!refreshCookie) {
    throw new AuthenticationError("Refresh token not found");
  }

  const { role, refreshTokenValue } = refreshCookie;
  let decoded;

  try {
    decoded = jwt.verify(refreshTokenValue, config.JWT_REFRESH_SECRET);
  } catch (error) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Invalid or expired refresh token");
  }

  if (decoded.type !== "refresh") {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Invalid refresh token type");
  }

  if (!decoded.sessionId || !decoded.deviceId) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Refresh token session is not valid");
  }

  const user = await User.findById(decoded.userId)
    .select("+refreshToken")
    .select(
      "firstName lastName email role isEmailVerified refreshToken refreshTokenExpires",
    );

  if (!user) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("User not found");
  }

  const accessPayload = await buildAccessPayload({
    io: req.app.get("io"),
  });

  if (user.role !== "superadmin" && accessPayload.currentState.isSuspended) {
    clearAuthCookies(res, role);
    return res.status(423).json({
      success: false,
      message:
        user.role === "admin" ||
        user.role === "agent" ||
        user.role === "subadmin"
          ? accessPayload.currentState.adminMessage
          : accessPayload.currentState.maintenanceMessage,
      suspension: accessPayload.currentState,
    });
  }

  if (user.role !== role) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Refresh token role mismatch");
  }

  const session = await DeviceSession.findOne({
    user: user._id,
    sessionId: decoded.sessionId,
  }).select("+refreshTokenHash");

  if (!session) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Session not found");
  }

  if (
    session.deviceId !== decoded.deviceId ||
    session.isBlocked ||
    session.status !== "active"
  ) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("This device session is no longer allowed");
  }

  if (
    !session.refreshTokenHash ||
    session.refreshTokenHash !== hashToken(refreshTokenValue) ||
    !session.refreshTokenExpires ||
    session.refreshTokenExpires < new Date()
  ) {
    clearAuthCookies(res, role);
    throw new AuthenticationError("Refresh token is no longer valid");
  }

  const newAccessToken = generateToken(user._id, user.role, {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
  });
  const newRefreshTokenValue = generateRefreshToken(user._id, user.role, {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
  });
  const newRefreshTokenHash = hashToken(newRefreshTokenValue);
  const nextRefreshExpiry = getRefreshExpiryDate();

  user.refreshToken = newRefreshTokenHash;
  user.refreshTokenExpires = nextRefreshExpiry;

  const latestMetadata = await getDeviceMetadataFromRequest(req);

  await Promise.all([
    user.save({ validateBeforeSave: false }),
    DeviceSession.findByIdAndUpdate(session._id, {
      $set: {
        refreshTokenHash: newRefreshTokenHash,
        refreshTokenExpires: nextRefreshExpiry,
        lastActiveAt: new Date(),
        ipAddress: latestMetadata.ipAddress,
        location: latestMetadata.location,
        userAgent: latestMetadata.userAgent,
        browser: latestMetadata.browser,
        os: latestMetadata.os,
        deviceType: latestMetadata.deviceType,
        deviceName: latestMetadata.deviceName || session.deviceName,
      },
    }),
  ]);

  setAuthCookies(res, user.role, newAccessToken, newRefreshTokenValue);

  res.status(200).json({
    success: true,
    message: "Token refreshed successfully",
    user: {
      id: user._id,
      firstname: user.firstName,
      lastname: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    },
    suspension: accessPayload.currentState,
  });
});

// @desc    Sign in (or sign up, on first use) with a verified Google ID
//          token. Client-only — mirrors the regular `login` endpoint's own
//          default (no loginType) restriction, since the "Continue with
//          Google" button only ever appears on the client login/register
//          screens.
// @route   POST /api/auth/google
// @access  Public
// body: { idToken: string }  — accessToken (if sent) is accepted but
// unused: the ID token alone is enough to verify identity, and Google's
// separate OAuth access token isn't needed for anything this endpoint does.
exports.google = asyncHandler(async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    throw new ValidationError("idToken is required");
  }

  if (googleAudiences().length === 0) {
    // Deliberately not a 500/thrown error and not folded into
    // validateConfig() at boot — Google sign-in is an optional feature; a
    // backend that hasn't configured it yet should still start normally,
    // this endpoint should just say so plainly instead of crashing or
    // 404ing with no explanation.
    return res.status(503).json({
      success: false,
      message: "Google sign-in is not configured on this server yet.",
    });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken);
  } catch (error) {
    logger.warn(`Google ID token verification failed: ${error.message}`);
    throw new AuthenticationError("Invalid or expired Google credentials");
  }

  if (!payload?.email) {
    throw new AuthenticationError(
      "Google did not return an email address for this account",
    );
  }
  if (payload.email_verified === false) {
    throw new AuthenticationError(
      "Your Google account's email is not verified",
    );
  }

  const normalizedEmail = normalizeEmail(payload.email);
  const googleId = payload.sub;

  // A genuine Mongoose document (not the cached/.lean() helper) since a
  // new signup needs .save(), and an existing local account may need its
  // googleId linked on first Google sign-in.
  let user = await User.findOne({ googleId }).select("+password");
  if (!user) {
    user = await User.findOne({ email: normalizedEmail }).select("+password");
  }

  if (user) {
    // Existing account signing in with Google for the first time — link
    // it rather than creating a duplicate. Does not touch authProvider or
    // an existing password: an account can end up with BOTH a password
    // and a linked Google account, either still works.
    //
    // Also repairs a genuinely broken earlier state: an account created
    // by an earlier version of this handler that fell back to the literal
    // placeholder names "Google"/"User" (because the payload it saw then
    // had no given_name/family_name/name — the account-link path never
    // used to refresh these afterwards, so that placeholder was stuck
    // permanently even once later sign-ins carried a real name). Only
    // overwrites when the stored name still IS that exact placeholder —
    // never touches a real name the user (or an admin) may have since set.
    const hasPlaceholderName =
      user.firstName === "Google" && user.lastName === "User";
    let didUpdate = false;

    if (!user.googleId) {
      user.googleId = googleId;
      didUpdate = true;
    }
    if (hasPlaceholderName) {
      const { firstName, lastName } = deriveNameFromGooglePayload(payload);
      if (firstName !== "Google" || lastName !== "User") {
        user.firstName = firstName;
        user.lastName = lastName;
        didUpdate = true;
      }
    }
    if (didUpdate) {
      await user.save();
      await invalidateUserCaches(normalizedEmail, user._id);
    }
  } else {
    // First time this email has ever signed in — create a new client
    // account. No password, phone, date of birth or country: Google's
    // OAuth profile doesn't provide any of those, and the User schema's
    // `required` rules exempt a `authProvider: "google"` account from
    // needing them (see models/User.js) rather than this fabricating
    // placeholder values for real personal fields. isEmailVerified is
    // true immediately — Google already verified it, so this app's own
    // separate email-verification email/link would be redundant.
    const { firstName, lastName } = deriveNameFromGooglePayload(payload);
    user = new User({
      firstName,
      lastName,
      email: normalizedEmail,
      role: "client",
      authProvider: "google",
      googleId,
      isEmailVerified: true,
    });
    await user.save();
    await invalidateUserCaches(normalizedEmail, user._id);
  }

  // Same restriction the regular login endpoint applies when no loginType
  // is given — the Google button only appears on the client-facing
  // screens, so a non-client account (which could only get here via the
  // account-linking path above, never the create-new-account path) isn't
  // a valid Google sign-in target here.
  if (user.role !== "client") {
    throw new AuthorizationError(
      `This is the client login interface. Your account role is ${user.role}. Please use the correct login interface.`,
    );
  }

  await establishSessionAndRespond(req, res, user, {
    successMessage: "Google sign-in successful",
  });
});

exports.invalidateAuthCaches = invalidateUserCaches;

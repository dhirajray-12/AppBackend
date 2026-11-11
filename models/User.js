// backend/models/User.js - UPDATED WITH INDEXES
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const UserSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, "First name is required"],
    index: true, // Added index for search
  },
  lastName: {
    type: String,
    required: [true, "Last name is required"],
    index: true, // Added index for search
  },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
    lowercase: true,
    trim: true,
    index: true, // Added unique index
    match: [
      /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
      "Please provide a valid email",
    ],
  },
  role: {
    type: String,
    enum: ["client", "admin", "superadmin", "agent", "subadmin"],
    default: "client",
    index: true, // Added index for role filtering
  },
  // Only meaningful when role === "subadmin"
  permissions: {
    type: [String],
    default: [],
  },
  // Cosmetic/reference tag only for subadmins — must NOT be used to scope
  // query results.
  assignedClients: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: "User",
    default: [],
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  // Google Sign-In (see controllers/authController.js `google`). Two
  // separate fields rather than overloading `password`/a single flag:
  // `authProvider` records how the account can log in, `googleId` is
  // Google's own stable subject id — used to find the account again even
  // if the user later changes their Google email address (email alone
  // wouldn't survive that).
  authProvider: {
    type: String,
    enum: ["local", "google"],
    default: "local",
  },
  googleId: {
    type: String,
    default: null,
    index: true,
    sparse: true, // lets every local-signup user keep a null googleId without tripping the unique index
    unique: true,
  },
  password: {
    type: String,
    // Not required for a Google-created account — there's no password to
    // check for it. Left genuinely absent rather than a fabricated value.
    required: [
      function () {
        return this.authProvider !== "google";
      },
      "Password is required",
    ],
    minlength: 6,
    select: false,
  },
  country: {
    name: {
      type: String,
      // Google's OAuth profile carries no address/country — a Google
      // signup is created without one rather than inventing a value; the
      // client can fill it in later via their profile (same for phone/
      // dateofbirth below).
      required: [
        function () {
          return this.authProvider !== "google";
        },
        "Country is required",
      ],
      index: true, // Added index for country filtering
    },
    state: {
      type: String,
    },
  },
  phone: {
    type: String,
    required: [
      function () {
        return this.authProvider !== "google";
      },
      "Phone number is required",
    ],
  },
  dateofbirth: {
    type: Date,
    required: [
      function () {
        return this.authProvider !== "google";
      },
      "Date of birth is required",
    ],
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
    index: true, // Added index for filtering
  },
  status: {
    type: String,
    enum: ["activated", "suspended"],
    default: "activated",
    index: true, // Added index for filtering
  },
  referredBy: {
    type: String,
    default: null,
    index: true, // Added index for referral queries
  },
  emailVerificationToken: String,
  emailVerificationExpires: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  refreshToken: {
    type: String,
    select: false,
  },
  refreshTokenExpires: Date,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true, // Added index for sorting
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Pre-save middleware to hash password
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to check if password is correct
UserSchema.methods.isPasswordCorrect = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to generate email verification token
UserSchema.methods.generateEmailVerificationToken = function () {
  const verificationToken = crypto.randomBytes(32).toString("hex");

  this.emailVerificationToken = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");

  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;

  return verificationToken;
};

// Method to generate password reset token
UserSchema.methods.generatePasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");

  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000;

  return resetToken;
};

// Add compound indexes for common query patterns
UserSchema.index({ role: 1, status: 1, createdAt: -1 });
UserSchema.index({ role: 1, createdAt: -1 });
UserSchema.index({ role: 1, isEmailVerified: 1 });
UserSchema.index({ "country.name": 1, role: 1 });

// Text search index for client search functionality
UserSchema.index(
  { firstName: "text", lastName: "text", email: "text" },
  {
    weights: {
      firstName: 10,
      lastName: 10,
      email: 5,
    },
    name: "ClientSearchIndex",
  },
);

const User = mongoose.model("User", UserSchema);

module.exports = User;

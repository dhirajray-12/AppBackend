const User = require("../../models/User");
const { ALL_PERMISSIONS } = require("../../constants/permissions");
const {
  asyncHandler,
  ValidationError,
  NotFoundError,
} = require("../../middlewares/errorHandler");
const { invalidateAuthCaches } = require("../authController");

const SUBADMIN_FIELDS =
  "-password -refreshToken -passwordResetToken -emailVerificationToken";

const validatePermissions = (permissions) => {
  if (permissions === undefined) return [];
  if (!Array.isArray(permissions)) {
    throw new ValidationError("permissions must be an array of strings");
  }
  const invalid = permissions.filter((key) => !ALL_PERMISSIONS.includes(key));
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid permission key(s): ${invalid.join(", ")}`,
    );
  }
  return permissions;
};

// @desc    List subadmins
// @route   GET /api/admin/subadmins
// @access  Private (admin, superadmin)
exports.listSubadmins = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const query = { role: "subadmin" };
  if (req.query.status) {
    query.status = req.query.status;
  }
  if (req.query.search) {
    const searchRegex = new RegExp(req.query.search, "i");
    query.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex },
    ];
  }

  const [subadmins, total, activeCount, suspendedCount] = await Promise.all([
    User.find(query)
      .select(SUBADMIN_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(query),
    User.countDocuments({ role: "subadmin", status: "activated" }),
    User.countDocuments({ role: "subadmin", status: "suspended" }),
  ]);

  res.status(200).json({
    success: true,
    data: subadmins,
    stats: {
      total,
      active: activeCount,
      suspended: suspendedCount,
    },
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: limit,
    },
  });
});

// @desc    Get a single subadmin
// @route   GET /api/admin/subadmins/:id
// @access  Private (admin, superadmin)
exports.getSubadmin = asyncHandler(async (req, res) => {
  const subadmin = await User.findOne({
    _id: req.params.id,
    role: "subadmin",
  })
    .select(SUBADMIN_FIELDS)
    .lean();

  if (!subadmin) {
    throw new NotFoundError("Subadmin");
  }

  res.status(200).json({ success: true, data: subadmin });
});

// @desc    Create a subadmin
// @route   POST /api/admin/subadmins
// @access  Private (admin, superadmin)
exports.createSubadmin = asyncHandler(async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    password,
    country,
    phone,
    dateofbirth,
    permissions,
    assignedClients,
  } = req.body;

  const normalizedFirstName = (firstName || "").trim();
  const normalizedLastName = (lastName || "").trim();
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
    throw new ValidationError(
      "First name, last name, email, password, phone, country, and date of birth are required",
    );
  }

  const validatedPermissions = validatePermissions(permissions);

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new ValidationError("User with this email already exists");
  }

  const subadmin = new User({
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    password,
    country: normalizedCountry,
    phone,
    dateofbirth: new Date(dateofbirth),
    role: "subadmin",
    isEmailVerified: true,
    permissions: validatedPermissions,
    assignedClients: Array.isArray(assignedClients) ? assignedClients : [],
    createdBy: req.user._id,
  });

  await subadmin.save();
  await invalidateAuthCaches(normalizedEmail, subadmin._id);

  const data = subadmin.toObject();
  delete data.password;
  delete data.refreshToken;
  delete data.passwordResetToken;
  delete data.emailVerificationToken;

  res.status(201).json({
    success: true,
    message: "Subadmin created successfully.",
    data,
  });
});

// @desc    Update a subadmin's details/permissions
// @route   PUT /api/admin/subadmins/:id
// @access  Private (admin, superadmin)
exports.updateSubadmin = asyncHandler(async (req, res) => {
  const subadmin = await User.findOne({
    _id: req.params.id,
    role: "subadmin",
  });

  if (!subadmin) {
    throw new NotFoundError("Subadmin");
  }

  const {
    firstName,
    lastName,
    phone,
    country,
    dateofbirth,
    permissions,
    assignedClients,
    status,
  } = req.body;

  if (firstName !== undefined) subadmin.firstName = firstName.trim();
  if (lastName !== undefined) subadmin.lastName = lastName.trim();
  if (phone !== undefined) subadmin.phone = phone;
  if (dateofbirth !== undefined) subadmin.dateofbirth = new Date(dateofbirth);
  if (country !== undefined) {
    subadmin.country =
      typeof country === "string"
        ? { name: country.trim(), state: "" }
        : {
            name: country?.name?.trim?.() || "",
            state: country?.state?.trim?.() || "",
          };
  }
  if (permissions !== undefined) {
    subadmin.permissions = validatePermissions(permissions);
  }
  if (assignedClients !== undefined) {
    subadmin.assignedClients = Array.isArray(assignedClients)
      ? assignedClients
      : [];
  }
  if (status !== undefined) {
    if (!["activated", "suspended"].includes(status)) {
      throw new ValidationError("status must be 'activated' or 'suspended'");
    }
    subadmin.status = status;
  }

  await subadmin.save();
  await invalidateAuthCaches(subadmin.email, subadmin._id);

  const data = subadmin.toObject();
  delete data.password;
  delete data.refreshToken;
  delete data.passwordResetToken;
  delete data.emailVerificationToken;

  res.status(200).json({
    success: true,
    message: "Subadmin updated successfully.",
    data,
  });
});

// @desc    Reset a subadmin's password
// @route   PUT /api/admin/subadmins/:id/reset-password
// @access  Private (admin, superadmin)
exports.resetSubadminPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;

  if (!password || password.length < 6) {
    throw new ValidationError("Password must be at least 6 characters");
  }

  const subadmin = await User.findOne({
    _id: req.params.id,
    role: "subadmin",
  });

  if (!subadmin) {
    throw new NotFoundError("Subadmin");
  }

  subadmin.password = password;
  await subadmin.save();
  await invalidateAuthCaches(subadmin.email, subadmin._id);

  res.status(200).json({
    success: true,
    message: "Subadmin password reset successfully.",
  });
});

// @desc    Delete a subadmin
// @route   DELETE /api/admin/subadmins/:id
// @access  Private (admin, superadmin)
exports.deleteSubadmin = asyncHandler(async (req, res) => {
  const subadmin = await User.findOne({
    _id: req.params.id,
    role: "subadmin",
  });

  if (!subadmin) {
    throw new NotFoundError("Subadmin");
  }

  await subadmin.deleteOne();
  await invalidateAuthCaches(subadmin.email, subadmin._id);

  res.status(200).json({
    success: true,
    message: "Subadmin deleted successfully.",
  });
});

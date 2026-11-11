const path = require("path");
const multer = require("multer");
const User = require("../../models/User");
const EmailLog = require("../../models/EmailLog");
const { sendEmail } = require("../../services/emailService");
const { customAdminEmailTemplate, escapeHtml } = require("../../utils/emailTemplates");
const { uploadBufferToCloudinary } = require("../../utils/cloudinary");
const { AppError } = require("../../middlewares/errorHandler");

const storage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
  const allowedFileTypes = /\.(jpg|jpeg|png|gif|webp)$/i;
  const extname = allowedFileTypes.test(path.extname(file.originalname));
  const mimetype = file.mimetype.startsWith("image/");
  if (extname && mimetype) return cb(null, true);
  cb(new Error("Error: Images only (jpeg, jpg, png, gif, webp)!"), false);
};

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const parseImageUpload = (req, res) =>
  new Promise((resolve, reject) => {
    upload.single("image")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        reject(
          new Error(
            err.code === "LIMIT_FILE_SIZE"
              ? "Image size limit exceeded. Maximum 5MB allowed."
              : err.message,
          ),
        );
      } else if (err) {
        reject(err);
      } else {
        resolve(req.file);
      }
    });
  });

const uploadEmailImage = async (uploadedFile) => {
  if (!uploadedFile) return null;
  const result = await uploadBufferToCloudinary(uploadedFile.buffer, {
    folder: "email-attachments",
    resourceType: "image",
  });
  return {
    attachments: [{ filename: uploadedFile.originalname, path: result.secure_url }],
    attachmentUrl: result.secure_url,
    attachmentPublicId: result.public_id,
    attachmentName: uploadedFile.originalname,
  };
};

// @desc    Send a custom email to a single client
// @route   POST /api/clients/:id/send-email
// @access  Private (admin, superadmin)
exports.sendEmailToClient = async (req, res, next) => {
  let uploadedFile;
  try {
    uploadedFile = await parseImageUpload(req, res);
  } catch (err) {
    return next(new AppError(err.message, 400, null));
  }

  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Subject and message are required",
      });
    }

    const user = await User.findById(req.params.id).select(
      "email firstName lastName",
    );

    if (!user || !user.email) {
      return res.status(404).json({
        success: false,
        message: "Client not found or has no email on file",
      });
    }

    const html = customAdminEmailTemplate({
      name: user.firstName,
      subject,
      bodyHtml: escapeHtml(message).replace(/\n/g, "<br/>"),
    });

    let imageData;
    try {
      imageData = await uploadEmailImage(uploadedFile);
    } catch (err) {
      return next(err);
    }

    try {
      await sendEmail({
        to: user.email,
        subject,
        html,
        attachments: imageData?.attachments,
      });
      await EmailLog.create({
        recipient: user._id,
        recipientEmail: user.email,
        subject,
        message,
        sentBy: req.user?._id,
        batch: "single",
        status: "sent",
        attachmentUrl: imageData?.attachmentUrl,
        attachmentName: imageData?.attachmentName,
        attachmentPublicId: imageData?.attachmentPublicId,
      });
    } catch (err) {
      await EmailLog.create({
        recipient: user._id,
        recipientEmail: user.email,
        subject,
        message,
        sentBy: req.user?._id,
        batch: "single",
        status: "failed",
        error: err.message,
        attachmentUrl: imageData?.attachmentUrl,
        attachmentName: imageData?.attachmentName,
        attachmentPublicId: imageData?.attachmentPublicId,
      });
      throw err;
    }

    return res.status(200).json({
      success: true,
      message: `Email sent to ${user.email}`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Preview who will receive a broadcast email (every client with an email on file)
// @route   GET /api/clients/send-email/all/preview
// @access  Private (admin, superadmin)
exports.getAllClientsEmailPreview = async (req, res, next) => {
  try {
    const clients = await User.find({
      role: "client",
      email: { $exists: true, $ne: "" },
    }).select("email firstName lastName");

    return res.status(200).json({
      success: true,
      total: clients.length,
      clients: clients.map((c) => ({
        id: c._id,
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
        email: c.email,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Send a custom email to every client with an email on file
// @route   POST /api/clients/send-email/all
// @access  Private (admin, superadmin)
exports.sendEmailToAllClients = async (req, res, next) => {
  let uploadedFile;
  try {
    uploadedFile = await parseImageUpload(req, res);
  } catch (err) {
    return next(new AppError(err.message, 400, null));
  }

  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: "Subject and message are required",
      });
    }

    const users = await User.find({
      role: "client",
      email: { $exists: true, $ne: "" },
    }).select("email firstName lastName");

    let imageData;
    try {
      imageData = await uploadEmailImage(uploadedFile);
    } catch (err) {
      return next(err);
    }

    const outcomes = await Promise.all(
      users.map(async (user) => {
        const html = customAdminEmailTemplate({
          name: user.firstName,
          subject,
          bodyHtml: escapeHtml(message).replace(/\n/g, "<br/>"),
        });

        try {
          await sendEmail({
            to: user.email,
            subject,
            html,
            attachments: imageData?.attachments,
          });
          return {
            email: user.email,
            status: "sent",
            log: {
              recipient: user._id,
              recipientEmail: user.email,
              subject,
              message,
              sentBy: req.user?._id,
              batch: "all",
              status: "sent",
              attachmentUrl: imageData?.attachmentUrl,
              attachmentName: imageData?.attachmentName,
              attachmentPublicId: imageData?.attachmentPublicId,
            },
          };
        } catch (err) {
          console.error(`Failed to email ${user.email}:`, err.message);
          return {
            email: user.email,
            status: "failed",
            log: {
              recipient: user._id,
              recipientEmail: user.email,
              subject,
              message,
              sentBy: req.user?._id,
              batch: "all",
              status: "failed",
              error: err.message,
              attachmentUrl: imageData?.attachmentUrl,
              attachmentName: imageData?.attachmentName,
              attachmentPublicId: imageData?.attachmentPublicId,
            },
          };
        }
      }),
    );

    if (outcomes.length) {
      await EmailLog.insertMany(outcomes.map((o) => o.log));
    }

    const sent = outcomes.filter((o) => o.status === "sent").length;
    const failed = outcomes.length - sent;
    const results = outcomes.map((o) => ({ email: o.email, status: o.status }));

    return res.status(200).json({
      success: true,
      message: `Email sent to ${sent} client(s)${failed ? `, ${failed} failed` : ""}`,
      sent,
      failed,
      total: users.length,
      results,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get email-send counts per client (split by single/broadcast), plus overall totals
// @route   GET /api/clients/email-stats
// @access  Private (admin, superadmin)
exports.getEmailStats = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const perClient = await EmailLog.aggregate([
      { $match: { status: "sent" } },
      {
        $group: {
          _id: "$recipient",
          email: { $first: "$recipientEmail" },
          single: {
            $sum: { $cond: [{ $eq: ["$batch", "single"] }, 1, 0] },
          },
          broadcast: {
            $sum: { $cond: [{ $eq: ["$batch", "all"] }, 1, 0] },
          },
          total: { $sum: 1 },
        },
      },
    ]);

    const clientIds = perClient.map((c) => c._id).filter(Boolean);
    const users = await User.find({ _id: { $in: clientIds } }).select(
      "firstName lastName email",
    );
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const totalSingle = perClient.reduce((sum, c) => sum + c.single, 0);
    const totalBroadcast = perClient.reduce((sum, c) => sum + c.broadcast, 0);
    const total = totalSingle + totalBroadcast;

    let allClients = perClient
      .map((c) => {
        const user = userMap.get(String(c._id));
        return {
          clientId: c._id,
          name: user
            ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
            : "",
          email: user?.email || c.email,
          single: c.single,
          broadcast: c.broadcast,
          count: c.total,
        };
      })
      .sort((a, b) => b.count - a.count);

    if (search) {
      const searchRegex = new RegExp(search, "i");
      allClients = allClients.filter(
        (c) => searchRegex.test(c.name) || searchRegex.test(c.email),
      );
    }

    const clientsTotal = allClients.length;
    const clientsPages = Math.ceil(clientsTotal / limitNum) || 1;
    const start = (pageNum - 1) * limitNum;
    const paginatedClients = allClients.slice(start, start + limitNum);

    return res.status(200).json({
      success: true,
      total,
      totalSingle,
      totalBroadcast,
      perClient: paginatedClients,
      clientsTotal,
      clientsPage: pageNum,
      clientsPages,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get a paginated, searchable/filterable list of every email sent
// @route   GET /api/clients/email-logs
// @access  Private (admin, superadmin)
exports.getAllEmailLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = "", status = "", batch = "" } =
      req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (status) query.status = status;
    if (batch) query.batch = batch;
    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$or = [
        { recipientEmail: searchRegex },
        { subject: searchRegex },
      ];
    }

    const [logs, total] = await Promise.all([
      EmailLog.find(query)
        .populate("recipient", "firstName lastName")
        .populate("sentBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      EmailLog.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: logs.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum) || 1,
      data: logs.map((log) => ({
        id: log._id,
        recipientId: log.recipient?._id || null,
        recipientName: log.recipient
          ? `${log.recipient.firstName || ""} ${log.recipient.lastName || ""}`.trim()
          : "",
        recipientEmail: log.recipientEmail,
        subject: log.subject,
        message: log.message,
        status: log.status,
        error: log.error,
        batch: log.batch,
        sentByName: log.sentBy
          ? `${log.sentBy.firstName || ""} ${log.sentBy.lastName || ""}`.trim()
          : "",
        attachmentUrl: log.attachmentUrl,
        attachmentName: log.attachmentName,
        createdAt: log.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get email-send history for a single client
// @route   GET /api/clients/:id/email-logs
// @access  Private (admin, superadmin)
exports.getClientEmailLogs = async (req, res, next) => {
  try {
    const logs = await EmailLog.find({ recipient: req.params.id })
      .sort({ createdAt: -1 })
      .select(
        "subject status batch createdAt error attachmentUrl attachmentName",
      );

    const sentLogs = logs.filter((l) => l.status === "sent");
    const single = sentLogs.filter((l) => l.batch === "single").length;
    const broadcast = sentLogs.filter((l) => l.batch === "all").length;

    return res.status(200).json({
      success: true,
      count: logs.length,
      single,
      broadcast,
      total: sentLogs.length,
      data: logs,
    });
  } catch (error) {
    next(error);
  }
};

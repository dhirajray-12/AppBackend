const mongoose = require("mongoose");

const EmailLogSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recipientEmail: {
      type: String,
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    batch: {
      type: String,
      enum: ["single", "all"],
      default: "single",
    },
    status: {
      type: String,
      enum: ["sent", "failed"],
      default: "sent",
    },
    error: {
      type: String,
    },
    attachmentUrl: {
      type: String,
    },
    attachmentName: {
      type: String,
    },
    attachmentPublicId: {
      type: String,
    },
  },
  { timestamps: true },
);

EmailLogSchema.index({ recipient: 1, createdAt: -1 });
EmailLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("EmailLog", EmailLogSchema);

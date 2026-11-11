// Backend\models\client\Profile.js

const mongoose = require("mongoose");

const ProfileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  // Personal Information
  educationLevel: {
    type: String,
    enum: [
      "secondary",
      "higher secondary",
      "bachelor's degree",
      "master's degree",
      "doctorate",
      "other",
    ],
  },
  otherEducation: {
    type: String,
  },
  isEmployed: {
    type: Boolean,
  },
  kycVerified: {
    type: Boolean,
    default: false,
  },
  kycStatus: {
    type: String,
    enum: ["unverified", "verified", "rejected"],
    default: "unverified",
  },
  kycRejectReason: {
    type: String,
  },
  ibPartner: {
    type: String,
  },
  password: {
    type: String,
    minlength: 6,
  },
  idDocument: {
    type: String,
  },
  idDocumentPublicId: {
    type: String,
  },
  address1Document: {
    type: String,
  },
  address1DocumentPublicId: {
    type: String,
  },
  address2Document: {
    type: String,
  },
  address2DocumentPublicId: {
    type: String,
  },

  // Account Details
  bankDetails: {
    bankName: String,
    accountHolderName: String,
    accountNumber: String,
    ifscSwiftCode: String,
  },

  // Wallet Details
  walletDetails: {
    tetherWalletAddress: String,
    ethWalletAddress: String,
    accountNumber: String,
    trxWalletAddress: String,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports =
  mongoose.models.Profile || mongoose.model("Profile", ProfileSchema);

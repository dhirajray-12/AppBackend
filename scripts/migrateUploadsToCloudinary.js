// One-off migration: push every locally-stored upload (QR codes, deposit
// proofs, KYC documents, ticket attachments) to Cloudinary and rewrite the
// DB fields to the returned secure_url + public_id. Safe to re-run — any
// field that's already an http(s) URL is left untouched.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { uploadFileToCloudinary } = require("../utils/cloudinary");

const PaymentMethod = require("../models/PaymentMethod");
const Deposit = require("../models/Deposit");
const Profile = require("../models/client/Profile");
const Attachment = require("../models/Attachment");

const isLocalPath = (value) =>
  typeof value === "string" && value.trim() && !/^https?:\/\//i.test(value);

const resolveLocalPath = (value) => {
  if (path.isAbsolute(value)) {
    return value;
  }
  const cleaned = value.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.join(__dirname, "..", cleaned);
};

const stats = { migrated: 0, skipped: 0, missing: 0, failed: 0 };

async function migrateField({ label, folder, resourceType = "auto" }, absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    console.warn(`  [missing] ${label}: ${absolutePath}`);
    stats.missing += 1;
    return null;
  }
  try {
    const result = await uploadFileToCloudinary(absolutePath, {
      folder,
      resource_type: resourceType,
    });
    stats.migrated += 1;
    return result;
  } catch (error) {
    console.error(`  [failed] ${label}: ${error.message}`);
    stats.failed += 1;
    return null;
  }
}

async function migratePaymentMethods() {
  const methods = await PaymentMethod.find({ qrCode: { $exists: true, $ne: "" } });
  for (const method of methods) {
    if (!isLocalPath(method.qrCode)) {
      stats.skipped += 1;
      continue;
    }
    const uploaded = await migrateField(
      { label: `PaymentMethod ${method._id}`, folder: "payment-qr-codes", resourceType: "image" },
      resolveLocalPath(method.qrCode),
    );
    if (uploaded) {
      method.qrCode = uploaded.secure_url;
      method.qrCodePublicId = uploaded.public_id;
      await method.save();
      console.log(`  [ok] PaymentMethod ${method._id} -> ${uploaded.secure_url}`);
    }
  }
}

async function migrateDeposits() {
  const deposits = await Deposit.find({ proofOfPayment: { $exists: true, $ne: "" } });
  for (const deposit of deposits) {
    if (!isLocalPath(deposit.proofOfPayment)) {
      stats.skipped += 1;
      continue;
    }
    const uploaded = await migrateField(
      { label: `Deposit ${deposit._id}`, folder: "deposit-proofs" },
      resolveLocalPath(deposit.proofOfPayment),
    );
    if (uploaded) {
      deposit.proofOfPayment = uploaded.secure_url;
      deposit.proofOfPaymentPublicId = uploaded.public_id;
      await deposit.save();
      console.log(`  [ok] Deposit ${deposit._id} -> ${uploaded.secure_url}`);
    }
  }
}

async function migrateProfiles() {
  const fields = ["idDocument", "address1Document", "address2Document"];
  const profiles = await Profile.find({
    $or: fields.map((f) => ({ [f]: { $exists: true, $ne: "" } })),
  });

  for (const profile of profiles) {
    let changed = false;
    for (const field of fields) {
      const value = profile[field];
      if (!isLocalPath(value)) continue;
      const uploaded = await migrateField(
        { label: `Profile ${profile._id}.${field}`, folder: "kyc-documents" },
        resolveLocalPath(value),
      );
      if (uploaded) {
        profile[field] = uploaded.secure_url;
        profile[`${field}PublicId`] = uploaded.public_id;
        changed = true;
        console.log(`  [ok] Profile ${profile._id}.${field} -> ${uploaded.secure_url}`);
      }
    }
    if (changed) {
      await profile.save();
    } else {
      stats.skipped += 1;
    }
  }
}

async function migrateAttachments() {
  const attachments = await Attachment.find({ filePath: { $exists: true, $ne: "" } });
  for (const attachment of attachments) {
    if (!isLocalPath(attachment.filePath)) {
      stats.skipped += 1;
      continue;
    }
    const uploaded = await migrateField(
      { label: `Attachment ${attachment._id}`, folder: "ticket-attachments" },
      resolveLocalPath(attachment.filePath),
    );
    if (uploaded) {
      attachment.filePath = uploaded.secure_url;
      attachment.publicId = uploaded.public_id;
      await attachment.save();
      console.log(`  [ok] Attachment ${attachment._id} -> ${uploaded.secure_url}`);
    }
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB. Starting Cloudinary migration...\n");

  console.log("Payment method QR codes:");
  await migratePaymentMethods();

  console.log("\nDeposit proofs of payment:");
  await migrateDeposits();

  console.log("\nKYC documents:");
  await migrateProfiles();

  console.log("\nTicket attachments:");
  await migrateAttachments();

  console.log("\nDone.");
  console.log(stats);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Migration failed:", error);
  await mongoose.disconnect();
  process.exit(1);
});

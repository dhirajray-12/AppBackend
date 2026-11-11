// backend/middlewares/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Allowed file types with their extensions and MIME types
const ALLOWED_FILE_TYPES = {
  "application/pdf": {
    extensions: [".pdf"],
    magicNumbers: [0x25, 0x50, 0x44, 0x46], // %PDF
  },
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    magicNumbers: [0xff, 0xd8, 0xff], // JPEG signature
  },
  "image/png": {
    extensions: [".png"],
    magicNumbers: [0x89, 0x50, 0x4e, 0x47], // PNG signature
  },
  "image/gif": {
    extensions: [".gif"],
    magicNumbers: [0x47, 0x49, 0x46], // GIF signature
  },
  "image/webp": {
    extensions: [".webp"],
    magicNumbers: [0x52, 0x49, 0x46, 0x46], // WEBP signature
  },
  "image/bmp": {
    extensions: [".bmp"],
    magicNumbers: [0x42, 0x4d], // BMP signature
  },
};

// Allowed extensions list
const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
];

// Extensions that indicate a genuine double-extension spoofing attempt
// (e.g. "invoice.pdf.exe" or "photo.jpg.php") when they show up as an
// inner segment of the filename, ahead of the real extension.
const DANGEROUS_EXTENSIONS = [
  "exe", "php", "phtml", "js", "mjs", "sh", "bat", "cmd", "html", "htm",
  "jsp", "asp", "aspx", "dll", "msi", "vbs", "ps1", "svg", "jar", "com",
];

// Create uploads directory if it doesn't exist
const uploadsDir = "uploads/attachments";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Function to validate file signature (magic numbers)
const validateFileSignature = (filePath, expectedMimeType) => {
  return new Promise((resolve, reject) => {
    const expected = ALLOWED_FILE_TYPES[expectedMimeType];
    if (!expected || !expected.magicNumbers) {
      return resolve(true); // Skip if no magic numbers defined
    }

    const buffer = Buffer.alloc(expected.magicNumbers.length);
    fs.open(filePath, "r", (err, fd) => {
      if (err) {
        return reject(new Error("Unable to validate file content"));
      }

      fs.read(
        fd,
        buffer,
        0,
        expected.magicNumbers.length,
        0,
        (readErr, bytesRead) => {
          fs.close(fd, () => {});

          if (readErr) {
            return reject(new Error("Error reading file content"));
          }

          // Compare file signature with expected magic numbers
          for (let i = 0; i < expected.magicNumbers.length; i++) {
            if (buffer[i] !== expected.magicNumbers[i]) {
              return reject(
                new Error(
                  "File content does not match its type. Possible security risk",
                ),
              );
            }
          }
          resolve(true);
        },
      );
    });
  });
};

// Configure storage with safe filename generation
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate safe filename: timestamp + random number + original extension
    const ext = path.extname(file.originalname).toLowerCase();
    const sanitizedExt = ext.replace(/[^a-z0-9.]/g, "");
    const safeFilename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${sanitizedExt}`;
    cb(null, safeFilename);
  },
});

// Enhanced file filter with extension and MIME type validation
const fileFilter = (req, file, cb) => {
  console.log("File filter called");
  // Check if file exists
  if (!file) {
    return cb(new Error("No file uploaded"), false);
  }

  // Get file extension
  const fileExt = path.extname(file.originalname).toLowerCase();

  // Check if MIME type is allowed
  const isMimeAllowed = Object.keys(ALLOWED_FILE_TYPES).includes(file.mimetype);

  // Check if extension is allowed
  const isExtAllowed = ALLOWED_EXTENSIONS.includes(fileExt);

  // Check if extension matches MIME type
  let isMimeExtMatch = false;
  if (isMimeAllowed) {
    const allowedExts = ALLOWED_FILE_TYPES[file.mimetype].extensions;
    isMimeExtMatch = allowedExts.includes(fileExt);
  }

  // Additional security: Check for double extensions (e.g., .jpg.php).
  // Only flag genuine spoofing - a dangerous/allowed extension sitting
  // *before* the real one - not ordinary filenames that merely contain
  // extra dots (timestamps, version numbers, etc.).
  const nameSegments = file.originalname.split(".");
  if (nameSegments.length > 2) {
    const innerExtensions = nameSegments.slice(1, -1).map((seg) => seg.toLowerCase());
    const hasSpoofedExtension = innerExtensions.some(
      (ext) =>
        DANGEROUS_EXTENSIONS.includes(ext) ||
        ALLOWED_EXTENSIONS.includes(`.${ext}`),
    );
    if (hasSpoofedExtension) {
      return cb(
        new Error("Invalid file name: Double extensions are not allowed"),
        false,
      );
    }
  }

  // Check for malicious characters in filename
  const maliciousPatterns = /[<>:"|?*\\/]/g;
  if (maliciousPatterns.test(file.originalname)) {
    return cb(
      new Error("Invalid file name: Contains special characters"),
      false,
    );
  }

  if (isMimeAllowed && isExtAllowed && isMimeExtMatch) {
    cb(null, true);
  } else {
    let errorMessage = "Invalid file type. Only ";
    const allowedTypes = [];
    for (const [mime, config] of Object.entries(ALLOWED_FILE_TYPES)) {
      allowedTypes.push(config.extensions.join(", "));
    }
    errorMessage += `${allowedTypes.join(" and ")} files are allowed.`;
    cb(new Error(errorMessage), false);
  }
};

// Create multer instance with enhanced configuration
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
    files: 10, // Maximum number of files
    fieldSize: 10 * 1024 * 1024, // Max field size
  },
  fileFilter: fileFilter,
});

// Enhanced middleware wrapper with signature validation
const enhancedUpload = (req, res, next) => {
  const uploadHandler = upload.single("file"); // Change 'file' to your field name

  uploadHandler(req, res, async (err) => {
    if (err) {
      // Handle multer errors
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "File too large. Maximum size is 10MB",
        });
      }

      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          error: "Too many files uploaded",
        });
      }

      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          error: "Unexpected field name",
        });
      }

      // Handle validation errors
      return res.status(400).json({
        error: err.message || "File upload failed",
      });
    }

    // If file was uploaded, validate its signature
    if (req.file) {
      try {
        await validateFileSignature(req.file.path, req.file.mimetype);

        // Optional: Additional validation for images using sharp
        if (req.file.mimetype.startsWith("image/")) {
          try {
            const sharp = require("sharp");
            await sharp(req.file.path).metadata();
          } catch (sharpError) {
            // Delete invalid image file
            fs.unlink(req.file.path, (unlinkErr) => {
              if (unlinkErr)
                console.error("Error deleting invalid image:", unlinkErr);
            });
            return res.status(400).json({
              error: "Invalid or corrupted image file",
            });
          }
        }

        // Optional: PDF validation using pdf-parse
        if (req.file.mimetype === "application/pdf") {
          try {
            const pdfParse = require("pdf-parse");
            const dataBuffer = fs.readFileSync(req.file.path);
            await pdfParse(dataBuffer);
          } catch (pdfError) {
            // Delete invalid PDF file
            fs.unlink(req.file.path, (unlinkErr) => {
              if (unlinkErr)
                console.error("Error deleting invalid PDF:", unlinkErr);
            });
            return res.status(400).json({
              error: "Invalid or corrupted PDF file",
            });
          }
        }

        next();
      } catch (validationError) {
        // Delete the uploaded file if validation fails
        fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr)
            console.error("Error deleting invalid file:", unlinkErr);
        });
        return res.status(400).json({
          error: validationError.message || "File validation failed",
        });
      }
    } else {
      next();
    }
  });
};
// Export both the standard upload and enhanced middleware
module.exports = {
  upload,
  enhancedUpload,
  ALLOWED_FILE_TYPES,
  ALLOWED_EXTENSIONS,
};

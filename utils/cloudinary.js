const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const config = require("../config/config");

if (config.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
} else {
  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const uploadBufferToCloudinary = (buffer, { folder, resourceType = "auto", filename } = {}) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: !!filename,
        filename_override: filename,
        unique_filename: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });

const uploadFileToCloudinary = (filePath, options = {}) =>
  cloudinary.uploader.upload(filePath, {
    resource_type: "auto",
    unique_filename: true,
    ...options,
  });

const deleteFromCloudinary = async (publicId, resourceType = "image") => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (error) {
    console.error("Cloudinary delete failed:", error.message);
  }
};

module.exports = {
  cloudinary,
  uploadBufferToCloudinary,
  uploadFileToCloudinary,
  deleteFromCloudinary,
};

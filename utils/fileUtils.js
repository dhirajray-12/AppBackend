const Attachment = require('../models/Attachment');
const { uploadBufferToCloudinary, deleteFromCloudinary } = require('./cloudinary');

/**
 * Create an attachment record in the database
 * @param {Object} file - The uploaded file information (multer memoryStorage, has .buffer)
 * @param {String} userId - The ID of the user who uploaded the file
 * @returns {Promise<Object>} - The created attachment object
 */
exports.createAttachment = async (file, userId) => {
    const uploaded = await uploadBufferToCloudinary(file.buffer, {
        folder: 'ticket-attachments',
        resourceType: 'auto',
    });

    // Create attachment record
    const attachment = new Attachment({
        fileName: file.originalname,
        fileSize: file.size,
        fileType: file.mimetype,
        filePath: uploaded.secure_url,
        publicId: uploaded.public_id,
        uploadedBy: userId
    });

    await attachment.save();
    return attachment;
};

/**
 * Delete an attachment file and record
 * @param {String} attachmentId - The ID of the attachment to delete
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
exports.deleteAttachment = async (attachmentId) => {
    try {
        const attachment = await Attachment.findById(attachmentId);

        if (!attachment) {
            return false;
        }

        // Delete the file from Cloudinary
        await deleteFromCloudinary(attachment.publicId);

        // Delete the attachment record
        await Attachment.findByIdAndDelete(attachmentId);
        return true;
    } catch (error) {
        console.error('Error deleting attachment:', error);
        return false;
    }
};
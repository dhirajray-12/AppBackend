// backend/models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    ticketId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ticket',
        required: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    content: {
        type: String,
        required: [true, 'Message content is required']
    },
    attachments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Attachment'
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

MessageSchema.index({ ticketId: 1, createdAt: 1 });
MessageSchema.index({ sender: 1, createdAt: -1 });

const Message = mongoose.model('Message', MessageSchema);
module.exports = Message;

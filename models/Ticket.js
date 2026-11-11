// backend/models/Ticket.js
const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    ticketNumber: {
        type: String,
        required: true,
        unique: true
    },
    subject: {
        type: String,
        required: [true, 'Subject is required']
    },
    description: {
        type: String,
        required: [true, 'Description is required']
    },
    status: {
        type: String,
        enum: ['new', 'open', 'inProgress', 'resolved', 'closed'],
        default: 'new'
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'medium'
    },
    category: {
        type: String,
        required: [true, 'Category is required']
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    attachments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Attachment'
    }],
    messages: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    }],
    closedAt: {
        type: Date
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Update the updatedAt field on save
TicketSchema.pre('save', function (next) {
    // Only update the timestamp for existing documents
    if (!this.isNew) {
        this.updatedAt = Date.now();
    }
    next();
});

TicketSchema.index({ createdBy: 1, updatedAt: -1 });
TicketSchema.index({ assignedTo: 1, updatedAt: -1 });
TicketSchema.index({ status: 1, updatedAt: -1 });
TicketSchema.index({ category: 1, updatedAt: -1 });

const Ticket = mongoose.model('Ticket', TicketSchema);
module.exports = Ticket;

// Backend/models/Copy.js
const mongoose = require('mongoose');

const CopySchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    accounts: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Account',
        required: true
    }],
    copyType: {
        type: String,
        enum: ['Master', 'Copier'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected'],
        default: 'pending'
    },
    reason: {
        type: String,
        default: null
    },
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    processedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Index for better query performance
CopySchema.index({ user: 1, createdAt: -1 });
CopySchema.index({ status: 1, createdAt: -1 });
CopySchema.index({ accounts: 1 });

module.exports = mongoose.model('Copy', CopySchema);
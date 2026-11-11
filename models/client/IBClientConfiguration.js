// backend/models/client/IBClientConfiguration.js
const mongoose = require('mongoose');

const IBClientConfigurationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    referralCode: {
        type: String,
        default: null,
        // unique: true,
        // sparse: true // Allows null values while maintaining uniqueness for non-null values
    },
    referredBy: {
        type: String,
        default: null
    },
    IBbalance: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'inactive'],
        default: 'pending'
    },
    level: {
        type: Number,
        default: 0
    },
    parent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'IBClientConfiguration',
        default: null
    },
    // Maximum commission per lot this IB may distribute to direct referrals.
    // null = not yet assigned (root awaiting admin, non-root awaiting parent).
    maximumCommission: {
        type: Number,
        default: null,
        min: 0
    },
    // Only set on root nodes (parent === null): which group's ceiling the
    // admin used when assigning this IB's maximumCommission.
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        default: null
    }
}, {
    timestamps: true // Automatically adds createdAt and updatedAt
});

// Add indexes for better performance
IBClientConfigurationSchema.index({ parent: 1 });
IBClientConfigurationSchema.index({ parent: 1, status: 1 });
IBClientConfigurationSchema.index({ referralCode: 1 }, { sparse: true });
IBClientConfigurationSchema.index({ referredBy: 1 });
IBClientConfigurationSchema.index({ status: 1 });
IBClientConfigurationSchema.index({ status: 1, createdAt: -1 });
IBClientConfigurationSchema.index({ level: 1 });

const IBClientConfiguration = mongoose.model('IBClientConfiguration', IBClientConfigurationSchema);

module.exports = IBClientConfiguration;

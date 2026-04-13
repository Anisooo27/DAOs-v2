const mongoose = require('mongoose');

const proposalSchema = new mongoose.Schema({
  proposalId: {
    type: String,
    required: true,
    unique: true,
  },
  // Human-readable alias, e.g. "P-001". Auto-generated on create.
  shortId: {
    type: String,
    unique: true,
    sparse: true,
  },
  proposerAddress: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  target: {
    type: String,
    required: true,
  },
  value: {
    type: String,
    required: true,
  },
  calldata: {
    type: String,
    required: true,
  },
  recipient: {
    type: String,
    required: false,
  },
  amount: {
    type: String,
    required: false,
  },
  signature: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'SUCCEEDED', 'QUEUED', 'EXECUTED'],
    default: 'ACTIVE',
  }
});

module.exports = mongoose.model('Proposal', proposalSchema);

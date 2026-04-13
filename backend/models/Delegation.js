const mongoose = require('mongoose');

const delegationSchema = new mongoose.Schema({
  delegatorAddress: {
    type: String,
    required: true,
  },
  delegateeAddress: {
    type: String,
    required: true,
  },
  signature: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Delegation', delegationSchema);

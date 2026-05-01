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
    required: false,
    default: '0x0000000000000000000000000000000000000000',
  },
  value: {
    type: String,
    required: false,
    default: '0',
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
    // DEFEATED added: majority voted Against, or quorum not met
    enum: ['ACTIVE', 'SUCCEEDED', 'QUEUED', 'EXECUTED', 'DEFEATED'],
    default: 'ACTIVE',
  },
  // 'withdraw' = Treasury → Wallet (withdrawETH calldata, value=0)
  // 'deposit'  = Wallet  → Treasury (empty calldata, value=amountWei)
  // 'custom'   = raw calldata + value set by user
  direction: {
    type: String,
    // 'general'  = arbitrary governance action (description + calldata only)
    // 'withdraw' = Treasury -> Wallet (withdrawETH calldata, value=0)
    // 'deposit'  = Wallet  -> Treasury (empty calldata, value=amountWei)
    // 'custom'   = raw calldata + value set by user (legacy)
    enum: ['general', 'withdraw', 'deposit', 'custom'],
    default: 'general',
  },
  // Attached by the deposit event poller when a Deposit(from, amount) event
  // is seen on-chain. Stored even if the proposal was already EXECUTED so the
  // poller can reconcile without emitting false "no match" warnings.
  executionEvent: {
    type: {
      txHash:    { type: String },
      blockNumber: { type: Number },
      from:      { type: String },
      to:        { type: String },
      amountEth: { type: String },
      timestamp: { type: Date, default: Date.now }
    },
    required: false,
    default: undefined,
  }
});

module.exports = mongoose.model('Proposal', proposalSchema);

const mongoose = require('mongoose');

const voteSchema = new mongoose.Schema({
  proposalId: { type: String, required: true },
  voter:      { type: String, required: true },

  // Raw choice stored for compat (0=Against, 1=For, 2=Abstain)
  // In a full ZKP system this would be omitted — only the commitment is stored.
  choice: { type: Number, required: true },

  // ─── Cryptographic Proof Fields (ZKP-Architecture) ───────────────────────
  //
  // commitment  : keccak256(abi.encodePacked(choice, secret, proposalId))
  //               Binds the voter to their choice without revealing it to observers.
  //
  // nullifier   : keccak256(abi.encodePacked(voter, proposalId))
  //               Unique per (voter, proposal) pair — prevents double-voting.
  //               Stored as the unique index, not the raw voter address.
  //
  // signature   : MetaMask sign(commitment + proposalId)
  //               Proves the voter created this specific commitment.
  //
  // zkProofVersion : tag for future upgrade to real snarkjs proofs
  // ─────────────────────────────────────────────────────────────────────────
  commitment:     { type: String, required: false },  // hex hash
  nullifier:      { type: String, required: false },  // hex hash (unique per voter+proposal)
  signature:      { type: String, required: true  },  // MetaMask signature

  // Populated only during reveal phase (or in demo mode where relayer needs choice)
  secret:         { type: String, required: false },

  // Protocol version tag — 'v0-commit-reveal' now, 'v1-zk-snark' when circuit is ready
  zkProofVersion: { type: String, default: 'v0-commit-reveal' },

}, { timestamps: true });

// Unique index: one vote per (proposalId, voter)
voteSchema.index({ proposalId: 1, voter: 1 }, { unique: true });

// Also unique on nullifier so the DB enforces no double-spend even without voter address
voteSchema.index({ nullifier: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Vote', voteSchema);

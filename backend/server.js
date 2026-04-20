require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { ethers } = require('ethers');
const Vote = require('./models/Vote');
const Delegation = require('./models/Delegation');
const Proposal = require('./models/Proposal');
const { exec } = require('child_process');
const path = require('path');
const {
  GOVERNOR_ABI,
  GOVERNOR_ADDRESS,
  TREASURY_ADDRESS,
  RPC_URL,
  PRIVATE_KEY,
  isConfigured
} = require('./config/contractConfig');

// Helper: always read fresh addresses from deployedAddresses.json
const fs = require('fs');
const ADDRESSES_PATH = path.join(__dirname, 'config', 'deployedAddresses.json');

function getAddresses() {
  try {
    if (fs.existsSync(ADDRESSES_PATH)) {
      return JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[config] Could not read deployedAddresses.json:', e.message);
  }
  // Fallback to env vars loaded at startup
  return { governorAddress: GOVERNOR_ADDRESS, treasuryAddress: TREASURY_ADDRESS };
}

const app = express();
app.use(express.json());

// Enhanced CORS for production
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/config/contract', (req, res) => {
  const addrs = getAddresses();
  res.json({ 
    governorAddress: addrs.governorAddress,
    treasuryAddress: addrs.treasuryAddress,
    tokenAddress: addrs.tokenAddress
  });
});

// GET /delegation/:address — full status: MongoDB + on-chain votes + GOV balance
app.get('/delegation/:address', async (req, res) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    // 1. MongoDB record (off-chain proof used for UI gating)
    const delegation = await Delegation.findOne({ delegatorAddress: address.toLowerCase() });

    // 2. On-chain data — authoritative source for proposer check
    let onChainVotes     = '0';
    let govBalance       = '0';
    let onChainVotesBigInt = 0n;

    try {
      const addrs = getAddresses();
      if (addrs.tokenAddress) {
        const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
        const TOKEN_ABI = [
          'function getVotes(address account) view returns (uint256)',
          'function balanceOf(address account) view returns (uint256)'
        ];
        const tokenContract = new ethers.Contract(addrs.tokenAddress, TOKEN_ABI, rpcProvider);
        const [votes, balance] = await Promise.all([
          tokenContract.getVotes(address),
          tokenContract.balanceOf(address)
        ]);
        onChainVotesBigInt = votes;
        onChainVotes = votes.toString();
        govBalance   = balance.toString();
      }
    } catch (chainErr) {
      console.warn(`[delegation] on-chain query failed for ${address}:`, chainErr.message);
    }

    return res.json({
      // MongoDB
      delegated:         !!delegation,
      mongoRecordExists: !!delegation,
      delegatee:         delegation ? delegation.delegateeAddress : null,
      // On-chain
      govBalance,
      onChainVotes,
      hasVotingPower:    onChainVotesBigInt > 0n
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


// POST /admin/setup-voter — dev helper: transfer GOV tokens from relayer/deployer to target.
// ⚠️  RESTRICTED to localhost/loopback — never accessible from external IPs.
app.post('/admin/setup-voter', async (req, res) => {
  // Guard: only allow from loopback
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'This endpoint is only available on localhost.' });
  }

  try {
    const { targetAddress, amount } = req.body;
    if (!ethers.isAddress(targetAddress)) {
      return res.status(400).json({ error: 'Invalid targetAddress' });
    }
    const addrs = getAddresses();
    if (!addrs.tokenAddress) {
      return res.status(500).json({ error: 'tokenAddress not configured in deployedAddresses.json' });
    }
    if (!PRIVATE_KEY) {
      return res.status(500).json({ error: 'PRIVATE_KEY not set in backend/.env — needed to sign the transfer tx.' });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(PRIVATE_KEY, provider);

    const TOKEN_ABI = [
      'function balanceOf(address account) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'function getVotes(address account) view returns (uint256)',
    ];
    const token = new ethers.Contract(addrs.tokenAddress, TOKEN_ABI, deployer);

    const amountWei = ethers.parseEther(amount || '1000');
    const deployerBalance = await token.balanceOf(deployer.address);

    if (deployerBalance < amountWei) {
      return res.status(400).json({
        error: `Deployer only has ${ethers.formatEther(deployerBalance)} GOV. Reduce amount or redeploy.`
      });
    }

    // Transfer tokens
    const transferTx = await token.transfer(targetAddress, amountWei);
    await transferTx.wait();
    console.log(`[admin/setup-voter] Transferred ${amount || '1000'} GOV to ${targetAddress}. Tx: ${transferTx.hash}`);

    const targetBalance = await token.balanceOf(targetAddress);
    const targetVotes   = await token.getVotes(targetAddress);

    return res.json({
      success: true,
      transferred: ethers.formatEther(amountWei),
      targetBalance: ethers.formatEther(targetBalance),
      onChainVotes: ethers.formatEther(targetVotes),
      transferTx: transferTx.hash,
      note: 'Tokens transferred. The target wallet must now call delegate() from the DAO Delegate Votes page.'
    });
  } catch (err) {
    console.error('[admin/setup-voter] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// AUTO-LIFECYCLE: immediately advance proposal to Succeeded state in background.
// Called right after a proposal is saved to DB, so the 50-block voting window
// doesn't expire before the user can interact with the UI.
// ─────────────────────────────────────────────────────────────────────────────
async function autoAdvanceToSucceeded(proposalId) {
  // Serialize through the mutex — cannot race with /submit or /execute
  return withSignerLock(async () => {
    try {
      const { provider, signer, governor } = await getGovernorSigner();
      const votingDelay  = Number(await governor.votingDelay());
      const votingPeriod = Number(await governor.votingPeriod());
      const nm = await new NonceManager(provider, signer.address).init();

      let state = Number(await governor['state(uint256)'](proposalId));
      console.log(`[auto-tally] ${proposalId.slice(0,10)}... state: ${state} (${stateLabel(state)})`);

      // ── Guard: ensure signer has voting power before we try to vote ────────
      // GovernorVotes uses checkpoints — if setupVoter.js wasn't run after a
      // fresh Hardhat node start, getVotes(signer) = 0 and every vote counts
      // as 0 weight, causing Defeated even with quorum=0%.  Auto-delegate here
      // so the relayer always has enough weight regardless of manual setup.
      const addrs = getAddresses();
      const TOKEN_ABI = [
        'function getVotes(address account) external view returns (uint256)',
        'function delegate(address delegatee) external'
      ];
      if (addrs.tokenAddress) {
        const tokenContract = new ethers.Contract(addrs.tokenAddress, TOKEN_ABI, signer);
        const currentVotes = await tokenContract.getVotes(signer.address);
        if (currentVotes === 0n) {
          console.log(`[auto-tally] Signer has 0 votes — auto-delegating to self...`);
          const delTx = await tokenContract.delegate(signer.address, { nonce: nm.consume() });
          await delTx.wait();
          console.log(`[auto-tally] Delegation tx: ${delTx.hash}`);
          // Re-init nonce since a tx was sent outside nm.sendTx
          await nm.init();
        } else {
          console.log(`[auto-tally] Signer votes: ${ethers.formatEther(currentVotes)} GOV`);
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      // Pending → Active
      if (state === 0) {
        await mineBlocks(provider, votingDelay + 1);
        state = Number(await governor['state(uint256)'](proposalId));
        console.log(`[auto-tally] After delay mine: ${state} (${stateLabel(state)})`);
      }

      if (state !== 1) {
        console.warn(`[auto-tally] Expected Active (1), got ${state}. Aborting.`);
        return;
      }

      // Cast on-chain vote — nonce tracked by NonceManager
      const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
      if (!alreadyVoted) {
        const { tx } = await nm.sendTx(governor, 'castVoteWithReason', [proposalId, 1, 'Auto-relayer: for']);
        console.log(`[auto-tally] Vote cast. Tx: ${tx.hash}`);
      } else {
        console.log(`[auto-tally] Already voted.`);
      }

      // Mine past voting period → Succeeded
      await mineBlocks(provider, votingPeriod + 1);
      state = Number(await governor['state(uint256)'](proposalId));
      console.log(`[auto-tally] After period mine: ${state} (${stateLabel(state)})`);

      if (state === 4) {
        await Proposal.findOneAndUpdate({ proposalId }, { status: 'SUCCEEDED' }).catch(() => {});
        console.log(`[auto-tally] ✅ ${proposalId.slice(0,10)}... SUCCEEDED.`);
      } else {
        console.warn(`[auto-tally] ⚠️ Expected Succeeded (4), got ${state}.`);
      }
    } catch (e) {
      console.error(`[auto-tally] Error:`, e.reason || e.message);
    }
  });
}

// 0. POST /delegate
app.post('/delegate', async (req, res) => {
  try {
    const { delegatorAddress, delegateeAddress, signature } = req.body;
    if (!delegatorAddress || !delegateeAddress || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const message = `Delegate votes to ${delegateeAddress}`;
    const signerAddress = ethers.verifyMessage(message, signature);
    if (signerAddress.toLowerCase() !== delegatorAddress.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const newDelegation = new Delegation({
      delegatorAddress: delegatorAddress.toLowerCase(),
      delegateeAddress: delegateeAddress.toLowerCase(),
      signature
    });
    await newDelegation.save();
    return res.status(201).json({ message: 'Delegation recorded successfully' });
  } catch (error) {
    console.error('Error saving delegation:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 0.5 POST /propose
app.post('/propose', async (req, res) => {
  try {
    const { proposalId, proposerAddress, description, target, value, calldata, recipient, amount, signature, direction } = req.body;
    if (!proposalId || !proposerAddress || !description || !target || value === undefined || !calldata || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const message = JSON.stringify({
      proposalDescription: description,
      targetContract: target,
      value: value.toString(),
      calldata: calldata
    });
    const signerAddress = ethers.verifyMessage(message, signature);
    if (signerAddress.toLowerCase() !== proposerAddress.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── Address normalization ─────────────────────────────────────────────────
    // Use ethers.getAddress() (EIP-55 checksum) before all comparisons/lookups
    // to prevent mixed-case mismatches in MongoDB.
    let normalizedProposer, normalizedTarget, normalizedRecipient;
    try {
      normalizedProposer = ethers.getAddress(proposerAddress);
      normalizedTarget   = ethers.getAddress(target);
      normalizedRecipient = recipient && ethers.isAddress(recipient) ? ethers.getAddress(recipient) : null;
    } catch (addrErr) {
      return res.status(400).json({ error: `Invalid address: ${addrErr.message}` });
    }

    // ── Rule 1: Proposer MUST have a MongoDB delegation record ───────────────
    const proposerDelegation = await Delegation.findOne({
      delegatorAddress: normalizedProposer.toLowerCase()
    });
    if (!proposerDelegation) {
      console.warn(`[propose] ❌ Proposer ${normalizedProposer} — no MongoDB delegation record`);
      return res.status(403).json({ error: 'Proposer has not delegated votes. Go to the Delegate Votes page first.' });
    }

    // ── Rule 2: Proposer MUST have on-chain voting power ─────────────────────
    try {
      const addrs = getAddresses();
      if (addrs.tokenAddress) {
        const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
        const tokenContract = new ethers.Contract(addrs.tokenAddress, [
          'function getVotes(address account) view returns (uint256)'
        ], rpcProvider);
        const onChainVotes = await tokenContract.getVotes(normalizedProposer);
        if (onChainVotes === 0n) {
          console.warn(`[propose] ❌ Proposer ${normalizedProposer} — MongoDB record exists but on-chain votes = 0`);
          return res.status(403).json({
            error: 'Proposer has a delegation record but 0 on-chain votes. Re-delegate via the Delegate Votes page.'
          });
        }
        console.log(`[propose] ✅ Proposer ${normalizedProposer} — delegation verified (on-chain votes: ${onChainVotes.toString()})`);
      } else {
        console.warn('[propose] tokenAddress not configured — skipping on-chain votes check');
      }
    } catch (chainErr) {
      // Non-fatal: log and continue (don't block if RPC is unavailable)
      console.warn(`[propose] on-chain votes check failed (non-fatal):`, chainErr.message);
    }

    // ── Rule 3: Recipient validation — NO delegation required ────────────────
    // Any valid Ethereum address may receive funds. Treasury, EOAs, and other
    // contracts are all accepted. We log for audit but never block on this.
    if (normalizedRecipient) {
      const recipientDelegation = await Delegation.findOne({
        delegatorAddress: normalizedRecipient.toLowerCase()
      });
      console.log(
        `[propose] ℹ️  Recipient ${normalizedRecipient} — delegation record: ${!!recipientDelegation} (informational only, not blocking)`
      );
    }

    const addrs = getAddresses();
    const treasuryAddr = addrs.treasuryAddress || process.env.TREASURY_ADDRESS;
    console.log(
      `[propose] ✅ All checks passed — target: ${normalizedTarget}` +
      (treasuryAddr && normalizedTarget.toLowerCase() === treasuryAddr.toLowerCase() ? ' [Treasury — exempt from delegation check]' : '')
    );

    // Generate P-001 style short ID: count existing proposals + 1
    const count = await Proposal.countDocuments();
    const shortId = `P-${String(count + 1).padStart(3, '0')}`;

    // Normalize calldata to 0x-prefix — Governor encodedCalldata always starts with 0x.
    // Storing without it would cause keccak256(targets,values,calldatas,descHash) ≠ proposalId
    const normalizedSaveCalldata = calldata && !calldata.startsWith('0x')
      ? '0x' + calldata
      : (calldata || '0x');

    const newProposal = new Proposal({
      proposalId,
      shortId,
      proposerAddress: proposerAddress.toLowerCase(),
      description,
      target,
      value: value.toString(),
      calldata: normalizedSaveCalldata,
      recipient,
      amount,
      signature,
      direction: direction || 'withdraw',
    });
    await newProposal.save();
    console.log(`[propose] Saved proposal ${shortId} (${proposalId.slice(0,10)}...). Triggering auto-tally.`);

    setImmediate(() => autoAdvanceToSucceeded(proposalId));

    return res.status(201).json({ success: true, proposalId, shortId, autoTally: true });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Proposal exists' });
    console.error('Error creating proposal:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 1. POST /vote  — commit-reveal scheme with nullifier-based double-vote prevention
// ─────────────────────────────────────────────────────────────────────────────
// Expected body:
//   proposalId  : full on-chain proposal ID
//   voter       : voter's Ethereum address
//   choice      : 0 (Against) | 1 (For) | 2 (Abstain)
//   commitment  : keccak256(choice + secret + proposalId)  — hex string
//   nullifier   : keccak256(voter + proposalId)            — hex string
//   secret      : random hex string generated client-side
//   signature   : MetaMask sign(commitment + "|" + proposalId)
//
// In a full ZKP system (v1), the circuit proves:
//   - knowledge of secret s.t. commitment = keccak256(choice||secret||proposalId)
//   - choice ∈ {0,1,2}
//   - nullifier = keccak256(voter||proposalId)  (derived from private key, not address)
// Without revealing choice to anyone.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/vote', async (req, res) => {
  try {
    const { proposalId, voter, choice, commitment, nullifier, secret, signature } = req.body;
    if (!proposalId || !voter || choice === undefined || !signature) {
      return res.status(400).json({ error: 'Missing required fields: proposalId, voter, choice, signature' });
    }

    const voterLower = voter.toLowerCase();

    // ── Verification Layer 1: Signature ─────────────────────────────────────
    // The voter signs the commitment (or falls back to signing a plain message
    // for backwards-compat if no commitment is provided).
    const signedMessage = commitment
      ? `${commitment}|${proposalId}`
      : `Vote ${choice} on proposal ${proposalId}`;

    const recovered = ethers.verifyMessage(signedMessage, signature);
    if (recovered.toLowerCase() !== voterLower) {
      return res.status(401).json({ error: 'Signature verification failed — signed message does not match voter address.' });
    }

    // Delegation validation: Voter MUST be delegated
    const voterDelegation = await Delegation.findOne({ delegatorAddress: voterLower });
    if (!voterDelegation) {
      return res.status(403).json({ error: 'Voter has not delegated votes' });
    }

    // ── Verification Layer 2: Commitment Integrity ───────────────────────────
    // Re-derive commitment server-side and confirm it matches what the client sent.
    // This proves the voter committed to the exact (choice, secret, proposalId) triple.
    if (commitment && secret) {
      const expectedCommitment = ethers.keccak256(
        ethers.toUtf8Bytes(`${choice}|${secret}|${proposalId}`)
      );
      if (expectedCommitment !== commitment) {
        return res.status(400).json({ error: 'Commitment verification failed — commitment does not match keccak256(choice|secret|proposalId).' });
      }
    }

    // ── Verification Layer 3: Nullifier (ALWAYS enforced) ─────────────────
    // Server ALWAYS derives: canonicalNullifier = keccak256(voter|proposalId).
    // Secret is intentionally excluded from the nullifier — nullifier must be
    // deterministic per (voter, proposal) regardless of any secret regeneration.
    // Changing the secret cannot create a new nullifier, so one account = one vote.
    const canonicalNullifier = ethers.keccak256(
      ethers.toUtf8Bytes(`${voterLower}|${proposalId}`)
    );

    // If the client sent a nullifier, it must match the server-derived one.
    if (nullifier && nullifier !== canonicalNullifier) {
      return res.status(400).json({
        error: 'Nullifier mismatch — must equal keccak256(voter|proposalId). Secret must NOT be included in the nullifier.'
      });
    }

    // UNCONDITIONAL double-vote check — runs regardless of whether the client
    // sent a nullifier field. Catches all cases including legacy requests.
    const alreadyVoted = await Vote.findOne({ proposalId, voter: voterLower });
    if (alreadyVoted) {
      console.warn(`[vote] ⛔ Duplicate attempt: ${voterLower.slice(0,10)}... proposal=${proposalId.slice(0,10)}...`);
      return res.status(409).json({ error: 'Already voted — each address may only vote once per proposal.' });
    }

    // ── Store verified vote ──────────────────────────────────────────────────
    // Always store the server-derived canonicalNullifier — never the raw client value.
    const newVote = new Vote({
      proposalId,
      voter:          voterLower,
      choice:         Number(choice),
      commitment:     commitment || null,
      nullifier:      canonicalNullifier,
      secret:         secret     || null,
      signature,
      zkProofVersion: commitment ? 'v0-commit-reveal' : 'v0-legacy'
    });
    await newVote.save();

    const proofLabel = commitment ? '🔒 commit-reveal' : '📝 legacy';
    console.log(`[vote] ${proofLabel} recorded — ${voterLower.slice(0,10)}... choice=${choice} nullifier=${canonicalNullifier.slice(0,12)}... proposal=${proposalId.slice(0,10)}...`);

    return res.status(201).json({
      message: 'Vote recorded',
      secured: !!commitment,
      vote: newVote
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Already voted — duplicate nullifier rejected by database.' });
    return res.status(500).json({ error: error.message });
  }
});

// 2. GET /proposals
app.get('/proposals', async (req, res) => {
  try {
    const proposals = await Proposal.aggregate([
      { $lookup: { from: 'votes', localField: 'proposalId', foreignField: 'proposalId', as: 'votes' } },
      { $project: { proposalId: 1, shortId: 1, proposerAddress: 1, description: 1, target: 1, value: 1, calldata: 1, timestamp: 1, status: 1, recipient: 1, amount: 1, votes: { choice: 1, zkProofVersion: 1 } } },
      { $sort: { timestamp: -1 } }
    ]);
    const formatted = proposals.map(p => {
      const tally = { '0': 0, '1': 0, '2': 0 };
      let securedVotes = 0;
      if (p.votes) p.votes.forEach(v => {
        if (tally[v.choice] !== undefined) tally[v.choice]++;
        if (v.zkProofVersion && v.zkProofVersion !== 'v0-legacy') securedVotes++;
      });
      return { ...p, results: tally, status: p.status || 'ACTIVE', securedVotes };
    });
    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. Status Update (called by scripts)
app.patch('/proposals/:proposalId/status', async (req, res) => {
  try {
    const { proposalId } = req.params;
    const { status } = req.body;
    const proposal = await Proposal.findOneAndUpdate({ proposalId }, { status }, { new: true });
    if (!proposal) return res.status(404).json({ error: 'Not found' });
    console.log(`[db] ${proposalId} -> ${status}`);
    res.json({ success: true, proposal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full ABI needed for lifecycle management
const EXEC_GOVERNOR_ABI = [
  "function state(uint256 proposalId) public view returns (uint8)",
  "function votingDelay() public view returns (uint256)",
  "function votingPeriod() public view returns (uint256)",
  "function hasVoted(uint256 proposalId, address account) public view returns (bool)",
  "function castVoteWithReason(uint256 proposalId, uint8 support, string reason) public returns (uint256)",
  "function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256)",
  "function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public payable returns (uint256)"
];

function stateLabel(s) {
  return ['Pending','Active','Canceled','Defeated','Succeeded','Queued','Expired','Executed'][s] ?? `Unknown(${s})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNER SINGLETON + TRANSACTION MUTEX
// All on-chain writes must go through `withSignerLock()` to prevent concurrent
// transactions from the same private key causing "Nonce too low" errors.
// ─────────────────────────────────────────────────────────────────────────────
let _signerInstance = null;

function getSharedSigner() {
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY not set in backend/.env');
  if (!_signerInstance) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    _signerInstance = new ethers.Wallet(PRIVATE_KEY, provider);
  }
  return _signerInstance;
}

// Promise chain that ensures transactions execute one at a time
let _txLock = Promise.resolve();

function withSignerLock(fn) {
  const next = _txLock.then(fn, fn); // always advance the chain, even on error
  _txLock = next.catch(() => {});    // don't let errors stall the queue
  return next;
}

async function getGovernorSigner() {
  const addrs = getAddresses();
  if (!addrs.governorAddress) throw new Error('governorAddress not found. Redeploy contracts.');
  const signer   = getSharedSigner();
  const provider = signer.provider;
  const governor = new ethers.Contract(addrs.governorAddress, EXEC_GOVERNOR_ABI, signer);
  return { provider, signer, governor, addrs };
}

// ─────────────────────────────────────────────────────────────────────────────
// NonceManager: fetch nonce ONCE per locked section, then track manually.
// This prevents Hardhat's automining from racing between consecutive txs
// (e.g. queue → increaseTime → execute) where re-querying the pending nonce
// can return a stale value mid-sequence.
// ─────────────────────────────────────────────────────────────────────────────
class NonceManager {
  constructor(provider, address) {
    this.provider = provider;
    this.address  = address;
    this._nonce   = null;
  }

  async init() {
    // Brief settle delay: Hardhat automining can still be processing the previous
    // block when we re-enter a new lock section. Waiting 200ms ensures the
    // mining completes and the pending nonce correctly reflects all confirmed txs.
    await new Promise(r => setTimeout(r, 200));
    // Use 'pending' to capture any in-mempool txs the node knows about.
    this._nonce = await this.provider.getTransactionCount(this.address, 'pending');
    return this;
  }

  current() {
    if (this._nonce === null) throw new Error('NonceManager not initialized — call init() first');
    return this._nonce;
  }

  consume() {
    const n = this.current();
    this._nonce++;
    return n;
  }

  async refresh() {
    // Re-fetch nonce from chain (used after NONCE_EXPIRED errors)
    await new Promise(r => setTimeout(r, 300));
    this._nonce = await this.provider.getTransactionCount(this.address, 'pending');
    return this;
  }

  async sendTx(contract, method, args, overrides = {}) {
    let nonce = this.consume();
    console.log(`  [nonce] ${method}() nonce=${nonce}`);
    try {
      const tx      = await contract[method](...args, { nonce, ...overrides });
      const receipt = await tx.wait();
      return { tx, receipt };
    } catch (err) {
      // NONCE_EXPIRED: re-fetch from chain and retry ONCE
      if (err.code === 'NONCE_EXPIRED' || err.message?.includes('Nonce too low') || err.message?.includes('nonce too low')) {
        console.warn(`  [nonce] NONCE_EXPIRED for ${method}() — refreshing and retrying...`);
        await this.refresh();
        nonce = this.consume();
        console.log(`  [nonce] Retry ${method}() nonce=${nonce}`);
        const tx      = await contract[method](...args, { nonce, ...overrides });
        const receipt = await tx.wait();
        return { tx, receipt };
      }
      throw err;
    }
  }
}

async function mineBlocks(provider, n) {
  await provider.send('hardhat_mine', ['0x' + n.toString(16)]);
}

async function increaseTime(provider, seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// 4. POST /submit/:proposalId — push tally on-chain
app.post('/submit/:proposalId', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { proposalId } = req.params;
  console.log(`\n[pushTally] Starting for proposal ${proposalId}`);

  try {
    const result = await withSignerLock(async () => {
      const { provider, signer, governor } = await getGovernorSigner();
      const votingDelay  = Number(await governor.votingDelay());
      const votingPeriod = Number(await governor.votingPeriod());
      const log = [];

      let state = Number(await governor['state(uint256)'](proposalId));
      log.push(`Initial state: ${state} (${stateLabel(state)})`);
      console.log(`[pushTally] ${log[log.length - 1]}`);

      if (state === 0) {
        await mineBlocks(provider, votingDelay + 1);
        state = Number(await governor['state(uint256)'](proposalId));
        log.push(`State → ${state} (${stateLabel(state)})`);
        console.log(`[pushTally] ${log[log.length - 1]}`);
      }

      // State 4 (Succeeded) means autoAdvanceToSucceeded already ran —
      // treat as success so the UI can move straight to Queue & Execute.
      if (state === 4) {
        log.push('Proposal already Succeeded — tally was pushed automatically.');
        console.log('[pushTally] Already Succeeded — short-circuit.');
        await Proposal.findOneAndUpdate({ proposalId }, { status: 'SUCCEEDED' }).catch(() => {});
        return { state, stateLabel: stateLabel(state), log, alreadySucceeded: true };
      }

      if (state !== 1) {
        const msg = `Cannot push tally: proposal is ${stateLabel(state)} (${state}).`;
        throw Object.assign(new Error(msg), { state, userError: true });
      }

      const nm = await new NonceManager(provider, signer.address).init();

      const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
      if (!alreadyVoted) {
        log.push('Casting "For" vote on-chain...');
        const { tx } = await nm.sendTx(governor, 'castVoteWithReason', [proposalId, 1, 'Relayer: for']);
        log.push(`Vote cast. Tx: ${tx.hash}`);
        console.log(`[pushTally] Vote tx: ${tx.hash}`);
      } else {
        log.push('Already voted on-chain.');
      }

      await mineBlocks(provider, votingPeriod + 1);
      state = Number(await governor['state(uint256)'](proposalId));
      log.push(`Governor state: ${state} (${stateLabel(state)})`);
      console.log(`[pushTally] ${log[log.length - 1]}`);

      if (state === 4) {
        await Proposal.findOneAndUpdate({ proposalId }, { status: 'SUCCEEDED' }).catch(() => {});
        log.push('✅ Proposal Succeeded!');
      } else {
        log.push(`⚠️ Expected Succeeded (4), got ${state}.`);
      }
      return { state, stateLabel: stateLabel(state), log };
    });

    return res.json({ success: result.state === 4, ...result });
  } catch (e) {
    console.error('[pushTally] Error:', e.message);
    const code = e.userError ? 400 : 500;
    return res.status(code).json({ error: e.message, state: e.state });
  }
});

// 5. POST /execute/:proposalId — queue + time-advance + execute
app.post('/execute/:proposalId', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { proposalId } = req.params;
  console.log(`\n[execute] Starting for proposal ${proposalId}`);

  try {
    const dbProposal = await Proposal.findOne({ proposalId });
    if (!dbProposal) return res.status(404).json({ error: 'Proposal not found in DB' });

    const result = await withSignerLock(async () => {
      const { provider, signer, governor } = await getGovernorSigner();
      const { description, target, value, calldata, recipient, direction } = dbProposal;
      const descriptionHash = ethers.id(description);
      const isDeposit = direction === 'deposit';
      const log = [];

      // ── Normalize calldata ──────────────────────────────────────────────────
      // The DB may store calldata without '0x' prefix (frontend strips it or
      // the ABI encoder omits it). The Governor computes its proposalId from
      // keccak256(targets, values, calldatas, descHash) — so calldatas must
      // exactly match what was passed to propose(). Normalize to 0x-prefixed.
      const normalizedCalldata = calldata && !calldata.startsWith('0x')
        ? '0x' + calldata
        : (calldata || '0x');

      // ── Resolve ETH value ──────────────────────────────────────────────────
      // The Governor encodes (targets, [value_in_wei], calldatas, descHash).
      // If the DB stores the raw wei string (e.g. "1000000000000000000") we use
      // it directly. If it looks like a small decimal (e.g. "1" meaning 1 ETH)
      // we parseEther. Anything else defaults to 0.
      let proposalValue = 0n;
      try {
        if (value && value !== '0') {
          // If length > 10 chars it's almost certainly already in wei
          proposalValue = String(value).length > 10
            ? BigInt(value)
            : ethers.parseEther(String(value));
        }
      } catch { proposalValue = 0n; }
      log.push(`Proposal value: ${proposalValue.toString()} wei`);
      log.push(`Calldata: ${normalizedCalldata.slice(0, 20)}...`);
      console.log(`[execute] target=${target} value=${proposalValue} calldata=${normalizedCalldata.slice(0,18)}...`);


      // Single NonceManager for the entire queue→execute sequence
      // Nonce is fetched ONCE and incremented manually — never re-queried.
      const nm = await new NonceManager(provider, signer.address).init();
      console.log(`  [nonce] Starting execute sequence at nonce=${nm.current()}`);

      const votingDelay  = Number(await governor.votingDelay());
      const votingPeriod = Number(await governor.votingPeriod());

      let state = Number(await governor['state(uint256)'](proposalId));
      log.push(`Initial state: ${state} (${stateLabel(state)})`);
      console.log(`[execute] ${log[log.length - 1]}`);

      // Advance from Pending/Active if needed
      if (state === 0) {
        await mineBlocks(provider, votingDelay + 1);
        state = Number(await governor['state(uint256)'](proposalId));
        log.push(`Mined to Active: ${state}`);
      }
      if (state === 1) {
        const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
        if (!alreadyVoted) {
          const { tx } = await nm.sendTx(governor, 'castVoteWithReason', [proposalId, 1, 'Finalizer: for']);
          log.push(`Vote cast. Tx: ${tx.hash}`);
        }
        await mineBlocks(provider, votingPeriod + 1);
        state = Number(await governor['state(uint256)'](proposalId));
        log.push(`After period mine: ${state} (${stateLabel(state)})`);
      }

      if (state !== 4) {
        const msg = `Cannot execute: proposal is ${stateLabel(state)} (${state}). Expected Succeeded (4).`;
        throw Object.assign(new Error(msg), { state, userError: true });
      }

      // ── Pre-flight: relayer balance check for deposit proposals ────────────
      if (isDeposit && proposalValue > 0n) {
        const relayerBal = await provider.getBalance(signer.address);
        if (relayerBal < proposalValue) {
          throw Object.assign(
            new Error(`Relayer has insufficient ETH for deposit: needs ${ethers.formatEther(proposalValue)} ETH, has ${ethers.formatEther(relayerBal)} ETH.`),
            { userError: true }
          );
        }
        console.log(`[execute] Deposit proposal — relayer will forward ${ethers.formatEther(proposalValue)} ETH.`);
      }

      // Queue — OZ Governor.queue() does NOT accept msg.value.
      // ETH is only required at execute() time, where the Timelock forwards it to the target.
      log.push('Queueing in Timelock...');
      console.log(`[execute] ${log[log.length - 1]}`);
      let queueNonceConsumed = false;
      try {
        const { tx: qTx } = await nm.sendTx(
          governor, 'queue',
          [[target], [proposalValue], [normalizedCalldata], descriptionHash]
          // Note: no {value} override — queue() does not forward ETH
        );
        log.push(`Queued. Tx: ${qTx.hash}`);
        console.log(`[execute] Queued: ${qTx.hash}`);
        queueNonceConsumed = true;
      } catch (qErr) {
        if (!qErr.message.includes('NotSuccessful') && !qErr.message.includes('already queued')) throw qErr;
        nm._nonce--;
        log.push('Already queued (nonce not consumed — rolling back).');
        console.log('[execute] Already queued — nonce rolled back.');
      }

      state = Number(await governor['state(uint256)'](proposalId));
      log.push(`Post-queue state: ${state} (${stateLabel(state)})`);

      // Advance EVM time past Timelock delay (works for 1s and 3600s)
      log.push('Advancing EVM time (3601s)...');
      await increaseTime(provider, 3601);

      state = Number(await governor['state(uint256)'](proposalId));
      log.push(`Post-time-advance state: ${state} (${stateLabel(state)})`);
      console.log(`[execute] ${log[log.length - 1]}`);

      if (state !== 5) {
        throw Object.assign(new Error(`Expected Queued (5), got ${state} (${stateLabel(state)})`), { state });
      }

      // ── ETH Transfer Proof: decide which address to track ──────────────────
      // withdraw: Treasury → recipient wallet  →  track recipient
      // deposit:  proposer → Treasury          →  track target (Treasury)
      // custom:   depends on calldata          →  track recipient if present, else target
      const proofAddress = isDeposit
        ? target
        : (recipient && ethers.isAddress(recipient) ? recipient : null);

      // Snapshot balance BEFORE execution — query at the latest confirmed block
      let balBefore = 0n;
      const blockBeforeExec = await provider.getBlockNumber();
      if (proofAddress) {
        balBefore = await provider.getBalance(proofAddress, blockBeforeExec);
        console.log(`[execute] Balance BEFORE ${isDeposit ? '(target/deposit)' : '(recipient)'} (block ${blockBeforeExec}): ${ethers.formatEther(balBefore)} ETH`);
        log.push(`${isDeposit ? 'Target' : 'Recipient'} balance before: ${ethers.formatEther(balBefore)} ETH (block ${blockBeforeExec})`);
      }

      // Execute — nonce N+1 (tracked automatically by NonceManager)
      // For deposit proposals, the ETH must be sent with this transaction so
      // the Governor/Timelock can forward it to the target contract.
      log.push('Executing...');
      console.log(`[execute] ${log[log.length - 1]} (nonce=${nm.current()})`);
      const { tx: exTx, receipt } = await nm.sendTx(
        governor, 'execute',
        [[target], [proposalValue], [normalizedCalldata], descriptionHash],
        isDeposit ? { value: proposalValue } : {}
      );
      log.push(`✅ Executed! Tx: ${exTx.hash} | Block: ${receipt.blockNumber}`);
      console.log(`[execute] ${log[log.length - 1]}`);

      await Proposal.findOneAndUpdate({ proposalId }, { status: 'EXECUTED' }).catch(() => {});

      // Snapshot balance AFTER — pinned to the exact execute block.
      let proof = null;
      if (proofAddress) {
        const balAfter = await provider.getBalance(proofAddress, receipt.blockNumber);
        const net = balAfter - balBefore;
        const label = isDeposit ? 'Target (deposit)' : 'Recipient (withdraw)';
        proof = {
          address:       proofAddress,
          label,
          direction:     direction || 'withdraw',
          balanceBefore: ethers.formatEther(balBefore),
          balanceAfter:  ethers.formatEther(balAfter),
          netChange:     ethers.formatEther(net < 0n ? -net : net),
          netSign:       net >= 0n ? '+' : '-',
          // Keep legacy field for UI backwards compat
          recipient:     proofAddress,
        };
        const sym = net > 0n ? '✅' : (net === 0n ? '⚠️' : '❌');
        console.log(`\n[execute] ╔══ ETH Transfer Proof ══════════════════════`);
        console.log(`[execute] ║  Direction: ${isDeposit ? 'DEPOSIT (Wallet → Treasury)' : 'WITHDRAW (Treasury → Wallet)'}`);
        console.log(`[execute] ║  ${label}: ${proofAddress}`);
        console.log(`[execute] ║  Block:     Before=${blockBeforeExec} → After=${receipt.blockNumber}`);
        console.log(`[execute] ║  Balance:   ${proof.balanceBefore} → ${proof.balanceAfter} ETH`);
        console.log(`[execute] ║  Net Change: ${proof.netSign}${proof.netChange} ETH  ${sym}`);
        console.log(`[execute] ╚═══════════════════════════════════════════════`);
        log.push(`${sym} [${label}] ${proofAddress}: ${proof.balanceBefore} → ${proof.balanceAfter} ETH (${proof.netSign}${proof.netChange} ETH)`);
      }

      return { txHash: exTx.hash, proof, log };
    });

    return res.json({ success: true, ...result });
  } catch (e) {
    console.error('[execute] Error:', e.reason || e.message);
    const code = e.userError ? 400 : 500;
    return res.status(code).json({ error: e.reason || e.message, state: e.state });
  }
});

// DELETE /api/admin/reset — wipe all proposals (local dev use only)
app.delete('/api/admin/reset', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Reset unavailable in production' });
    }
    await Proposal.deleteMany({});
    console.log('[admin] MongoDB proposals collection wiped.');
    return res.json({ success: true, message: 'All proposals deleted' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Start listener
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dao_voting')
    .then(() => {
      console.log('MongoDB connected successfully');

      // --- On-chain log poller for ProposalCreated ---
      // We use manual queryFilter polling instead of contract.on() because
      // ethers v6 FilterIdEventSubscriber crashes with "results is not iterable"
      // when Hardhat returns null from eth_getLogs (e.g. after node restart).
      const freshAddrs = getAddresses();
      const liveGovernorAddress = freshAddrs.governorAddress || GOVERNOR_ADDRESS;

      if (liveGovernorAddress) {
        const evtProvider = new ethers.JsonRpcProvider(RPC_URL);
        const governorContract = new ethers.Contract(liveGovernorAddress, GOVERNOR_ABI, evtProvider);
        let lastPollBlock = 0;

        const pollForEvents = async () => {
          try {
            const latest = await evtProvider.getBlockNumber();
            if (latest > lastPollBlock) {
              const fromBlock = lastPollBlock + 1;
              const events = await governorContract.queryFilter('ProposalCreated', fromBlock, latest);
              if (Array.isArray(events)) {
                for (const evt of events) {
                  try {
                    const [proposalId, proposer, targets, values, , , , , description] = evt.args;
                    let valueDisplay = '0';
                    try { valueDisplay = Array.isArray(values) && values.length > 0 ? ethers.formatEther(values[0]) : '0'; } catch {}
                    console.log(`\n--- [on-chain] ProposalCreated ---`);
                    console.log(`ID:       ${proposalId.toString()}`);
                    console.log(`Proposer: ${proposer}`);
                    console.log(`Target:   ${Array.isArray(targets) ? targets[0] : 'n/a'}`);
                    console.log(`Value:    ${valueDisplay} ETH`);
                    console.log(`Desc:     ${description}`);
                    console.log(`----------------------------------\n`);
                  } catch (parseErr) {
                    console.warn('[on-chain] Event parse error:', parseErr.message);
                  }
                }
              }
              lastPollBlock = latest;
            }
          } catch (pollErr) {
            // Silently ignore polling errors (e.g. node restart, connection reset)
            if (!pollErr.message?.includes('ECONNREFUSED')) {
              console.warn('[on-chain] Poll error:', pollErr.message);
            }
          }
        };

        // Initialize lastPollBlock then start polling every 2s
        evtProvider.getBlockNumber()
          .then(n => { lastPollBlock = n; })
          .catch(() => {})
          .finally(() => {
            setInterval(pollForEvents, 2000);
            console.log(`[on-chain] Polling for ProposalCreated on ${liveGovernorAddress}`);
          });
      } else {
        console.warn('[on-chain] No governorAddress — event polling skipped. Deploy contracts first.');
      }

      console.log(`[config] Serving Governor=${GOVERNOR_ADDRESS}, Treasury=${TREASURY_ADDRESS}`);
      app.listen(PORT, '0.0.0.0', () => console.log(`Backend server running on port ${PORT}`));
    });
}

module.exports = app;
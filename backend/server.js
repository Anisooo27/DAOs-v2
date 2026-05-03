require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  GOVERNOR_ABI,
  GOVERNOR_ADDRESS,
  TREASURY_ADDRESS,
  RPC_URL,
  isConfigured
} = require('./config/contractConfig');

const ADDRESSES_PATH = path.join(__dirname, 'config', 'deployedAddresses.json');

function getAddresses() {
  try {
    if (fs.existsSync(ADDRESSES_PATH)) {
      return JSON.parse(fs.readFileSync(ADDRESSES_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[config] Could not read deployedAddresses.json:', e.message);
  }
  return { governorAddress: GOVERNOR_ADDRESS, treasuryAddress: TREASURY_ADDRESS };
}

const app = express();
app.use(express.json());
app.use(cors());

// Mock IPFS Store
const ipfsStore = new Map();

app.post('/ipfs/upload', (req, res) => {
  const data = JSON.stringify(req.body);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const cid = 'Qm' + hash.substring(0, 44);
  ipfsStore.set(cid, req.body);
  console.log(`[IPFS] Uploaded metadata, CID: ${cid}`);
  res.json({ cid });
});

app.get('/ipfs/gateway/:cid', (req, res) => {
  const data = ipfsStore.get(req.params.cid);
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/config/contract', (req, res) => {
  const addrs = getAddresses();
  res.json({ 
    governorAddress: addrs.governorAddress,
    treasuryAddress: addrs.treasuryAddress,
    tokenAddress: addrs.tokenAddress
  });
});

app.get('/membership/:address', async (req, res) => {
  try {
    const { address } = req.params;
    let govBalance = '0';
    const addrs = getAddresses();
    if (addrs.tokenAddress) {
      const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
      const TOKEN_ABI = ['function balanceOf(address account) view returns (uint256)'];
      const tokenContract = new ethers.Contract(addrs.tokenAddress, TOKEN_ABI, rpcProvider);
      govBalance = (await tokenContract.balanceOf(address)).toString();
    }
    return res.json({ govBalance });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Helper for block mining (time travel)
app.post('/rpc/mine', async (req, res) => {
  try {
    const { blocks, seconds, proposalId } = req.body;
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    if (seconds) {
      await provider.send('evm_increaseTime', [Number(seconds)]);
      await provider.send('evm_mine', []);
      console.log(`[RPC] Increased time by ${seconds} seconds.`);
    }
    if (blocks) {
      await provider.send('hardhat_mine', ['0x' + Number(blocks).toString(16)]);
      console.log(`[RPC] Mined ${blocks} blocks.`);
    }

    if (proposalId) {
      const addrs = getAddresses();
      if (addrs.governorAddress) {
        const GOV_ABI = ['function state(uint256) view returns (uint8)'];
        const govContract = new ethers.Contract(addrs.governorAddress, GOV_ABI, provider);
        try {
          const s = Number(await govContract.state(proposalId));
          const shortId = proposalId.toString().slice(0, 15) + '...';
          if (s === 3) {
            console.log(`\n[EVENT] ProposalDefeated: ${shortId} - majority Against or quorum not met`);
          } else if (s === 4) {
            console.log(`\n[EVENT] ProposalSucceeded: ${shortId} - majority For and quorum met`);
          }
        } catch (e) {
          console.error(`[ERROR] Proposal state check failed for ${proposalId}`);
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/rpc/log-vote-error', (req, res) => {
  const { wallet, proposalId, errorType } = req.body;
  if (errorType === 'duplicate' && wallet && proposalId) {
    const shortId = proposalId.toString().slice(0, 15) + '...';
    console.log(`\n[EVENT] VoteRejected: ${shortId} by ${wallet} (duplicate commit)`);
  }
  res.json({ success: true });
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  console.log('Backend starting. MongoDB dependency completely removed.');

  const freshAddrs = getAddresses();
  const liveGovernorAddress = freshAddrs.governorAddress || GOVERNOR_ADDRESS;

  if (liveGovernorAddress) {
    const evtProvider = new ethers.JsonRpcProvider(RPC_URL);
    const governorContract = new ethers.Contract(liveGovernorAddress, GOVERNOR_ABI, evtProvider);
    
    // ── Safe event iterator guard ─────────────────────────────────────────
    // Wraps raw results from FilterIdEventSubscriber._emitResults so that a
    // null / non-array payload never propagates as a TypeError crash.
    function safeIterate(results, handler, eventName) {
      try {
        if (!results || !Array.isArray(results)) { return; }
        results.forEach(handler);
      } catch (err) {
        console.error(`[ERROR] EventSubscriber failed for ${eventName} — skipping iteration`);
      }
    }

    // Clean logging of Governor events
    governorContract.on('ProposalCreated', (...args) => {
      try {
        const [proposalId, proposer,,,,,,,description] = args;
        console.log(`\n[EVENT] ProposalCreated: ${proposalId.toString().slice(0, 15)}...`);
        console.log(`   Proposer: ${proposer}`);
        console.log(`   CID: ${description}`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for ProposalCreated — skipping iteration');
      }
    });

    governorContract.on('VoteCast', (...args) => {
      try {
        const [voter, proposalId, support, weight] = args;
        const supportLabel = support === 0n ? 'Against' : support === 1n ? 'For' : 'Abstain';
        console.log(`\n[EVENT] VoteCast: ${voter} voted ${supportLabel} (weight: ${ethers.formatEther(weight)})`);
        console.log(`   Proposal ID: ${proposalId.toString().slice(0, 15)}...`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for VoteCast — skipping iteration');
      }
    });

    governorContract.on('VoteCommitted', (...args) => {
      try {
        const [proposalId, voter, commitment] = args;
        console.log(`\n[EVENT] VoteCommitted: ${proposalId.toString()} by ${voter} (${commitment})`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for VoteCommitted — skipping iteration');
      }
    });

    governorContract.on('VoteRevealed', (...args) => {
      try {
        const [proposalId, voter, support, quadraticWeight] = args;
        const supportLabel = support === 0n ? 'Against' : support === 1n ? 'For' : 'Abstain';
        console.log(`\n[EVENT] VoteRevealed: ${proposalId.toString()} choice=${supportLabel} by ${voter} (quadraticWeight=${ethers.formatEther(quadraticWeight)})`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for VoteRevealed — skipping iteration');
      }
    });

    governorContract.on('RevealRejected', (...args) => {
      try {
        const [proposalId, voter, reason] = args;
        console.log(`\n[EVENT] RevealRejected: ${proposalId.toString()} by ${voter} (${reason})`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for RevealRejected — skipping iteration');
      }
    });

    governorContract.on('VoteRejected', (...args) => {
      try {
        const [proposalId, voter, reason] = args;
        console.log(`\n[EVENT] VoteRejected: ${proposalId.toString()} by ${voter} (${reason})`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for VoteRejected — skipping iteration');
      }
    });

    // The OpenZeppelin Governor does NOT emit ProposalDefeated natively;
    // we detect it via /rpc/mine state check.
    governorContract.on('ProposalExecuted', (...args) => {
      try {
        const [proposalId] = args;
        console.log(`\n[EVENT] ProposalExecuted: ${proposalId.toString().slice(0, 15)}...`);
        console.log(`   Execution completed successfully on-chain!`);
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for ProposalExecuted — skipping iteration');
      }
    });

    console.log('[on-chain] Listening for Governor events on ' + liveGovernorAddress);
  }

  if (freshAddrs.tokenAddress) {
    const evtProvider = new ethers.JsonRpcProvider(RPC_URL);
    const TOKEN_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
    const tokenContract = new ethers.Contract(freshAddrs.tokenAddress, TOKEN_ABI, evtProvider);
    tokenContract.on('Transfer', (...args) => {
      try {
        const [from, to, value] = args;
        const amount = ethers.formatEther(value);
        if (from === ethers.ZeroAddress) {
          console.log(`\n[EVENT] FaucetMint: ${amount} GOV minted to ${to}`);
        } else {
          console.log(`\n[EVENT] Transfer: ${amount} GOV from ${from} to ${to}`);
        }
      } catch (err) {
        console.error('[ERROR] EventSubscriber failed for Transfer — skipping iteration');
      }
    });
    console.log('[on-chain] Listening for Transfer events on ' + freshAddrs.tokenAddress);
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Backend server running on port ${PORT}`));
}

module.exports = app;
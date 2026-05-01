'use strict';
require('dotenv').config();

// Minimal ABI — only the functions the backend needs to call.
// Extracted from the compiled DAOGovernor artifact to keep the server lean.
const GOVERNOR_ABI = [
  // Cast a vote on-chain: support values follow OpenZeppelin convention
  //   0 = Against, 1 = For, 2 = Abstain
  {
    inputs: [
      { internalType: 'uint256', name: 'proposalId', type: 'uint256' },
      { internalType: 'uint8',   name: 'support',    type: 'uint8'   }
    ],
    name: 'castVote',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },

  {
    inputs: [{ internalType: 'uint256', name: 'proposalId', type: 'uint256' }],
    name: 'state',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'proposalId', type: 'uint256' },
      { internalType: 'bytes32', name: 'commitment', type: 'bytes32' }
    ],
    name: 'commitVote',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'proposalId', type: 'uint256' },
      { internalType: 'uint8', name: 'support', type: 'uint8' },
      { internalType: 'string', name: 'secret', type: 'string' }
    ],
    name: 'revealVote',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'proposalId', type: 'uint256' },
      { internalType: 'address', name: 'voter', type: 'address' }
    ],
    name: 'commitments',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'proposalId', type: 'uint256' },
      { internalType: 'address', name: 'voter', type: 'address' }
    ],
    name: 'hasRevealed',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  },

  // Event emitted on successful vote (for log verification)
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address',  name: 'voter',      type: 'address'  },
      { indexed: false, internalType: 'uint256',  name: 'proposalId', type: 'uint256'  },
      { indexed: false, internalType: 'uint8',    name: 'support',    type: 'uint8'    },
      { indexed: false, internalType: 'uint256',  name: 'weight',     type: 'uint256'  },
      { indexed: false, internalType: 'string',   name: 'reason',     type: 'string'   }
    ],
    name: 'VoteCast',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256',  name: 'proposalId', type: 'uint256'  },
      { indexed: true,  internalType: 'address',  name: 'voter',      type: 'address'  },
      { indexed: false, internalType: 'bytes32',  name: 'commitment', type: 'bytes32'  }
    ],
    name: 'VoteCommitted',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256',  name: 'proposalId', type: 'uint256'  },
      { indexed: true,  internalType: 'address',  name: 'voter',      type: 'address'  },
      { indexed: false, internalType: 'uint8',    name: 'support',    type: 'uint8'    },
      { indexed: false, internalType: 'uint256',  name: 'weight',     type: 'uint256'  }
    ],
    name: 'VoteRevealed',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256',  name: 'proposalId', type: 'uint256'  },
      { indexed: true,  internalType: 'address',  name: 'voter',      type: 'address'  },
      { indexed: false, internalType: 'string',   name: 'reason',     type: 'string'   }
    ],
    name: 'RevealRejected',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256',  name: 'proposalId', type: 'uint256'  },
      { indexed: true,  internalType: 'address',  name: 'voter',      type: 'address'  },
      { indexed: false, internalType: 'string',   name: 'reason',     type: 'string'   }
    ],
    name: 'VoteRejected',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'uint256',   name: 'proposalId', type: 'uint256' },
      { indexed: false, internalType: 'address',   name: 'proposer',   type: 'address' },
      { indexed: false, internalType: 'address[]', name: 'targets',    type: 'address[]' },
      { indexed: false, internalType: 'uint256[]', name: 'values',     type: 'uint256[]' },
      { indexed: false, internalType: 'string[]',  name: 'signatures', type: 'string[]' },
      { indexed: false, internalType: 'bytes[]',   name: 'calldatas',  type: 'bytes[]' },
      { indexed: false, internalType: 'uint256',   name: 'startBlock', type: 'uint256' },
      { indexed: false, internalType: 'uint256',   name: 'endBlock',   type: 'uint256' },
      { indexed: false, internalType: 'string',    name: 'description',type: 'string' }
    ],
    name: 'ProposalCreated',
    type: 'event'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'uint256', name: 'proposalId', type: 'uint256' }
    ],
    name: 'ProposalExecuted',
    type: 'event'
  }
];

const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS || null;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || null;
const RPC_URL          = process.env.RPC_URL          || 'http://127.0.0.1:8545';
const PRIVATE_KEY      = process.env.PRIVATE_KEY      || null;

/**
 * Returns true when all required env vars are set for on-chain submission.
 */
const isConfigured = () => Boolean(GOVERNOR_ADDRESS && PRIVATE_KEY);

module.exports = { GOVERNOR_ABI, GOVERNOR_ADDRESS, TREASURY_ADDRESS, RPC_URL, PRIVATE_KEY, isConfigured };

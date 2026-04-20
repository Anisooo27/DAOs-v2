const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// ─── Mock the contract config BEFORE requiring the app ───────────────────────
// This prevents any real ethers.js / RPC calls during tests.
// The mock is replaced per-describe block to test both the configured and
// unconfigured paths.
jest.mock('../config/contractConfig', () => ({
  GOVERNOR_ABI:     [],
  GOVERNOR_ADDRESS: '0xMockGovernorAddress',
  TREASURY_ADDRESS: '0xMockTreasuryAddress',
  RPC_URL:          'http://127.0.0.1:8545',
  PRIVATE_KEY:      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // hardhat account 0
  isConfigured:     jest.fn(() => true) // default: contract IS configured
}));

const app  = require('../server');
const Vote = require('../models/Vote');

// Pull the mock so individual tests can override isConfigured's return value
const contractConfig = require('../config/contractConfig');
const Proposal       = require('../models/Proposal');

// ─── Mock ethers.js so castVote never hits a real network ────────────────────
jest.mock('ethers', () => {
  const mockWait = jest.fn().mockResolvedValue({ hash: '0xmocktxhash', blockNumber: 42 });
  const mockTx   = { wait: mockWait, hash: '0xmocktxhash' };
  
  const mockContract = jest.fn().mockImplementation(() => ({
    castVote:           jest.fn().mockResolvedValue(mockTx),
    castVoteWithReason: jest.fn().mockResolvedValue(mockTx),
    votingDelay:        jest.fn().mockResolvedValue(1n),
    votingPeriod:       jest.fn().mockResolvedValue(50n),
    state:              jest.fn().mockResolvedValue(1), // Active
    'state(uint256)':   jest.fn().mockResolvedValue(1),
    hasVoted:           jest.fn().mockResolvedValue(false)
  }));
  
  const mockWallet = jest.fn().mockImplementation(() => ({
    address: '0xRelayerWallet'
  }));

  // More robust deterministic mock hash to avoid unique index collisions
  const mockKeccak = jest.fn().mockImplementation((input) => {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    // Simple pseudo-hash: keccak256(str) -> hex(sum of char codes)
    let sum = 0;
    for (let i = 0; i < str.length; i++) sum = (sum << 5) - sum + str.charCodeAt(i);
    return '0x' + Math.abs(sum).toString(16).padStart(64, '0');
  });

  const mockVerify = jest.fn().mockImplementation((msg, sig) => {
    if (sig.startsWith('0x1111')) return '0x1111111111111111111111111111111111111111';
    if (sig.startsWith('0x2222')) return '0x2222222222222222222222222222222222222222';
    if (sig.startsWith('0x3333')) return '0x3333';
    if (sig.startsWith('0x4444')) return '0x4444';
    return sig;
  });

  return {
    ethers: {
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        getTransactionCount: jest.fn().mockResolvedValue(0),
        getBlockNumber:      jest.fn().mockResolvedValue(100),
        getBalance:          jest.fn().mockResolvedValue(1000n * 10n**18n)
      })),
      Wallet:          mockWallet,
      Contract:        mockContract,
      verifyMessage:   mockVerify,
      keccak256:       mockKeccak,
      toUtf8Bytes:     jest.fn().mockImplementation(s => s),
      formatEther:     jest.fn().mockImplementation(b => b.toString()),
      parseEther:      jest.fn().mockImplementation(s => BigInt(s) * 10n**18n),
      id:              jest.fn().mockImplementation(s => '0x' + s.length.toString(16).padStart(64, '0')),
      getAddress:      jest.fn().mockImplementation(a => a)
    }
  };
});

const Delegation = require('../models/Delegation');

// ─── In-memory MongoDB lifecycle ─────────────────────────────────────────────
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(mongoUri);
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  jest.clearAllMocks(); // reset call counts between tests
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─── Test fixtures ────────────────────────────────────────────────────────────
const testProposalId = '123456789012345678901234567890';
const testVoter1    = '0x1111111111111111111111111111111111111111';
const testVoter2    = '0x2222222222222222222222222222222222222222';
const testSignature1 = testVoter1; // Our mock returns sig as recovered address
const testSignature2 = testVoter2;

// =============================================================================
describe('Voting API Endpoints', () => {

  // ── POST /vote ──────────────────────────────────────────────────────────────
  describe('POST /vote', () => {
    it('should successfully record a valid vote', async () => {
      // Seed delegation
      await Delegation.create({ delegatorAddress: testVoter1, delegateeAddress: testVoter1, signature: '0xmock' });
      // Seed proposal
      await Proposal.create({ proposalId: testProposalId, proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });

      const response = await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 1, signature: testSignature1 });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('Vote recorded');
      expect(response.body.vote.proposalId).toBe(testProposalId);
      expect(response.body.vote.voter).toBe(testVoter1.toLowerCase());

      const count = await Vote.countDocuments();
      expect(count).toBe(1);
    });

    it('should reject a duplicate vote from the same voter for the same proposal', async () => {
      await Delegation.create({ delegatorAddress: testVoter1, delegateeAddress: testVoter1, signature: '0xmock' });
      await Proposal.create({ proposalId: testProposalId, proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });
      
      // First vote
      await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 1, signature: testSignature1 });

      // Duplicate vote (even with a different choice)
      const response = await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 0, signature: testSignature1 });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Already voted — each address may only vote once per proposal.');

      const count = await Vote.countDocuments();
      expect(count).toBe(1); // still only 1 vote in DB
    });

    it('should allow the same voter to vote on different proposals', async () => {
      await Delegation.create({ delegatorAddress: testVoter1, delegateeAddress: testVoter1, signature: '0xmock' });
      await Proposal.create({ proposalId: 'prop-A', proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });
      await Proposal.create({ proposalId: 'prop-B', proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });
      
      await request(app).post('/vote').send({ proposalId: 'prop-A', voter: testVoter1, choice: 1, signature: testSignature1 });
      const response = await request(app).post('/vote').send({ proposalId: 'prop-B', voter: testVoter1, choice: 0, signature: testSignature1 });

      expect(response.status).toBe(201);
      const count = await Vote.countDocuments();
      expect(count).toBe(2);
    });

    it('should return 400 if missing required fields', async () => {
      const response = await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1 }); // missing choice & signature

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Missing required fields/);
    });
  });

  // ── GET /results/:proposalId ────────────────────────────────────────────────
  describe('GET /results/:proposalId', () => {
    it('should correctly aggregate and return vote counts', async () => {
      // Seed proposal
      await Proposal.create({ proposalId: testProposalId, proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });

      await Vote.create([
        { proposalId: testProposalId, voter: testVoter1,  choice: 1, signature: testSignature1, nullifier: '0xn1' }, // For
        { proposalId: testProposalId, voter: testVoter2,  choice: 1, signature: testSignature2, nullifier: '0xn2' }, // For
        { proposalId: testProposalId, voter: '0x3333',   choice: 0, signature: '0x3333', nullifier: '0xn3' }  // Against
      ]);

      const response = await request(app).get(`/results/${testProposalId}`);

      expect(response.status).toBe(200);
      expect(response.body.proposalId).toBe(testProposalId);
      expect(response.body.results['1']).toBe(2); // 2 For
      expect(response.body.results['0']).toBe(1); // 1 Against
      expect(response.body.results['2']).toBeUndefined(); // 0 Abstain
    });

    it('should return empty results for a proposal with no votes', async () => {
      const response = await request(app).get('/results/non-existent-prop');

      expect(response.status).toBe(200);
      expect(Object.keys(response.body.results).length).toBe(0);
    });
  });

  // ── POST /submit/:proposalId ────────────────────────────────────────────────
  describe('POST /submit/:proposalId', () => {

    it('should return 503 when GOVERNOR_ADDRESS / PRIVATE_KEY are not configured', async () => {
      // Override the mock for this test only
      contractConfig.isConfigured.mockReturnValueOnce(false);

      const response = await request(app).post(`/submit/${testProposalId}`);

      expect(response.status).toBe(503);
      expect(response.body.error).toMatch(/not configured/i);
    });

    it('should return 404 when there are no votes for the proposal', async () => {
      await Proposal.create({ proposalId: 'empty-prop', proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });
      const response = await request(app).post(`/submit/empty-prop`);

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/No votes found/);
    });

    it('should aggregate votes, determine the winner, call castVote on-chain, and return a tx hash', async () => {
      // Seed proposal
      await Proposal.create({ proposalId: testProposalId, proposerAddress: '0x1', description: 'desc', target: '0x2', value: '0', calldata: '0x', signature: '0x' });

      // Seed: 1 Abstain, 2 For → winning choice should be 1 (For)
      await Vote.create([
        { proposalId: testProposalId, voter: testVoter1, choice: 2, signature: testSignature1, nullifier: '0xn1' }, // Abstain
        { proposalId: testProposalId, voter: testVoter2, choice: 1, signature: testSignature2, nullifier: '0xn2' }, // For
        { proposalId: testProposalId, voter: '0x4444',  choice: 1, signature: '0x4444', nullifier: '0xn3' }  // For
      ]);

      const response = await request(app).post(`/submit/${testProposalId}`);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Results successfully submitted on-chain via castVote');
      expect(response.body.winningChoice).toBe(1);                  // For wins
      expect(response.body.submittedPayload['1']).toBe(2);           // 2 For
      expect(response.body.submittedPayload['2']).toBe(1);           // 1 Abstain
      expect(response.body.transactionHash).toBe('0xmocktxhash');   // from mock
      expect(response.body.blockNumber).toBe(42);                   // from mock
    });
  });
});

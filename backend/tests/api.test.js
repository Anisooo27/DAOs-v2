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
  RPC_URL:          'http://127.0.0.1:8545',
  PRIVATE_KEY:      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // hardhat account 0
  isConfigured:     jest.fn(() => true) // default: contract IS configured
}));

const app  = require('../server');
const Vote = require('../models/Vote');

// Pull the mock so individual tests can override isConfigured's return value
const contractConfig = require('../config/contractConfig');

// ─── Mock ethers.js so castVote never hits a real network ────────────────────
jest.mock('ethers', () => {
  const mockWait = jest.fn().mockResolvedValue({ hash: '0xmocktxhash', blockNumber: 42 });
  const mockCastVote = jest.fn().mockResolvedValue({ wait: mockWait });
  const mockContract = jest.fn().mockImplementation(() => ({
    castVote: mockCastVote
  }));
  const mockWallet = jest.fn().mockImplementation(() => ({
    address: '0xRelayerWallet'
  }));

  return {
    ethers: {
      JsonRpcProvider: jest.fn(),
      Wallet:          mockWallet,
      Contract:        mockContract
    }
  };
});

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
const testProposalId = 'prop-123';
const testVoter1    = '0x1111111111111111111111111111111111111111';
const testVoter2    = '0x2222222222222222222222222222222222222222';
const testSignature  = '0xabc123';

// =============================================================================
describe('Voting API Endpoints', () => {

  // ── POST /vote ──────────────────────────────────────────────────────────────
  describe('POST /vote', () => {
    it('should successfully record a valid vote', async () => {
      const response = await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 1, signature: testSignature });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('Vote recorded successfully');
      expect(response.body.vote.proposalId).toBe(testProposalId);
      expect(response.body.vote.voter).toBe(testVoter1.toLowerCase());

      const count = await Vote.countDocuments();
      expect(count).toBe(1);
    });

    it('should reject a duplicate vote from the same voter for the same proposal', async () => {
      // First vote
      await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 1, signature: testSignature });

      // Duplicate vote (even with a different choice)
      const response = await request(app)
        .post('/vote')
        .send({ proposalId: testProposalId, voter: testVoter1, choice: 0, signature: testSignature });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Voter has already cast a vote for this proposal');

      const count = await Vote.countDocuments();
      expect(count).toBe(1); // still only 1 vote in DB
    });

    it('should allow the same voter to vote on different proposals', async () => {
      await request(app).post('/vote').send({ proposalId: 'prop-A', voter: testVoter1, choice: 1, signature: testSignature });
      const response = await request(app).post('/vote').send({ proposalId: 'prop-B', voter: testVoter1, choice: 0, signature: testSignature });

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
      await Vote.create([
        { proposalId: testProposalId, voter: testVoter1,  choice: 1, signature: testSignature }, // For
        { proposalId: testProposalId, voter: testVoter2,  choice: 1, signature: testSignature }, // For
        { proposalId: testProposalId, voter: '0x3333',   choice: 0, signature: testSignature }  // Against
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
      const response = await request(app).post(`/submit/no-votes-here`);

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/No votes found/);
    });

    it('should aggregate votes, determine the winner, call castVote on-chain, and return a tx hash', async () => {
      // Seed: 1 Abstain, 2 For → winning choice should be 1 (For)
      await Vote.create([
        { proposalId: testProposalId, voter: testVoter1, choice: 2, signature: testSignature }, // Abstain
        { proposalId: testProposalId, voter: testVoter2, choice: 1, signature: testSignature }, // For
        { proposalId: testProposalId, voter: '0x4444',  choice: 1, signature: testSignature }  // For
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

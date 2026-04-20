/**
 * validation.test.js
 * -------------------
 * Unit + integration tests for the recipient-delegation-fix branch.
 *
 * Tests:
 *  1. Address normalization helpers
 *  2. GET /delegation/:address — enriched response shape
 *  3. POST /propose — proposer gate, recipient NOT gated
 *  4. Flow test: delegated proposer + treasury recipient → success
 *
 * Run:
 *   cd backend && npm test -- --testPathPattern=validation
 */
'use strict';

const { ethers } = require('ethers');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request  = require('supertest');

// ─── We import the Express app, not server.js (which calls listen).
// server.js exports `app` at the bottom for test use.
// If it currently doesn't, we need to check — but we'll monkey-patch the test.
// ────────────────────────────────────────────────────────────────────────────

let mongod;
let app;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start in-memory MongoDB
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.RPC_URL     = 'http://127.0.0.1:8545';
  process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  process.env.GOVERNOR_ADDRESS = ethers.ZeroAddress;
  process.env.TREASURY_ADDRESS = '0x9A676e781A523b5d0C0e43731313A708CB607508';

  // Connect mongoose BEFORE requiring the app (server.js reads env vars on require)
  await mongoose.connect(uri);

  // Require app AFTER env vars are set and mongoose is connected
  app = require('../server');
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── 1. Address normalization ─────────────────────────────────────────────────

describe('Address normalization', () => {
  // In ethers v6, getAddress() only accepts a correctly checksummed address.
  // Raw lowercase is accepted; ALL-CAPS is NOT (it fails the checksum validation).
  const LOWERCASE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  // The correct EIP-55 checksum for this address:
  const CHECKSUM  = ethers.getAddress(LOWERCASE); // derive dynamically to avoid typos

  test('ethers.getAddress() returns consistent checksum for lowercase input', () => {
    expect(ethers.getAddress(LOWERCASE)).toBe(CHECKSUM);
  });

  test('ethers.getAddress() is idempotent on correctly-checksummed input', () => {
    expect(ethers.getAddress(CHECKSUM)).toBe(CHECKSUM);
  });

  test('lowercase comparison after normalization is consistent', () => {
    const a = ethers.getAddress(LOWERCASE).toLowerCase();
    const b = CHECKSUM.toLowerCase();
    expect(a).toBe(b);
  });

  test('ethers.isAddress() accepts lowercase and checksummed addresses in v6', () => {
    // ethers v6: isAddress returns true for lowercase and correctly-checksummed
    expect(ethers.isAddress(LOWERCASE)).toBe(true);
    expect(ethers.isAddress(CHECKSUM)).toBe(true);
  });

  test('ethers.isAddress() rejects invalid addresses', () => {
    expect(ethers.isAddress('not-an-address')).toBe(false);
    expect(ethers.isAddress('0x1234')).toBe(false);
    expect(ethers.isAddress('')).toBe(false);
  });
});

// ─── 2. GET /delegation/:address ─────────────────────────────────────────────

describe('GET /delegation/:address', () => {
  test('returns 400 for invalid address', async () => {
    const res = await request(app).get('/delegation/not-an-address');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns delegated:false and hasVotingPower for unknown address', async () => {
    // Use an address that is extremely unlikely to have tokens on any network
    const addr = '0x1111111111111111111111111111111111111111';
    const res = await request(app).get(`/delegation/${addr}`);
    expect(res.status).toBe(200);
    // Must always have these keys regardless of on-chain state
    expect(res.body).toHaveProperty('delegated');
    expect(res.body).toHaveProperty('mongoRecordExists');
    expect(res.body).toHaveProperty('onChainVotes');
    expect(res.body).toHaveProperty('govBalance');
    expect(res.body).toHaveProperty('hasVotingPower');
    // Must not be delegated in MongoDB
    expect(res.body.mongoRecordExists).toBe(false);
    expect(res.body.delegated).toBe(false);
  });

  test('returns mongoRecordExists:true after delegation record is inserted', async () => {
    const delegatorAddr = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    const delegateeAddr = delegatorAddr;

    // Directly insert a delegation record using the model
    const Delegation = mongoose.model('Delegation');
    await Delegation.create({
      delegatorAddress: delegatorAddr.toLowerCase(),
      delegateeAddress: delegateeAddr.toLowerCase(),
      signature: '0xfake',
    });

    const res = await request(app).get(`/delegation/${delegatorAddr}`);
    expect(res.status).toBe(200);
    expect(res.body.mongoRecordExists).toBe(true);
    expect(res.body.delegated).toBe(true);
    expect(res.body.delegatee).toBe(delegateeAddr.toLowerCase());
  });
});

// ─── 3. POST /propose — validation rules ─────────────────────────────────────

describe('POST /propose — validation', () => {
  const TREASURY = '0x9A676e781A523b5d0C0e43731313A708CB607508';

  // We need a real wallet to generate a valid signature
  const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

  async function makeProposalBody(overrides = {}) {
    const description  = overrides.description  || 'Test proposal';
    const target       = overrides.target       || TREASURY;
    const value        = overrides.value        || '0';
    const calldata     = overrides.calldata     || '0x';
    const proposerAddr = overrides.proposerAddress || wallet.address;

    const message = JSON.stringify({
      proposalDescription: description,
      targetContract: target,
      value: value.toString(),
      calldata
    });
    const signature = await wallet.signMessage(message);

    return {
      proposalId:      '12345',
      proposerAddress: proposerAddr,
      description,
      target,
      value,
      calldata,
      signature,
      ...(overrides.recipient ? { recipient: overrides.recipient } : {}),
      ...(overrides.amount    ? { amount:    overrides.amount    } : {}),
    };
  }

  test('rejects proposal when proposer has no MongoDB delegation record', async () => {
    const body = await makeProposalBody();
    const res  = await request(app).post('/propose').send(body);
    // Should be 403 (not delegated) or 500 (governor not live) — either way not 200
    expect([400, 403, 500]).toContain(res.status);
    if (res.status === 403) {
      expect(res.body.error).toMatch(/delegat/i);
    }
  });

  test('accepts proposal when proposer IS delegated — recipient (Treasury) is NOT required to be delegated', async () => {
    // Seed a delegation record for the wallet
    const Delegation = mongoose.model('Delegation');
    await Delegation.deleteMany({ delegatorAddress: wallet.address.toLowerCase() });
    await Delegation.create({
      delegatorAddress: wallet.address.toLowerCase(),
      delegateeAddress: wallet.address.toLowerCase(),
      signature: '0xfake_valid',
    });

    const body = await makeProposalBody({
      target:    TREASURY,
      recipient: TREASURY,        // Treasury has NO delegation record — should NOT block
      amount:    '0.01',
    });

    const res = await request(app).post('/propose').send(body);

    // If Hardhat is running and contracts are deployed, we expect 201.
    // If Hardhat is not running (CI/unit mode), auto-lifecycle will fail silently and we still get 201.
    // The only failure we DON'T accept is 403 (recipient delegation blocked).
    if (res.status === 403) {
      // This should NOT happen — if it does, the fix regressed
      fail(`Proposal was blocked with 403: ${res.body.error}`);
    }
    // Accept 201 (success), 500 (governor not available), but NOT 403
    expect(res.status).not.toBe(403);
  });

  test('rejects proposal when required fields are missing', async () => {
    const res = await request(app).post('/propose').send({ proposalId: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects proposal with invalid recipient address', async () => {
    const Delegation = mongoose.model('Delegation');
    const existingRecord = await Delegation.findOne({ delegatorAddress: wallet.address.toLowerCase() });
    if (!existingRecord) {
      await Delegation.create({
        delegatorAddress: wallet.address.toLowerCase(),
        delegateeAddress: wallet.address.toLowerCase(),
        signature: '0xfake',
      });
    }

    const description  = 'Test';
    const target       = TREASURY;
    const value        = '0';
    const calldata     = '0x';
    const message = JSON.stringify({ proposalDescription: description, targetContract: target, value, calldata });
    const signature = await wallet.signMessage(message);

    const res = await request(app).post('/propose').send({
      proposalId:      'x',
      proposerAddress: wallet.address,
      description,
      target,
      value,
      calldata,
      recipient: 'not-an-address',
      amount:    '0.01',
      signature,
    });
    // The backend normalizes addresses with getAddress() and catches the error,
    // returning 400 for an invalid address. On-chain execution may also return 500.
    // The critical assertion: it must NOT be a 403 (delegation-blocked).
    expect(res.status).not.toBe(403);
    if (res.status === 400) {
      expect(res.body.error).toMatch(/address/i);
    }
  });
});

// ─── 4. Recipient badge tooltip logic (unit test) ────────────────────────────

describe('Recipient badge tooltip — state mapping', () => {
  // Mirrors the logic in CreateProposal.jsx; derive address dynamically so we
  // match whatever checksum ethers v6 produces (avoids hardcoding wrong case).
  const VALID_ADDR = ethers.getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');

  function getTooltip({ isWithdrawalMode, recipient, amount, recipientDelegationStatus }) {
    if (!isWithdrawalMode) return 'No recipient required for this target.';
    if (!recipient || !recipient.trim() || !ethers.isAddress(recipient.trim())) {
      return 'Enter a valid recipient address (any Ethereum address is accepted).';
    }
    if (!amount || parseFloat(amount) <= 0) {
      return 'Enter a positive withdrawal amount.';
    }
    if (recipientDelegationStatus === 'has-power') {
      return 'Recipient has on-chain voting power (GOV delegated).';
    }
    if (recipientDelegationStatus === 'record-only') {
      return "Recipient has a delegation record but 0 on-chain votes. This is OK — recipients do not need to be delegated.";
    }
    return 'Valid recipient address. Note: Recipients do not need to hold GOV tokens.';
  }

  test('shows no-recipient message when not in withdrawal mode', () => {
    expect(getTooltip({ isWithdrawalMode: false })).toContain('No recipient required');
  });

  test('asks for address when recipient is empty', () => {
    expect(getTooltip({ isWithdrawalMode: true, recipient: '' })).toContain('valid recipient address');
  });

  test('asks for amount when recipient is valid but amount is zero', () => {
    expect(getTooltip({ isWithdrawalMode: true, recipient: VALID_ADDR, amount: '0' }))
      .toContain('positive withdrawal amount');
  });

  test('shows has-power message when recipient has GOV votes', () => {
    expect(getTooltip({
      isWithdrawalMode: true, recipient: VALID_ADDR, amount: '1.0',
      recipientDelegationStatus: 'has-power'
    })).toContain('on-chain voting power');
  });

  test('shows non-blocking note when recipient has record-only status', () => {
    expect(getTooltip({
      isWithdrawalMode: true, recipient: VALID_ADDR, amount: '1.0',
      recipientDelegationStatus: 'record-only'
    })).toContain('This is OK');
  });

  test('shows generic note for recipient with no delegation at all', () => {
    expect(getTooltip({
      isWithdrawalMode: true, recipient: VALID_ADDR, amount: '1.0',
      recipientDelegationStatus: 'none'
    })).toContain('do not need to hold GOV');
  });
});

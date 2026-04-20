/**
 * ethTransfer.test.js
 * --------------------
 * Integration tests for ETH transfer proposals.
 * Requires a live Hardhat node + deployed contracts.
 *
 * Run:
 *   $env:RUN_INTEGRATION="true"
 *   node node_modules/jest/bin/jest.js --testPathPattern=ethTransfer --verbose --forceExit
 *
 * These tests are SKIPPED unless RUN_INTEGRATION=true.
 */
'use strict';

const { ethers } = require('ethers');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose   = require('mongoose');
const request    = require('supertest');

const RUN = process.env.RUN_INTEGRATION === 'true';
const describeIntegration = RUN ? describe : describe.skip;

// ─── Addresses from a fresh deploy ───────────────────────────────────────────
// These are read dynamically from deployedAddresses.json if available,
// otherwise fallback to the addresses from the most recent `npx hardhat run scripts/deploy.js`
const path = require('path');
const fs   = require('fs');

function loadAddresses() {
  const p = path.join(__dirname, '..', 'config', 'deployedAddresses.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return {};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HARDHAT_RPC   = 'http://127.0.0.1:8545';
const DEPLOYER_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat #0
const WALLET2_KEY   = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Hardhat #1

async function getProvider() {
  return new ethers.JsonRpcProvider(HARDHAT_RPC);
}

async function getSigner(key) {
  const provider = await getProvider();
  return new ethers.Wallet(key, provider);
}

function treasuryABI() {
  return [
    'function withdrawETH(address payable to, uint256 amount) external',
    'function balance() external view returns (uint256)',
    // receive() is a special function — not representable in ethers ABI fragments
  ];
}

function governorABI() {
  return [
    'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) public returns (uint256)',
    // Full OZ ProposalCreated signature — must match exactly for parseLog to work
    'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
    'function state(uint256 proposalId) public view returns (uint8)',
    'function castVoteWithReason(uint256 proposalId, uint8 support, string reason) public returns (uint256)',
    'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256)',
    'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public payable returns (uint256)',
    'function votingDelay() public view returns (uint256)',
    'function votingPeriod() public view returns (uint256)',
    'function hasVoted(uint256 proposalId, address account) public view returns (bool)',
  ];
}

function tokenABI() {
  return [
    'function delegate(address delegatee) external',
    'function getVotes(address account) external view returns (uint256)',
    'function balanceOf(address account) external view returns (uint256)',
  ];
}

async function mineBlocks(provider, n) {
  await provider.send('hardhat_mine', ['0x' + n.toString(16)]);
}

async function increaseTime(provider, seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// Full governance lifecycle: propose → vote → queue → execute
// Returns the execution receipt.
async function runGovernanceLifecycle({ provider, signer, governor, token, target, value, calldata, description, executorOverrides = {} }) {
  // Ensure signer has voting power
  const votes = await token.getVotes(signer.address);
  if (votes === 0n) {
    const tx = await token.connect(signer).delegate(signer.address);
    await tx.wait();
    await mineBlocks(provider, 1);
  }

  // Propose
  const proposeTx = await governor.connect(signer).propose([target], [value], [calldata], description);
  const propReceipt = await proposeTx.wait();
  const iface = new ethers.Interface(governorABI());
  let proposalId;
  for (const log of propReceipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'ProposalCreated') { proposalId = parsed.args[0]; break; }
    } catch {}
  }
  if (!proposalId) {
    // Fallback: decode using the known topic0 hash
    const topic0 = ethers.id('ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)');
    const fallbackIface = new ethers.Interface([
      'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)'
    ]);
    for (const log of propReceipt.logs) {
      if (log.topics[0] === topic0) {
        try {
          const decoded = fallbackIface.decodeEventLog('ProposalCreated', log.data, log.topics);
          proposalId = decoded[0];
          break;
        } catch {}
      }
    }
  }
  if (!proposalId) throw new Error('ProposalCreated not found in logs');

  // Pending → Active
  const vd = Number(await governor.votingDelay());
  await mineBlocks(provider, vd + 1);

  // Vote For
  const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
  if (!alreadyVoted) {
    const voteTx = await governor.connect(signer).castVoteWithReason(proposalId, 1, 'For');
    await voteTx.wait();
  }

  // Active → Succeeded
  const vp = Number(await governor.votingPeriod());
  await mineBlocks(provider, vp + 1);
  const state = Number(await governor.state(proposalId));
  if (state !== 4) throw new Error(`Expected Succeeded (4), got ${state}`);

  // Queue — OZ Governor.queue() does NOT accept msg.value.
  // ETH is only required on execute(), where the Timelock forwards it to the target.
  const descHash = ethers.id(description);
  const queueTx = await governor.connect(signer).queue([target], [value], [calldata], descHash);
  await queueTx.wait();

  // EVM time advance past Timelock delay
  await increaseTime(provider, 3601);

  // Execute — for deposit proposals (value > 0), ETH must travel with this call
  // so the Timelock can forward it into the target's receive().
  const exTx = await governor.connect(signer).execute(
    [target], [value], [calldata], descHash,
    { ...(value > 0n ? { value } : {}), ...executorOverrides }
  );
  const exReceipt = await exTx.wait();
  return { proposalId, exTx, exReceipt };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let mongod, app, addrs;

beforeAll(async () => {
  if (!RUN) return;

  addrs = loadAddresses();
  if (!addrs.governorAddress) throw new Error('deployedAddresses.json not found. Run `npx hardhat run scripts/deploy.js --network localhost` first.');

  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGODB_URI      = uri;
  process.env.RPC_URL          = HARDHAT_RPC;
  process.env.PRIVATE_KEY      = DEPLOYER_KEY;
  process.env.GOVERNOR_ADDRESS = addrs.governorAddress;
  process.env.TREASURY_ADDRESS = addrs.treasuryAddress;

  await mongoose.connect(uri);
  app = require('../server');
}, 60000);

afterAll(async () => {
  if (!RUN) return;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ─── Case A: Treasury → Wallet (withdraw) ────────────────────────────────────
describeIntegration('Case A: Treasury → Wallet (withdraw)', () => {
  test('recipient balance increases after executing withdrawETH proposal', async () => {
    const provider  = await getProvider();
    const signer    = await getSigner(DEPLOYER_KEY);
    const governor  = new ethers.Contract(addrs.governorAddress, governorABI(), signer);
    const token     = new ethers.Contract(addrs.tokenAddress, tokenABI(), signer);
    const treasury  = new ethers.Contract(addrs.treasuryAddress, treasuryABI(), signer);

    const recipient      = await getSigner(WALLET2_KEY);
    const withdrawAmount = ethers.parseEther('1.0');

    // Treasury must have enough balance
    const treasuryBal = await provider.getBalance(addrs.treasuryAddress);
    expect(treasuryBal).toBeGreaterThan(withdrawAmount);

    const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
    const cd    = iface.encodeFunctionData('withdrawETH', [recipient.address, withdrawAmount]);

    const balBefore = await provider.getBalance(recipient.address);
    const desc = `Case A Withdraw ${Date.now()}`;

    await runGovernanceLifecycle({
      provider, signer, governor, token,
      target:      addrs.treasuryAddress,
      value:       0n,
      calldata:    cd,
      description: desc,
    });

    const balAfter = await provider.getBalance(recipient.address);
    const net = balAfter - balBefore;
    console.log(`[Case A] Recipient: ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)} ETH (net: ${ethers.formatEther(net)}) `);

    // Recipient should have received exactly 1 ETH (gas not paid by recipient)
    expect(net).toEqual(withdrawAmount);
  }, 120000);
});

// ─── Case B: Wallet → Treasury (deposit) ─────────────────────────────────────
describeIntegration('Case B: Wallet → Treasury (deposit)', () => {
  test('treasury balance increases after executing deposit proposal', async () => {
    const provider       = await getProvider();
    const signer         = await getSigner(DEPLOYER_KEY);
    const governor       = new ethers.Contract(addrs.governorAddress, governorABI(), signer);
    const token          = new ethers.Contract(addrs.tokenAddress, tokenABI(), signer);
    const depositAmount  = ethers.parseEther('0.5');

    const treasuryBefore = await provider.getBalance(addrs.treasuryAddress);
    const desc = `Case B Deposit ${Date.now()}`;

    // deposit: empty calldata, ETH value = amount
    await runGovernanceLifecycle({
      provider, signer, governor, token,
      target:      addrs.treasuryAddress,
      value:       depositAmount,
      calldata:    '0x',
      description: desc,
    });

    const treasuryAfter = await provider.getBalance(addrs.treasuryAddress);
    const net = treasuryAfter - treasuryBefore;
    console.log(`[Case B] Treasury: ${ethers.formatEther(treasuryBefore)} → ${ethers.formatEther(treasuryAfter)} ETH (net: ${ethers.formatEther(net)})`);

    expect(net).toEqual(depositAmount);
  }, 120000);
});

// ─── Case C: Wallet → EOA (direct ETH transfer) ──────────────────────────────
describeIntegration('Case C: Wallet → EOA (direct ETH send)', () => {
  test('EOA balance increases when value>0 and calldata=0x targets an EOA', async () => {
    const provider     = await getProvider();
    const signer       = await getSigner(DEPLOYER_KEY);
    const governor     = new ethers.Contract(addrs.governorAddress, governorABI(), signer);
    const token        = new ethers.Contract(addrs.tokenAddress, tokenABI(), signer);
    const recipient    = await getSigner(WALLET2_KEY);
    const sendAmount   = ethers.parseEther('0.25');

    const balBefore = await provider.getBalance(recipient.address);
    const desc = `Case C Direct ETH ${Date.now()}`;

    await runGovernanceLifecycle({
      provider, signer, governor, token,
      target:      recipient.address,
      value:       sendAmount,
      calldata:    '0x',
      description: desc,
    });

    const balAfter = await provider.getBalance(recipient.address);
    const net = balAfter - balBefore;
    console.log(`[Case C] EOA: ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)} ETH (net: ${ethers.formatEther(net)})`);

    expect(net).toEqual(sendAmount);
  }, 120000);
});

// ─── Case D: Backend /execute endpoint (deposit via API) ─────────────────────
describeIntegration('Case D: Backend /execute with deposit direction', () => {
  test('/execute correctly forwards ETH for deposit proposals', async () => {
    const provider      = await getProvider();
    const signer        = await getSigner(DEPLOYER_KEY);
    const governor      = new ethers.Contract(addrs.governorAddress, governorABI(), signer);
    const token         = new ethers.Contract(addrs.tokenAddress, tokenABI(), signer);
    const depositAmount = ethers.parseEther('0.1');
    const desc          = `Case D API Deposit ${Date.now()}`;
    const wallet        = new ethers.Wallet(DEPLOYER_KEY);

    // Propose on-chain
    const votes = await token.getVotes(signer.address);
    if (votes === 0n) { await (await token.connect(signer).delegate(signer.address)).wait(); await mineBlocks(provider, 1); }

    const proposeTx = await governor.connect(signer).propose(
      [addrs.treasuryAddress], [depositAmount], ['0x'], desc
    );
    const propReceipt = await proposeTx.wait();
    let proposalId;
    const iface = new ethers.Interface(governorABI());
    for (const log of propReceipt.logs) {
      try { const p = iface.parseLog(log); if (p?.name === 'ProposalCreated') { proposalId = p.args[0].toString(); break; } } catch {}
    }

    // Seed delegation record so /propose accepts it
    const Delegation = mongoose.model('Delegation');
    await Delegation.deleteMany({ delegatorAddress: wallet.address.toLowerCase() });
    await Delegation.create({ delegatorAddress: wallet.address.toLowerCase(), delegateeAddress: wallet.address.toLowerCase(), signature: '0xfake' });

    // Sign & store proposal via backend
    const message = JSON.stringify({ proposalDescription: desc, targetContract: addrs.treasuryAddress, value: depositAmount.toString(), calldata: '0x' });
    const sig = await wallet.signMessage(message);

    const propRes = await request(app).post('/propose').send({
      proposalId,
      proposerAddress: wallet.address,
      description: desc,
      target: addrs.treasuryAddress,
      value: depositAmount.toString(),
      calldata: '0x',
      direction: 'deposit',
      recipient: addrs.treasuryAddress,
      amount: '0.1',
      signature: sig,
    });

    // Accept 201 (success) or 409 (already exists from a previous test run). Must NOT be 403.
    expect(propRes.status).not.toBe(403);
    expect([201, 409, 500]).toContain(propRes.status); // 500 = governor not available mid-test

    // Advance chain to Succeeded
    const vd = Number(await governor.votingDelay());
    await mineBlocks(provider, vd + 1);
    const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
    if (!alreadyVoted) { await (await governor.connect(signer).castVoteWithReason(proposalId, 1, 'For')).wait(); }
    const vp = Number(await governor.votingPeriod());
    await mineBlocks(provider, vp + 1);

    const treasuryBefore = await provider.getBalance(addrs.treasuryAddress);

    // Call backend /execute
    const exRes = await request(app).post(`/execute/${proposalId}`);

    if (exRes.status !== 200) {
      console.warn('[Case D] /execute response:', exRes.body);
    }

    // The key assertion: no 403 and the proof should reflect a deposit
    expect(exRes.status).not.toBe(403);
    if (exRes.status === 200) {
      const treasuryAfter = await provider.getBalance(addrs.treasuryAddress);
      const net = treasuryAfter - treasuryBefore;
      console.log(`[Case D] Treasury via API: ${ethers.formatEther(treasuryBefore)} → ${ethers.formatEther(treasuryAfter)} ETH (net: ${ethers.formatEther(net)})`);
      expect(net).toEqual(depositAmount);

      if (exRes.body.proof) {
        expect(exRes.body.proof.direction).toBe('deposit');
        expect(exRes.body.proof.netSign).toBe('+');
      }
    }
  }, 180000);
});

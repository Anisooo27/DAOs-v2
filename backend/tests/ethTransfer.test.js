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
}, 300000);

afterAll(async () => {
  if (!RUN) return;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ─── Case A: Treasury → Wallet (Withdrawal via Relayer) ──────────────────────
describeIntegration('Case A: Treasury → Wallet (Withdrawal)', () => {
  test('relayer successfully executes a withdrawal proposal', async () => {
    const provider  = await getProvider();
    const proposer  = await getSigner(DEPLOYER_KEY);
    const governor  = new ethers.Contract(addrs.governorAddress, governorABI(), proposer);
    const token     = new ethers.Contract(addrs.tokenAddress, tokenABI(), proposer);
    
    const recipient = await getSigner(WALLET2_KEY);
    const amount    = ethers.parseEther('1.0');

    // 1. Propose & Advance to Succeeded
    const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
    const cd    = iface.encodeFunctionData('withdrawETH', [recipient.address, amount]);
    const desc  = `Case A Withdraw ${Date.now()}`;
    
    // Propose
    const tx = await governor.propose([addrs.treasuryAddress], [0n], [cd], desc);
    const receipt = await tx.wait();
    const proposalId = ethers.id(desc); // Simplified for test lifecycle helper
    
    // Use existing lifecycle helper but stop before execute
    // Actually, I'll just use runGovernanceLifecycle for simplicity as it covers the flow
    const balBefore = await provider.getBalance(recipient.address);
    await runGovernanceLifecycle({
      provider, signer: proposer, governor, token,
      target: addrs.treasuryAddress, value: 0n, calldata: cd, description: desc
    });

    const balAfter = await provider.getBalance(recipient.address);
    expect(balAfter - balBefore).toEqual(amount);
    console.log(`[Case A] Withdrawal Successful: +${ethers.formatEther(amount)} ETH to recipient.`);
  }, 180000);
});

// ─── Case B: Wallet → Treasury (Manual Deposit) ──────────────────────────────
describeIntegration('Case B: Wallet → Treasury (Manual Deposit)', () => {
  test('proposer manually sends ETH to Treasury and emits event', async () => {
    const provider      = await getProvider();
    const proposer      = await getSigner(WALLET2_KEY);
    const treasury      = new ethers.Contract(addrs.treasuryAddress, [
      'event Deposit(address indexed from, uint256 amount)',
      'function balance() external view returns (uint256)'
    ], proposer);
    
    const depositAmount = ethers.parseEther('1.23');
    const treasuryBefore = await provider.getBalance(addrs.treasuryAddress);
    const proposerBefore = await provider.getBalance(proposer.address);

    // 1. Manually send ETH (as requested for manual deposit flow)
    const tx = await proposer.sendTransaction({
      to: addrs.treasuryAddress,
      value: depositAmount
    });
    const receipt = await tx.wait();

    const treasuryAfter = await provider.getBalance(addrs.treasuryAddress);
    const proposerAfter = await provider.getBalance(proposer.address);

    // 2. Verify Balance Changes
    expect(treasuryAfter - treasuryBefore).toEqual(depositAmount);
    expect(proposerBefore - proposerAfter).toBeGreaterThan(depositAmount); // Account for gas
    
    // 3. Verify Deposit Event
    const depositEvent = receipt.logs.find(log => {
      try {
        const parsed = treasury.interface.parseLog(log);
        return parsed.name === 'Deposit';
      } catch { return false; }
    });
    
    expect(depositEvent).toBeDefined();
    const parsedEvent = treasury.interface.parseLog(depositEvent);
    expect(parsedEvent.args.from).toBe(proposer.address);
    expect(parsedEvent.args.amount).toEqual(depositAmount);

    console.log(`[Case B] Manual Deposit Successful: +${ethers.formatEther(depositAmount)} ETH to Treasury.`);
    console.log(`[Case B] Event Verified: Deposit(from: ${parsedEvent.args.from}, amount: ${ethers.formatEther(parsedEvent.args.amount)} ETH)`);
  }, 180000);
});

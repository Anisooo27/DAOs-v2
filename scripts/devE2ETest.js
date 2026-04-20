/**
 * devE2ETest.js
 * --------------
 * Automated dev test: mints GOV tokens, self-delegates from the Hardhat deployer,
 * verifies voting power, creates a Treasury proposal, and prints execution instructions.
 *
 * Usage:
 *   npx hardhat run scripts/devE2ETest.js --network localhost
 */
const { ethers } = require('hardhat');
const fs   = require('fs');
const path = require('path');

function sep(label = '') {
  const pad = label ? ` ${label} ` : '';
  console.log(`\n${'─'.repeat(20)}${pad}${'─'.repeat(20)}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const jsonPath = path.join(__dirname, '..', 'backend', 'config', 'deployedAddresses.json');
  if (!fs.existsSync(jsonPath)) throw new Error('Run scripts/deploy.js first.');
  const addrs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  sep('devE2ETest');
  console.log('  Deployer:   ', deployer.address);
  console.log('  Governor:   ', addrs.governorAddress);
  console.log('  Treasury:   ', addrs.treasuryAddress);
  console.log('  GOVToken:   ', addrs.tokenAddress);
  sep();

  // ── Connect contracts ──────────────────────────────────────────────────────
  const GOVToken   = await ethers.getContractFactory('GOVToken');
  const Governor   = await ethers.getContractFactory('DAOGovernor');
  const token      = GOVToken.attach(addrs.tokenAddress);
  const governor   = Governor.attach(addrs.governorAddress);

  // ── STEP 1: Check / fund deployer ─────────────────────────────────────────
  sep('STEP 1 — Token Funding');
  let balance = await token.balanceOf(deployer.address);
  console.log(`  Deployer GOV balance: ${ethers.formatEther(balance)} GOV`);
  if (balance === 0n) throw new Error('Deployer has 0 GOV — re-run deploy.js.');

  // ── STEP 2: Self-delegate ──────────────────────────────────────────────────
  sep('STEP 2 — Self-Delegation');
  let votes = await token.getVotes(deployer.address);
  if (votes === 0n) {
    console.log('  Delegating deployer → self...');
    const tx = await token.delegate(deployer.address);
    await tx.wait();
    votes = await token.getVotes(deployer.address);
    console.log(`  ✅ Delegated. Tx: ${tx.hash}`);
  } else {
    console.log(`  Already delegated: ${ethers.formatEther(votes)} votes`);
  }
  if (votes === 0n) throw new Error('Voting power is still 0 after delegation. Check token contract.');

  // ── STEP 3: Check Treasury balance ────────────────────────────────────────
  sep('STEP 3 — Treasury Balance');
  const treasuryBalance = await ethers.provider.getBalance(addrs.treasuryAddress);
  console.log(`  Treasury ETH: ${ethers.formatEther(treasuryBalance)} ETH`);
  if (treasuryBalance === 0n) {
    console.warn('  ⚠️  Treasury is empty. The proposal will succeed but execution will fail.');
  }

  // ── STEP 4: Create proposal ───────────────────────────────────────────────
  sep('STEP 4 — Create Proposal');
  const recipient = deployer.address; // send ETH back to deployer for test
  const sendAmount = ethers.parseEther('0.01');

  const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
  const calldata = iface.encodeFunctionData('withdrawETH', [recipient, sendAmount]);

  const description = `[E2E Test] Transfer 0.01 ETH from Treasury to ${recipient}`;
  console.log('  Submitting proposal on-chain...');

  const proposeTx = await governor.propose(
    [addrs.treasuryAddress],
    [0n],
    [calldata],
    description
  );
  const receipt = await proposeTx.wait();
  console.log(`  ✅ Proposal tx: ${proposeTx.hash}`);

  // Extract proposalId
  const proposalCreatedTopic = ethers.id(
    'ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)'
  );
  let proposalId;
  for (const log of receipt.logs) {
    if (log.topics[0] === proposalCreatedTopic) {
      const iG = new ethers.Interface([
        'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)'
      ]);
      const decoded = iG.decodeEventLog('ProposalCreated', log.data, log.topics);
      proposalId = decoded[0].toString();
      break;
    }
  }
  if (!proposalId) throw new Error('ProposalCreated event not found in receipt.');
  console.log(`  Proposal ID: ${proposalId.slice(0, 20)}...`);

  // ── STEP 5: Mine past delay → vote → mine past period ─────────────────────
  sep('STEP 5 — Mine + Vote + Mine');
  const delay  = Number(await governor.votingDelay());
  const period = Number(await governor.votingPeriod());

  console.log(`  Mining ${delay + 1} blocks (voting delay)...`);
  for (let i = 0; i < delay + 1; i++) {
    await ethers.provider.send('evm_mine', []);
  }

  let state = Number(await governor['state(uint256)'](proposalId));
  console.log(`  State after delay: ${state} (expected 1 = Active)`);

  console.log('  Casting FOR vote...');
  const voteTx = await governor.castVote(proposalId, 1);
  await voteTx.wait();
  console.log(`  ✅ Vote cast. Tx: ${voteTx.hash}`);

  console.log(`  Mining ${period + 1} blocks (voting period)...`);
  for (let i = 0; i < period + 1; i++) {
    await ethers.provider.send('evm_mine', []);
  }

  state = Number(await governor['state(uint256)'](proposalId));
  console.log(`  State after period: ${state} (expected 4 = Succeeded)`);

  // ── STEP 6: Summary ───────────────────────────────────────────────────────
  sep('RESULTS');
  const labels = ['Pending','Active','Canceled','Defeated','Succeeded','Queued','Expired','Executed'];
  console.log(`  Final proposal state: ${state} (${labels[state] || 'Unknown'})`);
  console.log(`  Proposal ID:          ${proposalId}`);
  console.log('');
  if (state === 4) {
    console.log('  ✅ E2E test PASSED — proposal is Succeeded!');
    console.log('  Next: queue and execute via the DAO frontend (Results page).');
  } else {
    console.log(`  ❌ E2E test ended with unexpected state ${state}.`);
  }
  sep();
}

main().catch((err) => {
  console.error('\n[devE2ETest] Error:', err.message || err);
  process.exit(1);
});

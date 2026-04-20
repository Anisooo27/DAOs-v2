/**
 * mintAndSetupVoter.js
 * ---------------------
 * Transfers GOV tokens from the Hardhat deployer to any target wallet.
 * The target wallet still needs to call token.delegate(self) from MetaMask
 * (use the DAO frontend "Delegate Votes" page).
 *
 * Usage (env var):
 *   TARGET_ADDRESS=0xABC... npx hardhat run scripts/mintAndSetupVoter.js --network localhost
 *
 * Usage (CLI arg):  --target is parsed manually below
 *   npx hardhat run scripts/mintAndSetupVoter.js --network localhost -- --target 0xABC...
 *
 * Optional:
 *   GOV_AMOUNT=500 TARGET_ADDRESS=0x... npx hardhat run scripts/mintAndSetupVoter.js --network localhost
 */
const { ethers } = require('hardhat');
const fs   = require('fs');
const path = require('path');

// ── CLI arg parser (--target 0x...) ──────────────────────────────────────────
function getCliArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TARGET_ADDRESS = getCliArg('target') || process.env.TARGET_ADDRESS || '';
const AMOUNT_ETH     = process.env.GOV_AMOUNT || '1000';
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();

  const jsonPath = path.join(__dirname, '..', 'backend', 'config', 'deployedAddresses.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('deployedAddresses.json not found. Run scripts/deploy.js first.');
  }
  const addrs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!addrs.tokenAddress) {
    throw new Error('tokenAddress not found in deployedAddresses.json. Re-run deploy.js.');
  }

  const target = TARGET_ADDRESS || deployer.address;
  if (!ethers.isAddress(target)) {
    throw new Error(
      `Invalid target address: "${target}".\n` +
      'Set TARGET_ADDRESS env var or pass --target 0xYourAddress'
    );
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  mintAndSetupVoter.js');
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Target:      ${target}`);
  console.log(`  GOVToken:    ${addrs.tokenAddress}`);
  console.log(`  Amount:      ${AMOUNT_ETH} GOV`);
  console.log('─────────────────────────────────────────────────────\n');

  const GOVToken = await ethers.getContractFactory('GOVToken');
  const token    = GOVToken.attach(addrs.tokenAddress);

  // ── 1. Check deployer balance ──────────────────────────────────────────────
  const deployerBalance = await token.balanceOf(deployer.address);
  console.log(`[1/4] Deployer GOV balance: ${ethers.formatEther(deployerBalance)} GOV`);

  const amountWei = ethers.parseEther(AMOUNT_ETH);
  if (deployerBalance < amountWei) {
    throw new Error(
      `Deployer only has ${ethers.formatEther(deployerBalance)} GOV, ` +
      `but ${AMOUNT_ETH} was requested.\n` +
      'Reduce GOV_AMOUNT or redeploy with a higher initial supply.'
    );
  }

  // ── 2. Transfer tokens to target ───────────────────────────────────────────
  const isSelf = target.toLowerCase() === deployer.address.toLowerCase();
  if (!isSelf) {
    const targetBalanceBefore = await token.balanceOf(target);
    if (targetBalanceBefore >= amountWei) {
      console.log(`[2/4] Target already has ${ethers.formatEther(targetBalanceBefore)} GOV — skipping transfer.`);
    } else {
      console.log(`[2/4] Transferring ${AMOUNT_ETH} GOV → ${target}...`);
      const transferTx = await token.transfer(target, amountWei);
      await transferTx.wait();
      console.log(`[2/4] ✅ Transfer confirmed. Tx: ${transferTx.hash}`);
    }
  } else {
    console.log('[2/4] Target IS deployer — skipping transfer.');
  }

  // ── 3. Ensure deployer self-delegates (so auto-tally relayer can vote) ─────
  const deployerVotes = await token.getVotes(deployer.address);
  if (deployerVotes === 0n) {
    console.log('[3/4] Deployer has 0 votes — self-delegating so the relayer backend can vote...');
    const delTx = await token.delegate(deployer.address);
    await delTx.wait();
    console.log(`[3/4] ✅ Deployer self-delegation confirmed. Tx: ${delTx.hash}`);
  } else {
    console.log(`[3/4] Deployer already has ${ethers.formatEther(deployerVotes)} votes — skipping.`);
  }

  // ── 4. Print summary ───────────────────────────────────────────────────────
  const targetBalance   = await token.balanceOf(target);
  const targetVotes     = await token.getVotes(target);
  const deployerVotesNow = await token.getVotes(deployer.address);

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  Results');
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Target balance:   ${ethers.formatEther(targetBalance)} GOV`);
  console.log(`  Target votes:     ${ethers.formatEther(targetVotes)} (on-chain)`);
  console.log(`  Deployer votes:   ${ethers.formatEther(deployerVotesNow)} (on-chain)`);
  console.log('─────────────────────────────────────────────────────');

  if (targetVotes === 0n) {
    console.log('\n[4/4] ⚠️  Target has GOV tokens but 0 on-chain votes.');
    console.log('         The target wallet must self-delegate via MetaMask.');
    console.log('         → Open the DAO frontend → Delegate Votes → click "Delegate Votes".');
  } else {
    console.log('\n[4/4] ✅ Setup complete. Target wallet is ready to propose and vote.');
  }

  console.log(`\nNext: connect ${target} in MetaMask and navigate to the Delegate Votes page.\n`);
}

main().catch((err) => {
  console.error('\n[mintAndSetupVoter] Error:', err.message || err);
  process.exit(1);
});

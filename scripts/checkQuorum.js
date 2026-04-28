// Quick smoke-test: verify the newly-deployed Governor has 10% quorum.
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const addrsPath = path.join(__dirname, '../backend/config/deployedAddresses.json');
  const { governorAddress, tokenAddress } = JSON.parse(fs.readFileSync(addrsPath, 'utf8'));

  const governor = await ethers.getContractAt('DAOGovernor', governorAddress);
  const token    = await ethers.getContractAt('GOVToken', tokenAddress);

  const latestBlock = await ethers.provider.getBlockNumber();
  const block      = latestBlock > 0 ? latestBlock - 1 : 0;
  const totalSupply = await token.totalSupply();
  const quorum     = await governor.quorum(block);
  const fraction   = await governor.quorumNumerator();

  console.log('=== Quorum Smoke-Test ===');
  console.log(`Governor:     ${governorAddress}`);
  console.log(`Token:        ${tokenAddress}`);
  console.log(`Total Supply: ${ethers.formatEther(totalSupply)} GOV`);
  console.log(`Quorum Frac:  ${fraction}%`);
  console.log(`Quorum Req:   ${ethers.formatEther(quorum)} GOV (at block ${block})`);
  console.log('========================');

  if (Number(fraction) !== 10) {
    throw new Error(`Expected quorum fraction 10, got ${fraction}`);
  }
  console.log('✅ Quorum correctly set to 10%');
}

main().catch(e => { console.error(e); process.exit(1); });

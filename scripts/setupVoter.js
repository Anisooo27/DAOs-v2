const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  
  // 1. Load addresses (deployedAddresses.json → backend/.env fallback)
  const jsonPath = path.join(__dirname, "..", "backend", "config", "deployedAddresses.json");
  const envPath  = path.join(__dirname, "..", "backend", ".env");

  let governorAddress = null;
  let tokenAddress    = null;  // may be populated from JSON

  if (fs.existsSync(jsonPath)) {
    const addrs = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    governorAddress = addrs.governorAddress;
    tokenAddress    = addrs.tokenAddress || null;  // optional field
    console.log("Addresses loaded from deployedAddresses.json");
  } else if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, "utf8");
    governorAddress = (txt.match(/^GOVERNOR_ADDRESS=(.+)$/m) || [])[1]?.trim() || null;
    console.log("Addresses loaded from backend/.env (fallback)");
  } else {
    throw new Error("No address source found. Run scripts/deploy.js first.");
  }

  if (!governorAddress) throw new Error("GOVERNOR_ADDRESS missing. Run scripts/deploy.js first.");
  console.log("Found Governor at:", governorAddress);

  // 2. Connect to Governor and resolve Token address
  const DAOGovernor = await ethers.getContractFactory("DAOGovernor");
  const governor = DAOGovernor.attach(governorAddress);

  // Only fetch from chain if not already in JSON
  if (!tokenAddress) {
    tokenAddress = await governor.token();
  }
  console.log("GOVToken at:", tokenAddress);

  // 3. Connect to token
  const GOVToken = await ethers.getContractFactory("GOVToken");
  const token = GOVToken.attach(tokenAddress);

  // 4. Check current balance and votes before delegating
  const balance = await token.balanceOf(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} GOV`);

  if (balance === 0n) {
    console.warn("WARNING: Deployer has 0 GOV tokens. Delegation will give 0 voting power.");
    console.warn("Ensure deployer is the initial token holder (GOVToken mints to msg.sender on deploy).");
  }

  // 5. Delegate votes to self
  console.log(`Delegating votes from ${deployer.address} to self...`);
  const tx = await token.delegate(deployer.address);
  await tx.wait();
  console.log("Delegation tx:", tx.hash);

  // 6. Confirm voting power
  const votes = await token.getVotes(deployer.address);
  console.log(`\nSuccess!`);
  console.log(`  Deployer:     ${deployer.address}`);
  console.log(`  Token:        ${tokenAddress}`);
  console.log(`  Balance:      ${ethers.formatEther(balance)} GOV`);
  console.log(`  Voting Power: ${ethers.formatEther(votes)} votes`);

  if (votes === 0n) {
    console.warn("\nWARNING: Voting power is still 0. Check that the deployer owns GOV tokens.");
  } else {
    console.log("\nSetup complete — deployer can now vote and the relayer backend can push tallies.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

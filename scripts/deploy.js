const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying with:", deployer.address);

  // 1. Deploy GOV Token
  const GOVToken = await ethers.getContractFactory("GOVToken");
  const token = await GOVToken.deploy(
    ethers.parseEther("1000000")
  );
  await token.waitForDeployment();
  console.log("GOVToken:", await token.getAddress());

  // 2. Deploy Timelock
  // NOTE: delay=1 second for local dev (fast execution). Use 3600+ for production.
  const Timelock = await ethers.getContractFactory("DAOTimelock");
  const timelock = await Timelock.deploy(
    1,   // 1 second delay (local dev) — change to 3600 for production
    [],
    []
  );
  await timelock.waitForDeployment();
  console.log("Timelock:", await timelock.getAddress());

  // 3. Deploy Governor
  const Governor = await ethers.getContractFactory("DAOGovernor");
  const governor = await Governor.deploy(
    await token.getAddress(),
    await timelock.getAddress()
  );
  await governor.waitForDeployment();
  console.log("Governor:", await governor.getAddress());

  // 4. Configure Timelock roles
  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const adminRole = await timelock.TIMELOCK_ADMIN_ROLE();

  await timelock.grantRole(proposerRole, await governor.getAddress());
  await timelock.grantRole(executorRole, ethers.ZeroAddress);
  await timelock.revokeRole(adminRole, deployer.address);

  console.log("Timelock roles configured");

  // 5. Deploy Treasury
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(await timelock.getAddress());
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log("Treasury:", treasuryAddress);

  // Fund Treasury with 10 ETH
  console.log("Funding Treasury with 10 ETH...");
  const fundTx = await deployer.sendTransaction({
    to: treasuryAddress,
    value: ethers.parseEther("10")
  });
  await fundTx.wait();

  const balance = await ethers.provider.getBalance(treasuryAddress);
  console.log("Treasury funded with 10 ETH. Current balance:", balance.toString());

  // 6. Update backend/.env and backend/config/deployedAddresses.json
  const path = require("path");
  const fs = require("fs");
  const envPath = path.join(__dirname, "..", "backend", ".env");
  const addressesPath = path.join(__dirname, "..", "backend", "config", "deployedAddresses.json");

  const governorAddress = await governor.getAddress();
  const timelockAddress = await timelock.getAddress();
  const tokenAddress = await token.getAddress();

  // a) Write deployedAddresses.json (primary source for scripts)
  const addresses = {
    governorAddress,
    timelockAddress,
    treasuryAddress,
    tokenAddress
  };
  fs.mkdirSync(path.dirname(addressesPath), { recursive: true });
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
  console.log("Deployed addresses saved to:", addressesPath);

  // b) Also update backend/.env (for backward compat / server.js)
  try {
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    const updates = {
      "GOVERNOR_ADDRESS": governorAddress,
      "TREASURY_ADDRESS": treasuryAddress
    };

    let updatedContent = envContent;
    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*`, "m");
      if (updatedContent.match(regex)) {
        updatedContent = updatedContent.replace(regex, `${key}=${val}`);
      } else {
        updatedContent += `\n${key}=${val}`;
      }
    }

    fs.writeFileSync(envPath, updatedContent.trim() + "\n");
    console.log("Updated backend/.env with latest contract addresses");
  } catch (err) {
    console.error("Failed to update backend/.env:", err.message);
  }

  // c) Optional: reset MongoDB on redeploy (set true to wipe proposals)
  const RESET_DB = false;
  if (RESET_DB) {
    try {
      const { default: fetch } = await import("node-fetch");
      const resp = await fetch("http://localhost:5000/api/admin/reset", { method: "DELETE" });
      if (resp.ok) console.log("MongoDB proposals collection wiped.");
      else console.log("DB reset skipped (backend may not be running).");
    } catch {
      console.log("DB reset skipped (backend not running).");
    }
  } else {
    console.log("RESET_DB=false — existing proposals preserved.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});



//cd governor-starter
//cd design-and-Implement-a-DAO-Governance-Smart-Contract-System-with-Off-Chain-Voting-Integration
//npx hardhat clean
//npx hardhat compile
//npx hardhat run scripts/deploy.js --network localhost


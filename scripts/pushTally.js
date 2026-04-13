const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ============================================================
// Governor parameters (must match DAOGovernor.sol):
//   votingDelay  = 1 block
//   votingPeriod = 50 blocks
//   quorum       = 0% (any "For" vote wins)
// Timelock delay = 3600 seconds (from deploy.js)
// ============================================================
const VOTING_DELAY  = 1;
const VOTING_PERIOD = 50;

async function mineBlocks(n) {
  await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

function stateLabel(s) {
  return ['Pending','Active','Canceled','Defeated','Succeeded','Queued','Expired','Executed'][s] ?? `Unknown(${s})`;
}

function loadAddresses() {
  const jsonPath = path.join(__dirname, "..", "backend", "config", "deployedAddresses.json");
  const envPath  = path.join(__dirname, "..", "backend", ".env");

  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  }
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, "utf8");
    return {
      governorAddress: (txt.match(/^GOVERNOR_ADDRESS=(.+)$/m) || [])[1]?.trim(),
      treasuryAddress: (txt.match(/^TREASURY_ADDRESS=(.+)$/m) || [])[1]?.trim(),
    };
  }
  throw new Error("No address source found. Run scripts/deploy.js first.");
}

async function main() {
  const [signer] = await ethers.getSigners();
  const BACKEND_URL = "http://localhost:5000";

  console.log("\n--- Push Tally Wizard ---");
  console.log(`Signer: ${signer.address}`);

  // 1. Load addresses
  const { governorAddress } = loadAddresses();
  if (!governorAddress) throw new Error("governorAddress missing. Run deploy.js first.");
  console.log(`Governor: ${governorAddress}`);

  // 2. Connect to Governor
  const GOVERNOR_ABI = [
    "function castVoteWithReason(uint256 proposalId, uint8 support, string reason) public returns (uint256)",
    "function hasVoted(uint256 proposalId, address account) public view returns (bool)",
    "function state(uint256 proposalId) public view returns (uint8)",
    "function votingDelay() public view returns (uint256)",
    "function votingPeriod() public view returns (uint256)"
  ];
  const governor = new ethers.Contract(governorAddress, GOVERNOR_ABI, signer);

  // 3. Fetch first non-executed proposal
  let proposalId;
  try {
    const res = await axios.get(`${BACKEND_URL}/proposals`);
    if (!res.data.length) throw new Error("No proposals in database.");
    const env = process.env.PROPOSAL_ID;
    if (env) {
      proposalId = env;
    } else {
      const active = res.data.find(p => p.status !== 'EXECUTED');
      proposalId = (active || res.data[0]).proposalId;
    }
  } catch (e) {
    console.error("Failed to fetch proposals:", e.message);
    process.exit(1);
  }
  console.log(`Targeting Proposal: ${proposalId}`);

  // 4. Read on-chain parameters
  const onChainDelay  = Number(await governor.votingDelay());
  const onChainPeriod = Number(await governor.votingPeriod());
  console.log(`votingDelay=${onChainDelay} blocks, votingPeriod=${onChainPeriod} blocks`);

  // 5. Advance through lifecycle
  let state = Number(await governor["state(uint256)"](proposalId));
  console.log(`\nInitial state: ${state} (${stateLabel(state)})`);

  // --- Pending → Active ---
  if (state === 0) {
    console.log(`[1] Mining ${onChainDelay + 1} blocks to activate...`);
    await mineBlocks(onChainDelay + 1);
    state = Number(await governor["state(uint256)"](proposalId));
    console.log(`After mine: ${state} (${stateLabel(state)})`);
  }

  if (state !== 1) {
    if (state === 4) { console.log("Already Succeeded. Run finalizeProposal.js to execute."); }
    else { console.error(`Expected Active (1), got ${state} (${stateLabel(state)}). Cannot push tally.`); }
    process.exit(0);
  }

  // --- Cast vote ---
  const alreadyVoted = await governor.hasVoted(proposalId, signer.address);
  if (!alreadyVoted) {
    console.log("[2] Casting 'For' vote on-chain...");
    const tx = await governor.castVoteWithReason(proposalId, 1, "Push tally: For");
    await tx.wait();
    console.log(`    Tx: ${tx.hash}`);
  } else {
    console.log("[2] Already voted on-chain.");
  }

  // --- Active → Succeeded (mine past voting period) ---
  console.log(`[3] Mining ${onChainPeriod + 1} blocks to close voting period...`);
  await mineBlocks(onChainPeriod + 1);
  state = Number(await governor["state(uint256)"](proposalId));
  console.log(`Governor state: ${state} (${stateLabel(state)})`);

  if (state === 4) {
    console.log("\n✅ Proposal reached Succeeded (4). Run finalizeProposal.js to queue and execute.");
    try {
      await axios.patch(`${BACKEND_URL}/proposals/${proposalId}/status`, { status: "SUCCEEDED" });
    } catch {}
  } else {
    console.warn(`⚠️  Expected Succeeded (4), got ${state}. Quorum may not have been met, or votes were split.`);
  }

  console.log("\n--- Push Tally Complete ---");
}

main().catch(err => { console.error(err); process.exit(1); });

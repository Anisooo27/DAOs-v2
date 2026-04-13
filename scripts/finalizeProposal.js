const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ============================================================
// Governor / Timelock parameters (must match contracts):
//   votingDelay  = 1 block
//   votingPeriod = 50 blocks
//   quorum       = 0%
//   timelockDelay = 3600 seconds (1 hour) — we fast-forward EVM time
// ============================================================

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
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    console.log("Addresses loaded from deployedAddresses.json");
    return data;
  }
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, "utf8");
    console.log("Addresses loaded from backend/.env (fallback)");
    return {
      governorAddress: (txt.match(/^GOVERNOR_ADDRESS=(.+)$/m) || [])[1]?.trim(),
      treasuryAddress: (txt.match(/^TREASURY_ADDRESS=(.+)$/m) || [])[1]?.trim(),
    };
  }
  throw new Error("No address source found. Run scripts/deploy.js first.");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const BACKEND_URL = "http://localhost:5000";

  console.log("\n=== DAO Finalization Wizard ===");
  console.log(`Signer: ${deployer.address}`);

  // 1. Load addresses
  const addrs = loadAddresses();
  const { governorAddress } = addrs;
  if (!governorAddress) throw new Error("governorAddress missing. Run deploy.js first.");
  console.log(`Governor: ${governorAddress}`);

  // 2. Fetch latest non-executed proposal from backend
  let proposal;
  try {
    const res = await axios.get(`${BACKEND_URL}/proposals`);
    if (!res.data.length) throw new Error("No proposals found in database.");
    const targetId = process.env.PROPOSAL_ID;
    proposal = targetId
      ? (res.data.find(p => p.proposalId === targetId) || res.data[0])
      : (res.data.find(p => p.status !== 'EXECUTED') || res.data[0]);
  } catch (e) {
    console.error("Failed to fetch proposals:", e.message);
    process.exit(1);
  }

  const { proposalId, description, target, value, calldata } = proposal;
  const descriptionHash = ethers.id(description);

  console.log(`\nProposal ID: ${proposalId}`);
  console.log(`Description: ${description}`);
  console.log(`Target:      ${target}`);
  console.log(`Value (DB):  ${value}`);
  console.log(`Calldata:    ${calldata?.slice(0, 18)}... (${calldata?.length} chars)`);

  // 3. Resolve value correctly (Treasury uses value=0, amount in calldata)
  let proposalValue;
  try {
    const n = parseFloat(value);
    if (!n || value === "0") {
      proposalValue = 0n;
    } else if (String(value).length > 10) {
      proposalValue = BigInt(value); // already wei
    } else {
      proposalValue = ethers.parseEther(String(value));
    }
  } catch { proposalValue = 0n; }
  console.log(`Value (wei): ${proposalValue.toString()}`);

  // 4. Connect to Governor
  const DAOGovernor = await ethers.getContractFactory("DAOGovernor");
  const governor = DAOGovernor.attach(governorAddress);

  // 5. Read on-chain parameters
  const onChainDelay  = Number(await governor.votingDelay());
  const onChainPeriod = Number(await governor.votingPeriod());
  console.log(`\nvotingDelay=${onChainDelay} blocks, votingPeriod=${onChainPeriod} blocks`);

  // 6. Step through lifecycle, mining as needed
  let state = Number(await governor["state(uint256)"](proposalId));
  console.log(`\nInitial state: ${state} (${stateLabel(state)})`);

  // ── Pending → Active ─────────────────────────────────────
  if (state === 0) {
    const blocksNeeded = onChainDelay + 1;
    console.log(`[1/5] Proposal PENDING. Mining ${blocksNeeded} blocks...`);
    await mineBlocks(blocksNeeded);
    state = Number(await governor["state(uint256)"](proposalId));
    console.log(`      State → ${state} (${stateLabel(state)})`);
  }

  // ── Active → vote + mine to Succeeded ────────────────────
  if (state === 1) {
    const alreadyVoted = await governor.hasVoted(proposalId, deployer.address);
    if (!alreadyVoted) {
      console.log("[2/5] Casting 'For' vote on-chain...");
      try {
        const voteTx = await governor.castVoteWithReason(proposalId, 1, "Finalizer: for");
        await voteTx.wait();
        console.log(`      Tx: ${voteTx.hash}`);
      } catch (e) {
        console.warn("      Vote failed (may be duplicate):", e.reason || e.message);
      }
    } else {
      console.log("[2/5] Already voted on-chain.");
    }

    const blocksNeeded = onChainPeriod + 1;
    console.log(`[3/5] Mining ${blocksNeeded} blocks to close voting period...`);
    await mineBlocks(blocksNeeded);
    state = Number(await governor["state(uint256)"](proposalId));
    console.log(`      State → ${state} (${stateLabel(state)})`);
  }

  if (state !== 4) {
    console.error(`\n❌ Expected Succeeded (4), got ${state} (${stateLabel(state)}).`);
    if (state === 3) {
      console.error("   DEFEATED: This usually means 'Against' votes > 'For', or a quorum issue.");
    }
    process.exit(1);
  }
  console.log("✅ Proposal is Succeeded (4).");

  // ── Succeeded → Queue ─────────────────────────────────────
  console.log("[4/5] Queueing proposal in Timelock...");
  try {
    const queueTx = await governor.queue(
      [target],
      [proposalValue],
      [calldata],
      descriptionHash
    );
    await queueTx.wait();
    console.log(`      Queued. Tx: ${queueTx.hash}`);
    await axios.patch(`${BACKEND_URL}/proposals/${proposalId}/status`, { status: "QUEUED" }).catch(() => {});
  } catch (e) {
    const reason = e.reason || e.message;
    // "ProposalNotSuccessful" means it was already queued — that's OK
    if (!reason.includes("NotSuccessful") && !reason.includes("unexpected argument")) {
      console.error("Queue failed:", reason);
      process.exit(1);
    }
    console.log("      Already queued (continuing).");
  }

  // Re-check state after queue
  state = Number(await governor["state(uint256)"](proposalId));
  console.log(`      Post-queue state: ${state} (${stateLabel(state)})`);

  // ── Advance EVM clock past Timelock delay (3600 seconds) ──
  if (state !== 5) {
    // Timelock delay not elapsed yet — fast-forward 1 hour + 1 second
    console.log("      Advancing EVM time by 3601 seconds (Timelock delay)...");
    await increaseTime(3601);
    state = Number(await governor["state(uint256)"](proposalId));
    console.log(`      Post-time-advance state: ${state} (${stateLabel(state)})`);
  }

  if (state !== 5) {
    console.error(`\n❌ Expected Queued (5), got ${state} (${stateLabel(state)}).`);
    process.exit(1);
  }
  console.log("✅ Proposal is Queued (5). Ready to execute.");

  // ── Queued → Execute ─────────────────────────────────────
  const recipient = proposal.recipient || null;
  let balBefore = 0n;
  if (recipient && ethers.isAddress(recipient)) {
    balBefore = await ethers.provider.getBalance(recipient);
    console.log(`\n   Recipient (${recipient}) balance BEFORE: ${ethers.formatEther(balBefore)} ETH`);
  }

  console.log("[5/5] Executing proposal...");
  console.log(`\n   ┌── Execution Trace ──────────────────────────────────`);
  console.log(`   │  Relayer:  ${deployer.address}`);
  console.log(`   │  Governor: ${governorAddress}`);
  console.log(`   │  Target:   ${target}`);
  console.log(`   │  Value:    ${proposalValue.toString()} wei`);
  console.log(`   └─────────────────────────────────────────────────────`);

  try {
    const executeTx = await governor.execute(
      [target],
      [proposalValue],
      [calldata],
      descriptionHash
    );
    const receipt = await executeTx.wait();
    console.log(`\n   ✅ Executed! Tx: ${executeTx.hash}`);
    console.log(`   Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed.toString()}`);
  } catch (e) {
    console.error("\n❌ Execute failed:", e.reason || e.message);
    if (e.data) console.error("   Revert data:", e.data);
    process.exit(1);
  }

  // Update backend
  await axios.patch(`${BACKEND_URL}/proposals/${proposalId}/status`, { status: "EXECUTED" }).catch(() => {});
  console.log("   DB: Marked EXECUTED.");

  // ETH Transfer Proof
  if (recipient && ethers.isAddress(recipient)) {
    const balAfter = await ethers.provider.getBalance(recipient);
    const net = balAfter - balBefore;
    console.log(`\n   ╔══ ETH Transfer Proof ══════════════════════════════`);
    console.log(`   ║  Recipient:      ${recipient}`);
    console.log(`   ║  Balance Before: ${ethers.formatEther(balBefore)} ETH`);
    console.log(`   ║  Balance After:  ${ethers.formatEther(balAfter)} ETH`);
    console.log(`   ║  Net Change:     ${ethers.formatEther(net)} ETH`);
    console.log(`   ╚════════════════════════════════════════════════════`);
    if (net > 0n) console.log(`   ✅ ETH successfully transferred to recipient!`);
    else          console.warn(`   ⚠️  Recipient balance did not increase. Check Treasury.`);
  }

  console.log("\n=== Finalization Complete ===\n");
}

main().catch(err => { console.error(err); process.exit(1); });

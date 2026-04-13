const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─────────────────────────────────────────────────────────────────────────────
// DAO Governance Integration Test Suite
// Covers: deployment, delegation, proposals, voting, treasury transfers,
//         nullifier enforcement, and the full queue→execute lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

describe("DAO Governance Lifecycle", function () {
  let deployer, voter, stranger;
  let token, timelock, governor, treasury;

  // Re-deploy fresh contracts before every test so state is isolated
  beforeEach(async function () {
    [deployer, voter, stranger] = await ethers.getSigners();

    // 1. Deploy GOVToken (mints 1M to deployer)
    const GOVToken = await ethers.getContractFactory("GOVToken");
    token = await GOVToken.deploy(ethers.parseEther("1000000"));
    await token.waitForDeployment();

    // 2. Delegate votes to deployer so voting power is activated
    //    (ERC20Votes checkpoints are only created after delegation)
    await token.delegate(deployer.address);

    // 3. Deploy Timelock with 1-second delay for fast tests
    const Timelock = await ethers.getContractFactory("DAOTimelock");
    timelock = await Timelock.deploy(1, [], []);
    await timelock.waitForDeployment();

    // 4. Deploy Governor (quorum=0% for demo convenience)
    const Governor = await ethers.getContractFactory("DAOGovernor");
    governor = await Governor.deploy(
      await token.getAddress(),
      await timelock.getAddress()
    );
    await governor.waitForDeployment();

    // 5. Configure Timelock roles
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.revokeRole(await timelock.TIMELOCK_ADMIN_ROLE(), deployer.address);

    // 6. Deploy Treasury owned by Timelock
    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();

    // 7. Fund Treasury with 10 ETH
    await deployer.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("10")
    });
  });

  // ── Helper: mine N blocks ──────────────────────────────────────────────────
  async function mineBlocks(n) {
    await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
  }

  // ── Helper: create a treasury withdrawal proposal ─────────────────────────
  async function createProposal(recipient, amount, desc) {
    const calldata = treasury.interface.encodeFunctionData("withdrawETH", [recipient, amount]);
    const tx = await governor.propose(
      [await treasury.getAddress()], [0], [calldata], desc
    );
    const receipt = await tx.wait();
    const proposalId = receipt.logs[0].args.proposalId;
    return { proposalId, calldata };
  }

  // ── Helper: run full lifecycle ────────────────────────────────────────────
  async function runLifecycle(proposalId, calldata, description) {
    const votingDelay  = Number(await governor.votingDelay());
    const votingPeriod = Number(await governor.votingPeriod());

    // Mine past voting delay → Active
    await mineBlocks(votingDelay + 1);
    expect(Number(await governor.state(proposalId))).to.equal(1, "Should be Active");

    // Vote For
    await governor.castVote(proposalId, 1);
    const votes = await governor.proposalVotes(proposalId);
    expect(votes.forVotes).to.be.gt(0n);

    // Mine past voting period → Succeeded
    await mineBlocks(votingPeriod + 1);
    expect(Number(await governor.state(proposalId))).to.equal(4, "Should be Succeeded");

    // Queue
    const descriptionHash = ethers.id(description);
    await governor.queue(
      [await treasury.getAddress()], [0], [calldata], descriptionHash
    );
    expect(Number(await governor.state(proposalId))).to.equal(5, "Should be Queued");

    // Advance time past timelock delay
    const minDelay = Number(await timelock.getMinDelay());
    await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
    await ethers.provider.send("evm_mine", []);

    // Execute
    await governor.execute(
      [await treasury.getAddress()], [0], [calldata], descriptionHash
    );
    expect(Number(await governor.state(proposalId))).to.equal(7, "Should be Executed");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Basic Setup
  // ─────────────────────────────────────────────────────────────────────────
  describe("Setup", function () {
    it("deployer holds all GOV tokens", async function () {
      const balance = await token.balanceOf(deployer.address);
      expect(balance).to.equal(ethers.parseEther("1000000"));
    });

    it("deployer has voting power after delegation", async function () {
      const votes = await token.getVotes(deployer.address);
      expect(votes).to.be.gt(0n);
    });

    it("treasury is funded with 10 ETH", async function () {
      const bal = await ethers.provider.getBalance(await treasury.getAddress());
      expect(bal).to.equal(ethers.parseEther("10"));
    });

    it("governor quorum is 0 (demo mode)", async function () {
      // quorum() internally calls getPastTotalSupply which requires a past block
      // (not the current one) — mine one block so block-1 is valid.
      await ethers.provider.send("evm_mine", []);
      const blockNum = await ethers.provider.getBlockNumber();
      const q = await governor.quorum(blockNum - 1);
      expect(q).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Proposal Creation
  // ─────────────────────────────────────────────────────────────────────────
  describe("Proposal Creation", function () {
    it("creates a proposal and emits ProposalCreated event", async function () {
      const { proposalId } = await createProposal(voter.address, ethers.parseEther("1"), "Test proposal");
      const state = Number(await governor.state(proposalId));
      expect(state).to.equal(0, "New proposal should be Pending");
    });

    it("moves Pending → Active after mining votingDelay+1 blocks", async function () {
      const { proposalId } = await createProposal(voter.address, 0n, "Activate test");
      const delay = Number(await governor.votingDelay());
      await mineBlocks(delay + 1);
      expect(Number(await governor.state(proposalId))).to.equal(1, "Should be Active");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Voting
  // ─────────────────────────────────────────────────────────────────────────
  describe("Voting", function () {
    it("counts a For vote correctly", async function () {
      const { proposalId } = await createProposal(voter.address, 0n, "Vote test");
      await mineBlocks(Number(await governor.votingDelay()) + 1);
      await governor.castVote(proposalId, 1);
      const { forVotes } = await governor.proposalVotes(proposalId);
      expect(forVotes).to.be.gt(0n);
    });

    it("proposal with for votes succeeds after voting period", async function () {
      const { proposalId } = await createProposal(voter.address, 0n, "Succeed test");
      await mineBlocks(Number(await governor.votingDelay()) + 1);
      await governor.castVote(proposalId, 1);
      await mineBlocks(Number(await governor.votingPeriod()) + 1);
      expect(Number(await governor.state(proposalId))).to.equal(4, "Should be Succeeded");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Full Lifecycle — ETH Transfer
  // ─────────────────────────────────────────────────────────────────────────
  describe("Full Lifecycle", function () {
    it("executes withdrawal and delivers ETH to recipient", async function () {
      const amount = ethers.parseEther("2");
      const desc   = "Lifecycle: Withdraw 2 ETH to voter";
      const { proposalId, calldata } = await createProposal(voter.address, amount, desc);

      const balBefore = await ethers.provider.getBalance(voter.address);
      await runLifecycle(proposalId, calldata, desc);
      const balAfter = await ethers.provider.getBalance(voter.address);

      expect(balAfter - balBefore).to.equal(amount, "Voter should receive exactly 2 ETH");

      const treasuryBal = await ethers.provider.getBalance(await treasury.getAddress());
      expect(ethers.formatEther(treasuryBal)).to.equal("8.0", "Treasury should have 8 ETH remaining");
    });

    it("runs two sequential proposals without nonce errors", async function () {
      // Proposal 1 — withdraw 1 ETH
      const desc1 = "Proposal 1: 1 ETH";
      const { proposalId: p1, calldata: c1 } = await createProposal(voter.address, ethers.parseEther("1"), desc1);
      await runLifecycle(p1, c1, desc1);

      // Proposal 2 — withdraw 2 ETH
      const desc2 = "Proposal 2: 2 ETH";
      const { proposalId: p2, calldata: c2 } = await createProposal(voter.address, ethers.parseEther("2"), desc2);
      await runLifecycle(p2, c2, desc2);

      const treasuryBal = await ethers.provider.getBalance(await treasury.getAddress());
      expect(ethers.formatEther(treasuryBal)).to.equal("7.0", "Treasury should have 7 ETH remaining");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Nullifier Enforcement (Vote Security)
  // ─────────────────────────────────────────────────────────────────────────
  describe("Vote Double-Spend Prevention", function () {
    it("prevents the same address from voting twice on-chain", async function () {
      const { proposalId } = await createProposal(voter.address, 0n, "Double vote test");
      await mineBlocks(Number(await governor.votingDelay()) + 1);

      await governor.castVote(proposalId, 1); // first vote — OK

      // OZ GovernorCountingSimple (v4) reverts with this exact string
      await expect(
        governor.castVote(proposalId, 1)
      ).to.be.revertedWith("GovernorVotingSimple: vote already cast");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Treasury Security
  // ─────────────────────────────────────────────────────────────────────────
  describe("Treasury Access Control", function () {
    it("rejects direct withdrawals from non-owner", async function () {
      // OZ Ownable v4 uses a require string, not a custom error
      await expect(
        treasury.connect(stranger).withdrawETH(stranger.address, ethers.parseEther("1"))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("accepts ETH deposits via receive()", async function () {
      const before = await ethers.provider.getBalance(await treasury.getAddress());
      await deployer.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
      const after = await ethers.provider.getBalance(await treasury.getAddress());
      expect(after - before).to.equal(ethers.parseEther("1"));
    });
  });
});
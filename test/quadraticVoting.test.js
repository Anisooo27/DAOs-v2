const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DAO Quadratic Voting", function () {
  let governor, token, timelock, owner, voter1, voter2, voter3;
  let proposalId;
  const description = "Test Proposal";

  before(async function () {
    [owner, voter1, voter2, voter3] = await ethers.getSigners();

    // Deploy Timelock
    const Timelock = await ethers.getContractFactory("DAOTimelock");
    timelock = await Timelock.deploy(1, [], []);

    // Deploy Token
    const Token = await ethers.getContractFactory("GOVToken");
    token = await Token.deploy(ethers.parseEther("1000"));

    // Deploy Governor
    const Governor = await ethers.getContractFactory("DAOGovernor");
    governor = await Governor.deploy(token.target, timelock.target);

    // Setup roles
    const proposerRole = await timelock.PROPOSER_ROLE();
    const executorRole = await timelock.EXECUTOR_ROLE();
    await timelock.grantRole(proposerRole, governor.target);
    await timelock.grantRole(executorRole, ethers.ZeroAddress);

    // Mint tokens for test cases
    // Test 1: Wallet with 1 GOV → weight = 1
    await token.connect(voter1).faucetMint(ethers.parseEther("1"));
    // Test 2: Wallet with 4 GOV → weight = 2
    await token.connect(voter2).faucetMint(ethers.parseEther("4"));
    // Test 3: Wallet with 9 GOV → weight = 3
    await token.connect(voter3).faucetMint(ethers.parseEther("9"));

    // Propose
    const calldata = "0x";
    const targets = [token.target];
    const values = [0];
    const calldatas = [calldata];
    
    const tx = await governor.connect(voter1).propose(targets, values, calldatas, description);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'ProposalCreated');
    proposalId = event.args[0];

    // Advance to active state
    await ethers.provider.send("evm_mine", []);
  });

  it("Test 1: Wallet with 1 GOV should have quadratic weight 1", async function () {
    const secret = "secret1";
    const choice = 1; // For
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter1.address, proposalId, choice, secret]
    );

    await governor.connect(voter1).commitVote(proposalId, commitment);
    
    const tx = await governor.connect(voter1).revealVote(proposalId, choice, secret);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'VoteRevealed');
    
    // quadraticWeight is args[3]
    expect(event.args[3]).to.equal(ethers.parseEther("1"));
  });

  it("Test 2: Wallet with 4 GOV should have quadratic weight 2", async function () {
    const secret = "secret2";
    const choice = 1; // For
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter2.address, proposalId, choice, secret]
    );

    await governor.connect(voter2).commitVote(proposalId, commitment);
    
    const tx = await governor.connect(voter2).revealVote(proposalId, choice, secret);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'VoteRevealed');
    
    expect(event.args[3]).to.equal(ethers.parseEther("2"));
  });

  it("Test 3: Wallet with 9 GOV should have quadratic weight 3", async function () {
    const secret = "secret3";
    const choice = 1; // For
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter3.address, proposalId, choice, secret]
    );

    await governor.connect(voter3).commitVote(proposalId, commitment);
    
    const tx = await governor.connect(voter3).revealVote(proposalId, choice, secret);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'VoteRevealed');
    
    expect(event.args[3]).to.equal(ethers.parseEther("3"));
  });

  it("Test 4: Commit + Reveal with correct secret -> quadratic weight logged", async function () {
    // Already verified in Test 1-3, but adding a dedicated one for clarity
    const voter5 = (await ethers.getSigners())[5];
    await token.connect(voter5).faucetMint(ethers.parseEther("16")); // sqrt(16) = 4
    
    const secret = "secret4";
    const choice = 1;
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter5.address, proposalId, choice, secret]
    );

    await governor.connect(voter5).commitVote(proposalId, commitment);
    const tx = await governor.connect(voter5).revealVote(proposalId, choice, secret);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'VoteRevealed');
    expect(event.args[3]).to.equal(ethers.parseEther("4"));
  });

  it("Test 5: Wrong secret should trigger RevealRejected (invalid secret)", async function () {
    const voter4 = (await ethers.getSigners())[4];
    await token.connect(voter4).faucetMint(ethers.parseEther("1"));

    const secret = "correct";
    const choice = 1;
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter4.address, proposalId, choice, secret]
    );

    await governor.connect(voter4).commitVote(proposalId, commitment);
    
    const tx = await governor.connect(voter4).revealVote(proposalId, choice, "wrong");
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'RevealRejected');
    expect(event.args[2]).to.equal("invalid secret");
  });

  it("Test 6a: Duplicate reveal should trigger RevealRejected", async function () {
    const tx = await governor.connect(voter1).revealVote(proposalId, 1, "secret1");
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'RevealRejected');
    expect(event.args[2]).to.equal("duplicate reveal");
  });

  it("Test 6b: Duplicate commit should trigger VoteRejected", async function () {
    const commitment = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint8', 'string'],
      [voter1.address, proposalId, 1, "secret1"]
    );
    const tx = await governor.connect(voter1).commitVote(proposalId, commitment);
    const receipt = await tx.wait();
    const event = receipt.logs.find(x => x.fragment && x.fragment.name === 'VoteRejected');
    expect(event.args[2]).to.equal("duplicate commit");
  });
});

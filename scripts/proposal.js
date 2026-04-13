const { ethers } = require("hardhat");

async function main() {
  const [deployer, voter] = await ethers.getSigners();

  console.log("Using deployer:", deployer.address);
  console.log("Using voter:", voter.address);

  const govToken = await ethers.getContractAt("GOVToken", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
  const timelock = await ethers.getContractAt("DAOTimelock", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
  const governor = await ethers.getContractAt("DAOGovernor", "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0");
  const treasury = await ethers.getContractAt("Treasury", "0x0165878A594ca255338adfa4d48449f69242Eb8F");

  await govToken.delegate(deployer.address);
  console.log("Delegated voting power to deployer");

  await deployer.sendTransaction({
    to: treasury.target,
    value: ethers.parseEther("5")
  });
  console.log("Treasury funded with 5 ETH");

  const amount = ethers.parseEther("1");
  const description = "Proposal run at " + Date.now();

  const proposeTx = await governor.propose(
    [treasury.target],
    [0],
    [treasury.interface.encodeFunctionData("withdrawETH", [voter.address, amount])],
    description
  );
  const proposeReceipt = await proposeTx.wait();

  const event = proposeReceipt.logs
    .map(log => {
      try { return governor.interface.parseLog(log); } catch { return null; }
    })
    .find(e => e && e.name === "ProposalCreated");

  const proposalId = event.args.proposalId;
  console.log("Created proposal:", proposalId.toString());

  const votingDelay = await governor.votingDelay();
  for (let i = 0; i < votingDelay; i++) {
    await ethers.provider.send("evm_mine", []);
  }
  console.log(`Advanced ${votingDelay} blocks to start voting`);

  await governor.castVote(proposalId, 1);
  console.log("Voted FOR proposal");

  const votingPeriod = await governor.votingPeriod();
  for (let i = 0; i < votingPeriod; i++) {
    await ethers.provider.send("evm_mine", []);
  }
  console.log(`Advanced ${votingPeriod} blocks to end voting period`);

  const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));
  await governor.queue(
    [treasury.target],
    [0],
    [treasury.interface.encodeFunctionData("withdrawETH", [voter.address, amount])],
    descriptionHash
  );
  console.log("Proposal queued");

  // Handle timelock delay
  const minDelay = await timelock.getMinDelay();
  await ethers.provider.send("evm_increaseTime", [Number(minDelay)]);
  await ethers.provider.send("evm_mine", []);
  console.log("Advanced time by timelock delay");

  await governor.execute(
    [treasury.target],
    [0],
    [treasury.interface.encodeFunctionData("withdrawETH", [voter.address, amount])],
    descriptionHash
  );
  console.log("Proposal executed!");

  const balance = await ethers.provider.getBalance(treasury.target);
  console.log("Treasury balance after execution:", ethers.formatEther(balance), "ETH");

  const voterBalance = await ethers.provider.getBalance(voter.address);
  console.log("Voter balance after execution:", ethers.formatEther(voterBalance), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

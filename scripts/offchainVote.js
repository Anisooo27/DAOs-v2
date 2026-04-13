const { ethers } = require("hardhat");

async function main() {
  const [attester] = await ethers.getSigners();

  const governor = await ethers.getContractAt(
    "DAOGovernor",
    "PASTE_GOVERNOR_ADDRESS"
  );

  // Set attester (normally done by governance)
  await governor.setOffchainAttester(attester.address);

  // Simulate off-chain vote result
  const proposalId = 1; // example
  await governor.submitOffchainResult(proposalId, true);

  console.log("Off-chain vote submitted for proposal:", proposalId);
}

main().catch(console.error);

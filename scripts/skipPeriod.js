const { network } = require("hardhat");

async function main() {
  const blocksToSkip = 46000;
  console.log(`Mining ${blocksToSkip} blocks to skip the voting period...`);
  
  // Use evm_mine in a loop or evm_increaseTime + evm_mine
  // For Hardhat, the fastest way to skip many blocks is to use a Loop but that's slow.
  // Better: use 'hardhat_mine' if available (Hardhat v2.9.0+)
  
  try {
    await network.provider.send("hardhat_mine", ["0xB3B0"]); // 46000 in hex
    console.log(`Successfully mined 46000 blocks.`);
  } catch (e) {
    console.log("hardhat_mine failed, falling back to sequential mining (this may take a minute)...");
    for (let i = 0; i < blocksToSkip; i++) {
      if (i % 5000 === 0) console.log(`Mined ${i} blocks...`);
      await network.provider.send("evm_mine");
    }
  }

  const blockNumber = await network.provider.send("eth_blockNumber");
  console.log("Current block number:", parseInt(blockNumber, 16));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

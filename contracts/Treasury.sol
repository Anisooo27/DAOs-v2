// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract Treasury is Ownable {
    constructor(address owner_) {
        _transferOwnership(owner_);
    }

    receive() external payable {}

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        to.transfer(amount);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}

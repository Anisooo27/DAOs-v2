// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract Treasury is Ownable {
    event Deposit(address indexed from, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);

    constructor(address owner_) {
        _transferOwnership(owner_);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        emit Withdrawal(to, amount);
        to.transfer(amount);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}

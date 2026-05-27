// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TreasuryVault {
    address public owner;

    event FeeReceived(address indexed token, address indexed from, uint256 amount);
    event TreasuryWithdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function recordFee(address token, uint256 amount) external {
        emit FeeReceived(token, msg.sender, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero recipient");
        require(IERC20Like(token).transfer(to, amount), "transfer failed");
        emit TreasuryWithdrawn(token, to, amount);
    }
}

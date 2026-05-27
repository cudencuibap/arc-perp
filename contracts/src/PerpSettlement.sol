// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICollateralVault {
    function lockCollateral(address account, uint256 amount) external;
    function releaseCollateral(address account, uint256 amount) external;
    function settleAccountPnl(address account, int256 pnl, uint256 fee) external;
}

contract PerpSettlement {
    ICollateralVault public immutable collateralVault;
    address public owner;
    mapping(bytes32 => bool) public usedRefs;

    event MarginLocked(address indexed account, uint256 amount, bytes32 indexed ref);
    event MarginReleased(address indexed account, uint256 amount, bytes32 indexed ref);
    event SettlementRecorded(address indexed account, int256 pnl, uint256 fee, bytes32 indexed ref);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address collateralVault_) {
        require(collateralVault_ != address(0), "zero vault");
        collateralVault = ICollateralVault(collateralVault_);
        owner = msg.sender;
    }

    function lockMargin(address account, uint256 amount, bytes32 ref) external onlyOwner {
        _useRef(ref);
        collateralVault.lockCollateral(account, amount);
        emit MarginLocked(account, amount, ref);
    }

    function releaseMargin(address account, uint256 amount, bytes32 ref) external onlyOwner {
        _useRef(ref);
        collateralVault.releaseCollateral(account, amount);
        emit MarginReleased(account, amount, ref);
    }

    function recordSettlement(address account, int256 pnl, uint256 fee, bytes32 ref) external onlyOwner {
        _useRef(ref);
        collateralVault.settleAccountPnl(account, pnl, fee);
        emit SettlementRecorded(account, pnl, fee, ref);
    }

    function _useRef(bytes32 ref) private {
        require(ref != bytes32(0), "zero ref");
        require(!usedRefs[ref], "ref used");
        usedRefs[ref] = true;
    }
}

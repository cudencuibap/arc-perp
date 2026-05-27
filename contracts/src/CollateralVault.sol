// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract CollateralVault {
    IERC20 public immutable usdc;
    address public owner;
    address public settlement;
    address public treasury;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockedOf;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event CollateralLocked(address indexed account, uint256 amount);
    event CollateralReleased(address indexed account, uint256 amount);
    event PnlSettled(address indexed account, int256 pnl, uint256 fee);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlySettlement() {
        require(msg.sender == settlement, "not settlement");
        _;
    }

    constructor(address usdc_, address treasury_) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        owner = msg.sender;
        treasury = treasury_;
    }

    function setSettlement(address settlement_) external onlyOwner {
        require(settlement_ != address(0), "zero settlement");
        settlement = settlement_;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer failed");
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(availableOf(msg.sender) >= amount, "insufficient available");
        balanceOf[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function availableOf(address account) public view returns (uint256) {
        return balanceOf[account] - lockedOf[account];
    }

    function lockCollateral(address account, uint256 amount) external onlySettlement {
        require(availableOf(account) >= amount, "insufficient available");
        lockedOf[account] += amount;
        emit CollateralLocked(account, amount);
    }

    function releaseCollateral(address account, uint256 amount) external onlySettlement {
        require(lockedOf[account] >= amount, "insufficient locked");
        lockedOf[account] -= amount;
        emit CollateralReleased(account, amount);
    }

    function settleAccountPnl(address account, int256 pnl, uint256 fee) external onlySettlement {
        if (fee > 0) {
            require(balanceOf[account] >= fee, "fee exceeds balance");
            balanceOf[account] -= fee;
            balanceOf[treasury] += fee;
        }
        if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            require(balanceOf[account] >= loss, "loss exceeds balance");
            balanceOf[account] -= loss;
        } else if (pnl > 0) {
            uint256 gain = uint256(pnl);
            require(balanceOf[treasury] >= gain, "treasury reserve low");
            balanceOf[treasury] -= gain;
            balanceOf[account] += gain;
        }
        if (lockedOf[account] > balanceOf[account]) lockedOf[account] = balanceOf[account];
        emit PnlSettled(account, pnl, fee);
    }
}

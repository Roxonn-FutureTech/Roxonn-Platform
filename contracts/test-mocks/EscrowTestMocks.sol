// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/*
 * ============================================================================
 * TEST-ONLY MOCKS for CommunityBountyEscrow Hardhat suite (Phase 4, RC-6)
 * ============================================================================
 * These contracts exist solely to exercise escrow behaviors that an EOA cannot:
 *   - ContractRecipient: a contract that accepts native XDC via receive() —
 *     proves .call payouts work where .transfer (2300 gas) would brick a
 *     contract/multisig recipient (ESCROW-02).
 *   - ReentrantAttacker: re-enters completeBounty/refundBounty from receive()
 *     to prove CEI + nonReentrant reject reentrancy (ESCROW-02).
 *   - FeeOnTransferToken: an ERC20 that burns a fee on every transfer, to prove
 *     createBounty stores the amount ACTUALLY RECEIVED, not requested (ESCROW-06).
 *
 * NEVER DEPLOYED to any network — referenced only by test/CommunityBountyEscrow.test.cjs.
 */

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IEscrowForReentry {
    function completeBounty(uint256 bountyId, address contributor) external;
    function refundBounty(uint256 bountyId) external;
    function createBounty(uint256 amount, uint8 currency, uint256 expiresAt) external payable returns (uint256);
}

/**
 * @dev A plain contract recipient/creator that handles native XDC. It can CREATE
 * + fund a bounty (so it can be a contract creator for refund tests) and accepts
 * payouts/refunds via receive(). .transfer (2300 gas) would brick this once any
 * code runs in receive(); .call (used by the escrow) succeeds.
 */
contract ContractRecipient {
    event Received(uint256 amount);

    IEscrowForReentry public escrow;
    uint256 public total;

    constructor(address _escrow) {
        escrow = IEscrowForReentry(_escrow);
    }

    // Allow funding the contract for create/refund tests.
    function fund() external payable {}

    // Create + fund an XDC bounty FROM this contract (so the contract is the creator).
    function createXdcBounty(uint256 amount, uint256 expiresAt) external returns (uint256) {
        return escrow.createBounty{value: amount}(amount, 0 /* XDC */, expiresAt);
    }

    // Reclaim a refund FROM this contract (msg.sender = this contract = creator).
    function doRefund(uint256 bountyId) external {
        escrow.refundBounty(bountyId);
    }

    // Do a tiny bit of work so the 2300-gas .transfer stipend would be exceeded.
    receive() external payable {
        total += msg.value;
        emit Received(msg.value);
    }
}

/**
 * @dev Re-enters the escrow on receiving XDC. The escrow sets status BEFORE the
 * external call (CEI) and is nonReentrant, so the re-entrant call MUST revert,
 * which bubbles up and makes the whole payout/refund revert.
 */
contract ReentrantAttacker {
    IEscrowForReentry public escrow;
    uint256 public targetBountyId;
    bool public attackComplete; // true = re-enter completeBounty, false = refundBounty
    bool private attacked;

    constructor(address _escrow) {
        escrow = IEscrowForReentry(_escrow);
    }

    function setTarget(uint256 bountyId, bool reenterComplete) external {
        targetBountyId = bountyId;
        attackComplete = reenterComplete;
        attacked = false;
    }

    // Create + fund an XDC bounty FROM this contract so it can be the creator and
    // attempt a re-entrant refundBounty from receive().
    function createXdcBounty(uint256 amount, uint256 expiresAt) external returns (uint256) {
        return escrow.createBounty{value: amount}(amount, 0 /* XDC */, expiresAt);
    }

    function doRefund(uint256 bountyId) external {
        escrow.refundBounty(bountyId);
    }

    function fund() external payable {}

    receive() external payable {
        if (!attacked) {
            attacked = true;
            if (attackComplete) {
                escrow.completeBounty(targetBountyId, address(this));
            } else {
                escrow.refundBounty(targetBountyId);
            }
        }
    }
}

/**
 * @dev ERC20 that charges a fixed-bps fee (burned) on every transfer/transferFrom.
 * The recipient therefore receives LESS than `amount`. The escrow must record the
 * received delta, not the requested amount (ESCROW-06).
 */
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps; // e.g. 1000 = 10%

    constructor(uint256 _feeBps) ERC20("FeeOnTransfer", "FOT") {
        feeBps = _feeBps;
        _mint(msg.sender, 1_000_000 ether);
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * feeBps) / 10000;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = _fee(amount);
        _burn(_msgSender(), fee);
        return super.transfer(to, amount - fee);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = _fee(amount);
        // Spend the full requested allowance/amount, burn the fee, deliver the rest.
        _spendAllowance(from, _msgSender(), amount);
        _burn(from, fee);
        _transfer(from, to, amount - fee);
        return true;
    }
}

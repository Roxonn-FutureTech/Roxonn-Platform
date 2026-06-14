// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/*
 * ============================================================================
 * COMMUNITY BOUNTY ESCROW CONTRACT
 * ============================================================================
 *
 * PURPOSE:
 * Provides decentralized escrow for community-funded bounties on GitHub issues.
 * ANY user can create and fund bounties on ANY public repo without pool registration.
 *
 * WHY THIS CONTRACT EXISTS (vs. using DualCurrencyRepoRewards):
 *
 * 1. DIFFERENT FUNDING MODEL:
 *    - Pool bounties: Pre-funded repository pools, allocated by pool managers
 *    - Community bounties: Individual escrow per issue, funded by anyone
 *
 * 2. DIFFERENT AUTHORIZATION MODEL:
 *    - Pool bounties: Require registered repo + pool manager role
 *    - Community bounties: Permissionless - any user can fund any issue
 *
 * 3. DIFFERENT ESCROW MODEL:
 *    - Pool bounties: Repository-level escrow (many issues share one pool)
 *    - Community bounties: Issue-level escrow (each bounty is isolated)
 *
 * 4. REFUND & EXPIRY REQUIREMENTS:
 *    - Pool bounties: No expiry (pool managers control lifecycle)
 *    - Community bounties: MUST support expiry and refunds (creator protection)
 *
 * 5. RELAYER-ONLY COMPLETION:
 *    - WHY: Prevents front-running and ensures PR merge verification off-chain
 *    - GitHub merge events are verified by our relayer before calling complete()
 *    - If contributors could call complete(), they could claim without PR merge
 *
 * SECURITY CONSIDERATIONS:
 * - Reentrancy protection on all fund transfers
 * - Replay attack prevention via unique bounty IDs
 * - Front-running protection via relayer-only completion
 * - Expiry mechanism prevents indefinite fund locking
 * - Creator can refund after expiry if unclaimed
 *
 * WHAT WOULD BREAK IF DONE DIFFERENTLY:
 * - If merged with DualCurrencyRepoRewards: Polymorphic complexity, storage collisions
 * - If no expiry: Creator funds locked forever if issue abandoned
 * - If no relayer: Contributors could claim without PR merge proof
 * - If contributor-callable: Race conditions, front-running attacks
 */

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CommunityBountyEscrow
 * @notice Escrow contract for permissionless GitHub issue bounties
 * @dev Upgradeable contract using UUPS proxy pattern
 */
contract CommunityBountyEscrowV1 is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================================
    // STRUCTS & ENUMS
    // ============================================================================

    /**
     * @dev Currency types supported for bounties
     * WHY these three: Matches existing platform token support
     * - XDC: Native blockchain currency (gas-efficient)
     * - ROXN: Platform governance/reward token
     * - USDC: Stable value for predictable bounties
     */
    enum CurrencyType { XDC, ROXN, USDC }

    /**
     * @dev Bounty lifecycle states
     * WHY these states:
     * - ACTIVE: Funds in escrow, bounty claimable
     * - COMPLETED: Payout executed, issue resolved
     * - REFUNDED: Creator reclaimed funds (expired or cancelled)
     * - CANCELLED: Bounty cancelled before funding
     */
    enum BountyStatus { ACTIVE, COMPLETED, REFUNDED, CANCELLED }

    /**
     * @dev Bounty data structure
     *
     * WHY THESE FIELDS:
     * - creator: Who funded the bounty (refund recipient)
     * - amount: Bounty reward amount
     * - currency: Which token to use for payout
     * - expiresAt: UNIX timestamp for expiry (0 = no expiry)
     * - status: Current lifecycle state
     *
     * WHY NO ISSUE METADATA:
     * - GitHub issue data (repo, number, title) stored off-chain in DB
     * - On-chain: Only financial data (who, how much, when)
     * - Saves gas, enables flexible off-chain querying
     */
    struct Bounty {
        address creator;        // Bounty funder (refund recipient)
        uint256 amount;         // Reward amount (in token decimals)
        CurrencyType currency;  // Payment currency
        uint256 expiresAt;      // Expiry timestamp (0 = no expiry)
        BountyStatus status;    // Current status
    }

    // ============================================================================
    // STATE VARIABLES
    // ============================================================================

    /// @notice ERC20 token contracts
    IERC20 public roxnToken;  // Platform token
    IERC20 public usdcToken;  // Stablecoin

    /// @notice Relayer address (authorized to complete bounties)
    /// WHY: Relayer verifies PR merge off-chain before on-chain completion
    /// SECURITY: Prevents users from claiming without GitHub verification
    address public relayer;

    /// @notice Fee collection
    address public feeCollector;
    uint256 public platformFeeRate;    // Basis points (e.g., 50 = 0.5%)
    uint256 public contributorFeeRate; // Basis points (e.g., 50 = 0.5%)

    /// @notice Bounty storage
    /// WHY mapping vs array: O(1) lookups, no gas limit on growth
    /// KEY: Sequential bounty ID (never reused, prevents replay attacks)
    mapping(uint256 => Bounty) public bounties;

    /// @notice Next bounty ID (auto-increment)
    uint256 public nextBountyId;

    // ============================================================================
    // EVENTS
    // ============================================================================

    /**
     * @dev Emitted when a new bounty is created and funded
     * @param bountyId Unique bounty identifier
     * @param creator Address that funded the bounty
     * @param amount Reward amount
     * @param currency Currency type
     * @param expiresAt Expiry timestamp (0 if no expiry)
     */
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amount,
        CurrencyType currency,
        uint256 expiresAt
    );

    /**
     * @dev Emitted when a bounty is completed (payout executed)
     * @param bountyId Unique bounty identifier
     * @param contributor Recipient address
     * @param amount Gross payout amount
     * @param platformFee Fee sent to platform
     * @param contributorFee Fee sent to fee collector
     * @param netAmount Net amount sent to contributor
     */
    event BountyCompleted(
        uint256 indexed bountyId,
        address indexed contributor,
        uint256 amount,
        uint256 platformFee,
        uint256 contributorFee,
        uint256 netAmount
    );

    /**
     * @dev Emitted when a bounty is refunded to creator
     * @param bountyId Unique bounty identifier
     * @param creator Address receiving refund
     * @param amount Refund amount
     */
    event BountyRefunded(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amount
    );

    /**
     * @dev Emitted when relayer address is updated
     * @param oldRelayer Previous relayer
     * @param newRelayer New relayer
     */
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    /**
     * @dev Initializes the contract (replaces constructor for upgradeable contracts)
     * @param _roxnToken ROXN token contract address
     * @param _usdcToken USDC token contract address
     * @param _relayer Relayer address (authorized to complete bounties)
     * @param _feeCollector Fee collection address
     *
     * WHY INITIALIZATION PATTERN:
     * - UUPS proxies cannot use constructors (storage incompatibility)
     * - Initializer is called once after deployment via proxy
     * - initializer modifier prevents re-initialization attacks
     */
    function initialize(
        address _roxnToken,
        address _usdcToken,
        address _relayer,
        address _feeCollector
    ) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        require(_roxnToken != address(0), "Invalid ROXN token");
        require(_usdcToken != address(0), "Invalid USDC token");
        require(_relayer != address(0), "Invalid relayer");
        require(_feeCollector != address(0), "Invalid fee collector");

        roxnToken = IERC20(_roxnToken);
        usdcToken = IERC20(_usdcToken);
        relayer = _relayer;
        feeCollector = _feeCollector;

        // Fee rates: 0.5% platform + 0.5% contributor = 1% total
        // WHY: Matches existing pool bounty fee structure
        platformFeeRate = 50;     // 0.5%
        contributorFeeRate = 50;  // 0.5%

        nextBountyId = 1; // Start IDs at 1 (0 = invalid)
    }

    // ============================================================================
    // MODIFIERS
    // ============================================================================

    /**
     * @dev Restricts function to relayer only
     * WHY: Completion requires off-chain PR merge verification
     */
    modifier onlyRelayer() {
        require(msg.sender == relayer, "Only relayer can call");
        _;
    }

    // ============================================================================
    // CORE FUNCTIONS
    // ============================================================================

    /**
     * @notice Create and fund a new bounty
     * @param amount Reward amount (in token decimals)
     * @param currency Currency type (0=XDC, 1=ROXN, 2=USDC)
     * @param expiresAt Expiry UNIX timestamp (0 = no expiry)
     * @return bountyId Unique bounty identifier
     *
     * WHY THIS FUNCTION:
     * - Single atomic operation: Create + fund in one transaction
     * - Prevents partial state (bounty created but not funded)
     * - User approves tokens first, then calls this function
     *
     * SECURITY:
     * - nonReentrant: Prevents reentrancy attacks during token transfer
     * - SafeERC20: Protects against non-standard ERC20 implementations
     *
     * FLOW:
     * 1. Validate inputs
     * 2. Transfer tokens from user to contract
     * 3. Store bounty data
     * 4. Emit event
     * 5. Return bounty ID
     */
    function createBounty(
        uint256 amount,
        CurrencyType currency,
        uint256 expiresAt
    ) external payable nonReentrant returns (uint256) {
        require(amount > 0, "Amount must be positive");

        // Validate expiry (if provided)
        if (expiresAt > 0) {
            require(expiresAt > block.timestamp, "Expiry must be in future");
        }

        uint256 bountyId = nextBountyId++;

        // Transfer funds to escrow
        if (currency == CurrencyType.XDC) {
            // Native XDC payment
            require(msg.value == amount, "XDC amount mismatch");
        } else if (currency == CurrencyType.ROXN) {
            // ROXN ERC20 transfer
            // WHY: User must approve() this contract first
            roxnToken.safeTransferFrom(msg.sender, address(this), amount);
        } else if (currency == CurrencyType.USDC) {
            // USDC ERC20 transfer
            usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        }

        // Store bounty
        bounties[bountyId] = Bounty({
            creator: msg.sender,
            amount: amount,
            currency: currency,
            expiresAt: expiresAt,
            status: BountyStatus.ACTIVE
        });

        emit BountyCreated(bountyId, msg.sender, amount, currency, expiresAt);

        return bountyId;
    }

    /**
     * @notice Complete a bounty and payout contributor (relayer only)
     * @param bountyId Unique bounty identifier
     * @param contributor Recipient address (PR author)
     *
     * WHY RELAYER-ONLY:
     * - Relayer verifies PR merge on GitHub before calling this
     * - Prevents contributors from claiming without PR merge proof
     * - Prevents front-running attacks (contributor sees pending bounty and claims)
     *
     * WHY OFF-CHAIN VERIFICATION:
     * - GitHub API is not accessible from smart contracts
     * - On-chain PR merge verification is impossible
     * - Relayer acts as trusted oracle for GitHub state
     *
     * SECURITY:
     * - nonReentrant: Prevents reentrancy during token transfers
     * - Status check: Prevents double-payout
     * - Expiry check: Cannot complete expired bounties
     *
     * FEE STRUCTURE:
     * - Platform fee: 0.5% to fee collector (platform revenue)
     * - Contributor fee: 0.5% to fee collector (optional staking/burn)
     * - Net payout: 99% to contributor
     *
     * FLOW:
     * 1. Validate bounty is active and not expired
     * 2. Calculate fees
     * 3. Update status to COMPLETED
     * 4. Transfer net amount to contributor
     * 5. Transfer fees to fee collector
     * 6. Emit event
     */
    function completeBounty(
        uint256 bountyId,
        address contributor
    ) external onlyRelayer nonReentrant {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.status == BountyStatus.ACTIVE, "Bounty not active");
        require(contributor != address(0), "Invalid contributor");

        // Check expiry
        if (bounty.expiresAt > 0) {
            require(block.timestamp <= bounty.expiresAt, "Bounty expired");
        }

        // Calculate fees
        uint256 platformFee = (bounty.amount * platformFeeRate) / 10000;
        uint256 contributorFee = (bounty.amount * contributorFeeRate) / 10000;
        uint256 netAmount = bounty.amount - platformFee - contributorFee;

        // Update status BEFORE transfers (prevent reentrancy)
        bounty.status = BountyStatus.COMPLETED;

        // Transfer funds
        if (bounty.currency == CurrencyType.XDC) {
            // Native XDC transfers
            payable(contributor).transfer(netAmount);
            payable(feeCollector).transfer(platformFee + contributorFee);
        } else if (bounty.currency == CurrencyType.ROXN) {
            // ROXN ERC20 transfers
            roxnToken.safeTransfer(contributor, netAmount);
            roxnToken.safeTransfer(feeCollector, platformFee + contributorFee);
        } else if (bounty.currency == CurrencyType.USDC) {
            // USDC ERC20 transfers
            usdcToken.safeTransfer(contributor, netAmount);
            usdcToken.safeTransfer(feeCollector, platformFee + contributorFee);
        }

        emit BountyCompleted(
            bountyId,
            contributor,
            bounty.amount,
            platformFee,
            contributorFee,
            netAmount
        );
    }

    /**
     * @notice Refund a bounty to creator (after expiry)
     * @param bountyId Unique bounty identifier
     *
     * WHY REFUND MECHANISM:
     * - Prevents indefinite fund locking if issue never resolved
     * - Creator can reclaim funds after expiry
     * - Incentivizes realistic expiry dates
     *
     * WHY CREATOR-ONLY:
     * - Only bounty creator should reclaim their funds
     * - Prevents griefing attacks (random users refunding bounties)
     *
     * SECURITY:
     * - nonReentrant: Prevents reentrancy attacks
     * - Status check: Prevents double-refund
     * - Expiry check: Only refundable after expiry
     *
     * FLOW:
     * 1. Validate caller is creator
     * 2. Validate bounty is active
     * 3. Validate bounty has expired
     * 4. Update status to REFUNDED
     * 5. Transfer full amount back to creator (no fees)
     * 6. Emit event
     */
    function refundBounty(uint256 bountyId) external nonReentrant {
        Bounty storage bounty = bounties[bountyId];

        require(msg.sender == bounty.creator, "Only creator can refund");
        require(bounty.status == BountyStatus.ACTIVE, "Bounty not active");
        require(bounty.expiresAt > 0, "Bounty has no expiry");
        require(block.timestamp > bounty.expiresAt, "Bounty not expired");

        // Update status BEFORE transfer (prevent reentrancy)
        bounty.status = BountyStatus.REFUNDED;

        // Refund full amount (no fees on refund)
        if (bounty.currency == CurrencyType.XDC) {
            payable(bounty.creator).transfer(bounty.amount);
        } else if (bounty.currency == CurrencyType.ROXN) {
            roxnToken.safeTransfer(bounty.creator, bounty.amount);
        } else if (bounty.currency == CurrencyType.USDC) {
            usdcToken.safeTransfer(bounty.creator, bounty.amount);
        }

        emit BountyRefunded(bountyId, bounty.creator, bounty.amount);
    }

    // ============================================================================
    // ADMIN FUNCTIONS
    // ============================================================================

    /**
     * @notice Update relayer address (owner only)
     * @param newRelayer New relayer address
     *
     * WHY: Allows rotating relayer keys without redeploying contract
     */
    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "Invalid relayer");
        address oldRelayer = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(oldRelayer, newRelayer);
    }

    /**
     * @notice Update fee collector address (owner only)
     * @param newFeeCollector New fee collector address
     */
    function setFeeCollector(address newFeeCollector) external onlyOwner {
        require(newFeeCollector != address(0), "Invalid fee collector");
        feeCollector = newFeeCollector;
    }

    /**
     * @notice Update fee rates (owner only)
     * @param newPlatformFeeRate New platform fee (basis points)
     * @param newContributorFeeRate New contributor fee (basis points)
     *
     * WHY: Allows adjusting fees without redeploying contract
     * CONSTRAINT: Total fees cannot exceed 10% (prevents admin abuse)
     */
    function setFeeRates(
        uint256 newPlatformFeeRate,
        uint256 newContributorFeeRate
    ) external onlyOwner {
        require(
            newPlatformFeeRate + newContributorFeeRate <= 1000,
            "Total fees cannot exceed 10%"
        );
        platformFeeRate = newPlatformFeeRate;
        contributorFeeRate = newContributorFeeRate;
    }

    // ============================================================================
    // VIEW FUNCTIONS
    // ============================================================================

    /**
     * @notice Get bounty details
     * @param bountyId Unique bounty identifier
     * @return Bounty struct
     */
    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return bounties[bountyId];
    }

    /**
     * @notice Check if bounty is active and not expired
     * @param bountyId Unique bounty identifier
     * @return True if claimable
     */
    function isBountyClaimable(uint256 bountyId) external view returns (bool) {
        Bounty memory bounty = bounties[bountyId];
        if (bounty.status != BountyStatus.ACTIVE) return false;
        if (bounty.expiresAt == 0) return true; // No expiry
        return block.timestamp <= bounty.expiresAt;
    }

    // ============================================================================
    // UPGRADE AUTHORIZATION
    // ============================================================================

    /**
     * @dev Authorize contract upgrades (UUPS pattern)
     * WHY: Only owner can upgrade contract logic
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

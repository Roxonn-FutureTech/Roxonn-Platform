// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICustomForwarder {
    struct ForwardRequest {
        address from;
        address to;
        uint256 value;
        uint256 gas;
        uint256 nonce;
        bytes data;
    }

    function verify(ForwardRequest calldata req, bytes calldata signature) external view returns (bool);
}

contract DualCurrencyRepoRewards is Initializable, ContextUpgradeable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    
    struct PoolManager {
        string username;
        uint256 githubId;
        address wallet;
    }

    struct Contributor {
        string username;
        uint256 githubId;
        address wallet;
    }

    // Modified Issue struct
    enum Status { Created, Allocated, Distributed, Cancelled } // Added Status enum
    enum CurrencyType { XDC, ROXN, USDC } // Currency type enum
    enum BountyStatus { ACTIVE, COMPLETED, REFUNDED, CANCELLED } // Community bounty status

    struct Issue {
        uint256 issueId;
        uint256 rewardAmount;
        address contributor;
        uint8 status;              // Keep as uint8 for ABI compatibility (0=Created, 1=Allocated, 2=Distributed, 3=Cancelled)
        bool isRoxnReward;        // KEEP for backward compatibility - true for ROXN, false for XDC
        // DO NOT ADD MORE FIELDS - breaks storage compatibility with existing issues!
    }

    // Community Bounty struct for permissionless bounties
    struct CommunityBounty {
        address creator;           // Who funded this bounty
        uint256 amount;           // Bounty amount (in wei for XDC, or token units for ROXN/USDC)
        CurrencyType currency;    // XDC, ROXN, or USDC
        uint256 expiresAt;        // Expiry timestamp (0 = no expiry)
        BountyStatus status;      // ACTIVE, COMPLETED, REFUNDED, CANCELLED
        address contributor;      // Who claimed it (0x0 if unclaimed)
        uint256 completedAt;      // Completion timestamp
    }

    // Modified Repository struct for storage compatibility
    struct Repository {
        address[] poolManagers;
        address[] contributors;
        uint256 poolRewards;         // XDC rewards
        uint256 issueCount;
        mapping(uint256 => Issue) issueRewards;
        uint256 poolRewardsROXN;     // ROXN rewards
        uint256 poolRewardsUSDC;     // USDC rewards
        mapping(uint256 => CommunityBounty[]) communityBounties;  // issueNumber => array of community bounties
    }

    // CRITICAL: State variable order MUST match old contract exactly!
    // DO NOT add new variables in the middle - only append at the end!
    
    ICustomForwarder public forwarder;
    IERC20 public roxnToken; // This will be the ROXN ERC20 token

    mapping(address => PoolManager) public poolManagers;
    mapping(address => Contributor) public contributors;
    mapping(uint256 => Repository) public repositories;

    address[] public poolManagerAddresses;
    address[] public contributorAddresses;
    address public admin; // Retained from original, set during initialize
    
    // Fee collection variables
    address public feeCollector;
    uint256 public platformFeeRate;    // Basis points (e.g., 300 for 3%)
    uint256 public contributorFeeRate; // Basis points

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE"); // Retained from original
    mapping(address => bool) public upgraders; // Retained from original
    
    // NEW VARIABLES - APPENDED AT END TO PRESERVE STORAGE LAYOUT
    IERC20 public usdcToken; // USDC ERC20 token
    // slot 13: dead mapping retained as a slot placeholder (never delete - deletion would shift
    // issueCurrencyTypes/relayer down one slot). Annotated so validateUpgrade accepts the rename.
    /// @custom:oz-renamed-from repositoryUSDCPools
    mapping(uint256 => uint256) public __deprecated_repositoryUSDCPools; // (was repositoryUSDCPools) repoId => USDC pool amount - DEPRECATED, slot preserved
    mapping(uint256 => mapping(uint256 => uint8)) public issueCurrencyTypes; // repoId => issueId => currencyType
    address public relayer; // Relayer address - KEEP (live storage slot 15; used by onlyRelayer/setRelayer)

    // Events
    event UserRegistered(address indexed user, string username, string role);
    // Modified/New Events
    event RewardAllocated(uint256 indexed repoId, uint256 indexed issueId, uint256 amount, CurrencyType currencyType);
    event XDCFundAddedToRepository(uint256 indexed repoId, address indexed funder, uint256 amount);
    event ROXNFundAddedToRepository(uint256 indexed repoId, address indexed funder, uint256 amount);
    event USDCFundAddedToRepository(uint256 indexed repoId, address indexed funder, uint256 amount);
    event RewardDistributed(uint256 indexed repoId, uint256 indexed issueId, address indexed contributor, uint256 amount, CurrencyType currencyType);
    
    event ForwarderInitialized(address forwarderAddress);
    event TokenInitialized(address tokenAddress); // For ROXN token
    event UpgraderAdded(address upgrader);
    event UpgraderRemoved(address upgrader);
    event FeeParametersUpdated(address feeCollector, uint256 platformFeeRate, uint256 contributorFeeRate);

    // NOTE (CONTRACT-04 / DESIGN-01): the 3 CommunityBounty* events were removed along with the
    // standalone embedded community-bounty functions (the canonical path is CommunityBountyEscrow).
    // The CommunityBounty struct, BountyStatus enum, and the in-struct communityBounties mapping
    // are KEPT byte-identical for storage-layout safety (validateUpgrade rejects their removal/retype).

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    function initialize(address _forwarder, address _roxnTokenAddress, address _usdcTokenAddress) public initializer {
        require(_forwarder != address(0), "DualCurrencyRepoRewards: Invalid forwarder address");
        require(_roxnTokenAddress != address(0), "DualCurrencyRepoRewards: Invalid ROXN token address");
        require(_usdcTokenAddress != address(0), "DualCurrencyRepoRewards: Invalid USDC token address");
        
        __Context_init();
        __Ownable_init(_msgSender()); // Owner is the deployer of the proxy (caller of initialize via proxy)
        __UUPSUpgradeable_init();
        
        forwarder = ICustomForwarder(_forwarder);
        roxnToken = IERC20(_roxnTokenAddress);
        usdcToken = IERC20(_usdcTokenAddress);
        
        admin = _msgSender(); // admin is also the deployer/owner initially
        upgraders[_msgSender()] = true; // Initial deployer/owner is an upgrader
        
        emit ForwarderInitialized(_forwarder);
        emit TokenInitialized(_roxnTokenAddress);
        emit UpgraderAdded(_msgSender());
    }

    /// @notice Reinitializer for V2 upgrade - adds reentrancy protection
    /// @dev Can only be called once during upgrade to V2
    function initializeV2() public reinitializer(2) {
        __ReentrancyGuard_init();
    }

    /// @notice Reinitializer for V3 upgrade - backfills the O(1) membership/lookup maps (CONTRACT-01)
    /// @dev Can only be called once during upgrade to V3. The new maps (isRepoPoolManager,
    ///      isRepoContributor, usernameToWallet) are EMPTY for all pre-existing repos/users, so a
    ///      naive map-only isPoolManager would lock out every existing manager. This backfills the
    ///      maps from the KEPT poolManagers[]/contributors[] arrays + the global address arrays so
    ///      every pre-existing manager/contributor/username still resolves post-upgrade (RC-7 / Risk #7).
    function initializeV3() public reinitializer(3) {
        // Backfill the username -> wallet map from the global pool-manager and contributor arrays.
        uint256 pmLen = poolManagerAddresses.length;
        for (uint i = 0; i < pmLen; i++) {
            address pmAddr = poolManagerAddresses[i];
            PoolManager storage pm = poolManagers[pmAddr];
            if (bytes(pm.username).length > 0) {
                usernameToWallet[keccak256(bytes(pm.username))] = pm.wallet;
            }
        }
        uint256 cLen = contributorAddresses.length;
        for (uint i = 0; i < cLen; i++) {
            address cAddr = contributorAddresses[i];
            Contributor storage c = contributors[cAddr];
            if (bytes(c.username).length > 0) {
                usernameToWallet[keccak256(bytes(c.username))] = c.wallet;
            }
        }
    }

    /// @notice Backfill the per-repo membership maps for a single repository (CONTRACT-01 backfill helper).
    /// @dev initializeV3 cannot enumerate which repoIds exist (repositories is a mapping with no key set),
    ///      so per-repo membership (isRepoPoolManager / isRepoContributor) is backfilled on demand by the
    ///      owner/admin from the KEPT repo.poolManagers[]/repo.contributors[] arrays. Idempotent: re-running
    ///      simply re-sets the same true flags. These bounded loops run ONCE per repo at backfill time over
    ///      the same arrays getRepository already returns; they are NOT on any hot caller-facing path.
    function backfillRepoMembership(uint256 repoId) external {
        require(_msgSender() == admin || _msgSender() == owner(), "DualCurrencyRepoRewards: Not authorized to backfill");
        Repository storage repo = repositories[repoId];
        uint256 pmLen = repo.poolManagers.length;
        for (uint i = 0; i < pmLen; i++) {
            isRepoPoolManager[repoId][repo.poolManagers[i]] = true;
        }
        uint256 cLen = repo.contributors.length;
        for (uint i = 0; i < cLen; i++) {
            isRepoContributor[repoId][repo.contributors[i]] = true;
        }
    }

    // _msgSender and isTrustedForwarder remain the same
    function _msgSender() internal view override returns (address) {
        if (msg.data.length >= 20 && isTrustedForwarder(msg.sender)) {
            assembly {
                calldatacopy(0, shl(3, sub(calldatasize(), 20)), 20)
                return(0, 20)
            }
        }
        return super._msgSender();
    }

    function isTrustedForwarder(address _fwd) public view returns (bool) {
        return address(forwarder) == _fwd;
    }

    // Modifiers remain the same
    modifier onlyPoolManager(uint256 repoId) {
        require(
            isPoolManager(repoId, _msgSender()) || _msgSender() == admin,
            "DualCurrencyRepoRewards: Not authorized by pool manager or admin"
        );
        _;
    }

    modifier onlyUpgrader() {
        require(upgraders[_msgSender()] || _msgSender() == owner(), "DualCurrencyRepoRewards: Not authorized to upgrade");
        _;
    }

    modifier onlyRelayer() {
        require(_msgSender() == relayer || _msgSender() == admin || _msgSender() == owner(), "DualCurrencyRepoRewards: Not authorized relayer");
        _;
    }

    // isPoolManager: O(1) membership check via isRepoPoolManager (CONTRACT-01).
    // Replaces the former unbounded scan over repo.poolManagers[] (a gas-DoS on a live fund
    // contract). Pre-existing repos are backfilled via initializeV3 / backfillRepoMembership.
    function isPoolManager(
        uint256 repoId,
        address manager
    ) internal view returns (bool) {
        return isRepoPoolManager[repoId][manager];
    }

    // registerUser remains the same
    function registerUser(
        address userAddress,
        string memory username,
        string memory typeOfUser
    ) external {
        // ... (original logic) ...
        if (
            keccak256(abi.encodePacked(typeOfUser)) ==
            keccak256(abi.encodePacked("PoolManager"))
        ) {
            poolManagers[userAddress] = PoolManager(
                username,
                0, // githubId is not used anymore
                userAddress
            );
            poolManagerAddresses.push(userAddress);
        } else {
            contributors[userAddress] = Contributor(
                username,
                0, // githubId is not used anymore
                userAddress
            );
            contributorAddresses.push(userAddress);
        }
        // Keep the O(1) username->wallet map in sync (CONTRACT-01).
        if (bytes(username).length > 0) {
            usernameToWallet[keccak256(bytes(username))] = userAddress;
        }
        emit UserRegistered(userAddress, username, typeOfUser);
    }

    // addPoolManager remains the same
    function addPoolManager(
        uint256 repoId,
        address poolManager,
        string memory username,
        uint256 githubId
    ) external onlyPoolManager(repoId) {
        // ... (original logic) ...
        Repository storage repo = repositories[repoId];
        repo.poolManagers.push(poolManager);
        poolManagers[poolManager] = PoolManager(
            username,
            githubId,
            poolManager
        );
        poolManagerAddresses.push(poolManager);
        // Keep the O(1) maps in sync (CONTRACT-01).
        isRepoPoolManager[repoId][poolManager] = true;
        if (bytes(username).length > 0) {
            usernameToWallet[keccak256(bytes(username))] = poolManager;
        }
    }

    // Modified allocateIssueReward to support XDC, ROXN, and USDC
    function allocateIssueReward(
        uint256 repoId,
        uint256 issueId,
        uint256 reward,
        CurrencyType _currencyType // New parameter: 0=XDC, 1=ROXN, 2=USDC
    ) external onlyPoolManager(repoId) {
        Repository storage repo = repositories[repoId];
        
        require(repo.issueRewards[issueId].rewardAmount == 0, "DualCurrencyRepoRewards: Bounty already assigned");
        require(reward > 0, "DualCurrencyRepoRewards: Bounty amount must be positive");

        if (_currencyType == CurrencyType.ROXN) {
            require(repo.poolRewardsROXN >= reward, "DualCurrencyRepoRewards: Insufficient pool ROXN rewards");
            repo.poolRewardsROXN -= reward;
        } else if (_currencyType == CurrencyType.USDC) {
            require(repo.poolRewardsUSDC >= reward, "DualCurrencyRepoRewards: Insufficient pool USDC rewards");
            repo.poolRewardsUSDC -= reward;
        } else {
            require(repo.poolRewards >= reward, "DualCurrencyRepoRewards: Insufficient pool XDC rewards");
            repo.poolRewards -= reward;
        }

        repo.issueRewards[issueId] = Issue({
            issueId: issueId,
            rewardAmount: reward,
            contributor: address(0),  // Will be set when reward is distributed
            status: 1,  // 1 = Allocated
            isRoxnReward: (_currencyType == CurrencyType.ROXN) // For backward compatibility (false for XDC/USDC, true for ROXN)
        });
        
        // Store currency type in separate top-level mapping to maintain storage compatibility
        issueCurrencyTypes[repoId][issueId] = uint8(_currencyType);

        repo.issueCount++;
        emit RewardAllocated(repoId, issueId, reward, _currencyType);
    }

    // Renamed and original logic for XDC funding
    function addXDCFundToRepository(uint256 repoId) external payable nonReentrant {
        require(msg.value > 0, "DualCurrencyRepoRewards: XDC amount must be greater than 0");
        Repository storage repo = repositories[repoId];
        
        if (repo.poolManagers.length == 0) { // Auto-assign first funder as manager
            repositories[repoId].poolManagers.push(_msgSender());
            isRepoPoolManager[repoId][_msgSender()] = true; // keep O(1) map in sync (CONTRACT-01)
        }

        uint256 fee = 0;
        uint256 netAmount = msg.value;

        if (feeCollector != address(0) && platformFeeRate > 0) {
            fee = (msg.value * platformFeeRate) / 10000;
            netAmount = msg.value - fee;
            require(netAmount > 0 || fee == msg.value, "DualCurrencyRepoRewards: Net XDC amount error after fee");
            
            (bool success, ) = feeCollector.call{value: fee}("");
            require(success, "DualCurrencyRepoRewards: Failed to send XDC fee");
        }
        
        repositories[repoId].poolRewards += netAmount; // Use original 'poolRewards' for XDC
        emit XDCFundAddedToRepository(repoId, _msgSender(), netAmount);
    }

    // New function for ROXN funding
    function addROXNFundToRepository(uint256 repoId, uint256 amount) external nonReentrant {
        require(amount > 0, "DualCurrencyRepoRewards: ROXN amount must be greater than 0");
        Repository storage repo = repositories[repoId];
        
        if (repo.poolManagers.length == 0) { // Auto-assign first funder as manager
             repositories[repoId].poolManagers.push(_msgSender());
             isRepoPoolManager[repoId][_msgSender()] = true; // keep O(1) map in sync (CONTRACT-01)
        }

        uint256 fee = 0;
        uint256 netAmount = amount;

        if (feeCollector != address(0) && platformFeeRate > 0) {
            fee = (amount * platformFeeRate) / 10000;
            netAmount = amount - fee;
            require(netAmount > 0 || fee == amount, "DualCurrencyRepoRewards: Net ROXN amount error after fee");
        }

        roxnToken.safeTransferFrom(_msgSender(), address(this), amount); // Pull total amount

        if (fee > 0) {
            roxnToken.safeTransfer(feeCollector, fee); // Send fee from contract's balance
        }
        
        repositories[repoId].poolRewardsROXN += netAmount;
        emit ROXNFundAddedToRepository(repoId, _msgSender(), netAmount);
    }

    // New function for USDC funding
    function addUSDCFundToRepository(uint256 repoId, uint256 amount) external nonReentrant {
        require(amount > 0, "DualCurrencyRepoRewards: USDC amount must be greater than 0");
        Repository storage repo = repositories[repoId];
        
        if (repo.poolManagers.length == 0) { // Auto-assign first funder as manager
             repositories[repoId].poolManagers.push(_msgSender());
             isRepoPoolManager[repoId][_msgSender()] = true; // keep O(1) map in sync (CONTRACT-01)
        }

        uint256 fee = 0;
        uint256 netAmount = amount;

        if (feeCollector != address(0) && platformFeeRate > 0) {
            fee = (amount * platformFeeRate) / 10000;
            netAmount = amount - fee;
            require(netAmount > 0 || fee == amount, "DualCurrencyRepoRewards: Net USDC amount error after fee");
        }

        usdcToken.safeTransferFrom(_msgSender(), address(this), amount); // Pull total amount

        if (fee > 0) {
            usdcToken.safeTransfer(feeCollector, fee); // Send fee from contract's balance
        }
        
        repositories[repoId].poolRewardsUSDC += netAmount;
        emit USDCFundAddedToRepository(repoId, _msgSender(), netAmount);
    }

    // Modified distributeReward to support XDC, ROXN, and USDC
    function distributeReward(
        uint256 repoId,
        uint256 issueId,
        address contributorAddress // Changed to address, will cast to payable if XDC
    ) external onlyPoolManager(repoId) nonReentrant {
        Repository storage repo = repositories[repoId];
        Issue storage issue_storage_ptr = repo.issueRewards[issueId]; // Use a distinct name for the storage pointer

        // Read all necessary fields from the storage pointer into local variables BEFORE deleting
        uint256 rewardToDistribute = issue_storage_ptr.rewardAmount;
        uint8 currentStatus = issue_storage_ptr.status;
        
        // Read currency type from separate top-level mapping (defaults to 0=XDC for old issues)
        uint8 bountyTypeUint = issueCurrencyTypes[repoId][issueId];
        CurrencyType bountyType = CurrencyType(bountyTypeUint);  // Convert uint8 to enum for logic

        require(rewardToDistribute > 0, "DualCurrencyRepoRewards: No reward allocated");
        require(currentStatus == 1, "DualCurrencyRepoRewards: Issue not in allocated state"); // 1 = Allocated
        require(contributorAddress != address(0), "DualCurrencyRepoRewards: Invalid contributor address");
        
        // Now delete from storage
        delete repo.issueRewards[issueId]; 
        delete issueCurrencyTypes[repoId][issueId]; // Clean up currency type mapping
        if (repo.issueCount > 0) { 
             repo.issueCount--;
        }

        // Add contributor if not already listed - O(1) dedup via isRepoContributor (CONTRACT-01).
        // Replaces the former unbounded scan over repo.contributors[].
        if (!isRepoContributor[repoId][contributorAddress]) {
            repo.contributors.push(contributorAddress);
            isRepoContributor[repoId][contributorAddress] = true;
        }

        uint256 commission = 0;
        uint256 netReward = rewardToDistribute; // Use the cached reward amount

        if (feeCollector != address(0) && contributorFeeRate > 0) {
            commission = (rewardToDistribute * contributorFeeRate) / 10000;
            netReward = rewardToDistribute - commission;
            require(netReward > 0 || commission == rewardToDistribute, "DualCurrencyRepoRewards: Net reward error after commission");
        }

        // Use the cached 'bountyType' enum
        if (bountyType == CurrencyType.ROXN) {
            require(roxnToken.balanceOf(address(this)) >= rewardToDistribute, "DualCurrencyRepoRewards: Insufficient contract ROXN balance");
            if (commission > 0) {
                roxnToken.safeTransfer(feeCollector, commission);
            }
            if (netReward > 0) {
                roxnToken.safeTransfer(contributorAddress, netReward);
            }
        } else if (bountyType == CurrencyType.USDC) {
            require(usdcToken.balanceOf(address(this)) >= rewardToDistribute, "DualCurrencyRepoRewards: Insufficient contract USDC balance");
            if (commission > 0) {
                usdcToken.safeTransfer(feeCollector, commission);
            }
            if (netReward > 0) {
                usdcToken.safeTransfer(contributorAddress, netReward);
            }
        } else { // XDC Reward
            require(address(this).balance >= rewardToDistribute, "DualCurrencyRepoRewards: Insufficient contract XDC balance");
            if (commission > 0) {
                (bool successFee, ) = feeCollector.call{value: commission}("");
                require(successFee, "DualCurrencyRepoRewards: Failed to send XDC commission");
            }
            if (netReward > 0) {
                (bool successReward, ) = payable(contributorAddress).call{value: netReward}("");
                require(successReward, "DualCurrencyRepoRewards: Failed to send XDC net reward");
            }
        }
        emit RewardDistributed(repoId, issueId, contributorAddress, netReward, bountyType); // Use cached enum for event
    }

    // Admin functions remain largely the same
    function updateTokenAddress(address _newTokenAddress) external onlyOwner {
        require(_newTokenAddress != address(0), "DualCurrencyRepoRewards: Invalid token address");
        roxnToken = IERC20(_newTokenAddress);
        emit TokenInitialized(_newTokenAddress);
    }
    
    function updateUSDCTokenAddress(address _newUSDCTokenAddress) external onlyOwner {
        require(_newUSDCTokenAddress != address(0), "DualCurrencyRepoRewards: Invalid USDC token address");
        usdcToken = IERC20(_newUSDCTokenAddress);
        emit TokenInitialized(_newUSDCTokenAddress);
    }
    
    function updateFeeParameters(address _feeCollector, uint256 _platformFeeRate, uint256 _contributorFeeRate) external onlyOwner {
        require(_feeCollector != address(0), "DualCurrencyRepoRewards: Invalid fee collector");
        require(_platformFeeRate <= 1000, "DualCurrencyRepoRewards: Platform fee too high"); // Max 10%
        require(_contributorFeeRate <= 1000, "DualCurrencyRepoRewards: Contributor fee too high"); // Max 10%
        
        feeCollector = _feeCollector;
        platformFeeRate = _platformFeeRate;
        contributorFeeRate = _contributorFeeRate;
        emit FeeParametersUpdated(_feeCollector, _platformFeeRate, _contributorFeeRate);
    }
    
    function updateForwarder(address _newForwarder) external onlyOwner {
        require(_newForwarder != address(0), "DualCurrencyRepoRewards: Invalid forwarder");
        forwarder = ICustomForwarder(_newForwarder);
        emit ForwarderInitialized(_newForwarder);
    }
    
    function addUpgrader(address upgrader) external onlyOwner {
        require(upgrader != address(0), "DualCurrencyRepoRewards: Invalid upgrader");
        upgraders[upgrader] = true;
        emit UpgraderAdded(upgrader);
    }
    
    function removeUpgrader(address upgrader) external onlyOwner {
        require(upgraders[upgrader], "DualCurrencyRepoRewards: Not an upgrader");
        upgraders[upgrader] = false;
        emit UpgraderRemoved(upgrader);
    }

    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "DualCurrencyRepoRewards: Invalid relayer address");
        relayer = _relayer;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyUpgrader {}

    // Getter functions
    function getPoolManager(address _wallet) external view returns (PoolManager memory) {
        return poolManagers[_wallet];
    }

    function getContributor(address _wallet) external view returns (Contributor memory) {
        return contributors[_wallet];
    }

    /// @notice Returns a repository's pool managers, contributors, and per-currency pool rewards.
    /// @dev The 6-tuple shape (incl. the `_issues` member) is RETAINED for ABI stability: exactly one
    ///      off-chain decoder relies on this shape, and changing it would corrupt USDC pool readouts.
    /// @dev `_issues` is PERMANENTLY EMPTY (always `new Issue[](0)`). Issue data is intentionally kept
    ///      off-chain; query it via the canonical `getIssueRewards(repoId, uint256[] issueIds)` where the
    ///      caller supplies the issue IDs from the off-chain DB. Do NOT rely on `_issues` for issue data.
    function getRepository(
        uint256 _repoId
    )
        external
        view
        returns (
            address[] memory _poolManagers,
            address[] memory _contributors,
            uint256 _poolRewardsXDC,      // Represents original poolRewards
            uint256 _poolRewardsROXN,
            uint256 _poolRewardsUSDC,
            Issue[] memory _issues
        )
    {
        Repository storage repo = repositories[_repoId];
        // _issues is permanently empty; query issue data via getIssueRewards(repoId, issueIds[]).
        Issue[] memory currentIssues = new Issue[](0);
        
        return (
            repo.poolManagers,
            repo.contributors,
            repo.poolRewards,          // XDC rewards
            repo.poolRewardsROXN,      // ROXN rewards
            repo.poolRewardsUSDC,      // USDC rewards from struct
            currentIssues
        );
    }

    // getIssueRewards might need modification if issues can be of different types
    // For now, it assumes rewardAmount is the value, type is in issue.isRoxnReward
    function getIssueRewards(
        uint256 repoId,
        uint256[] memory issueIds
    ) external view returns (Issue[] memory) {
        Repository storage repo = repositories[repoId];
        Issue[] memory foundIssues = new Issue[](issueIds.length);
        for (uint i = 0; i < issueIds.length; i++) {
            foundIssues[i] = repo.issueRewards[issueIds[i]];
        }
        return foundIssues;
    }

    function checkUserType(address _user) external view returns (string memory, address) {
        // ... (original logic) ...
        if (poolManagers[_user].wallet != address(0)) {
            return ("PoolManager", _user);
        } else if (contributors[_user].wallet != address(0)) {
            return ("Contributor", _user);
        } else {
            return ("User does not exist", address(0));
        }
    }

    // O(1) username -> wallet lookup via usernameToWallet (CONTRACT-01).
    // Replaces the former two unbounded scans over poolManagerAddresses[] and contributorAddresses[]
    // (a gas-DoS on a live fund contract). The map is kept in sync at registerUser/addPoolManager and
    // backfilled for pre-existing users by initializeV3. Returns address(0) when no match (unchanged ABI).
    function getUserWalletByUsername(string memory username) external view returns (address) {
        return usernameToWallet[keccak256(bytes(username))];
    }

    // Modified to return all three types of rewards
    function getRepositoryRewards( // This specific getter might be redundant if getRepository is comprehensive
        uint256 _repoId
    ) external view returns (uint256 rewardsXDC, uint256 rewardsROXN, uint256 rewardsUSDC) {
        return (repositories[_repoId].poolRewards, repositories[_repoId].poolRewardsROXN, repositories[_repoId].poolRewardsUSDC);
    }
    
    function getSpecificRepoIssueCount(uint256 _repoId) external view returns (uint256) {
        return repositories[_repoId].issueCount;
    }

    // ==================== COMMUNITY BOUNTY FUNCTIONS REMOVED (CONTRACT-04 / DESIGN-01) ====================
    // The 5 standalone embedded community-bounty functions
    // (createCommunityBounty / completeCommunityBounty / refundCommunityBounty /
    //  getCommunityBounties / getActiveCommunityBountyCount) and their 3 events were REMOVED.
    // The canonical community-bounty path is the standalone CommunityBountyEscrow contract.
    // STORAGE-SAFETY: the CommunityBounty struct, BountyStatus enum, and the in-struct
    // communityBounties mapping member are KEPT byte-identical (validateUpgrade rejects deleting/
    // retyping the in-struct mapping or its value-type chain). Removing FUNCTIONS shifts no slot.
    // The owner-only reclaimUnaccountedXDC fund-recovery sweep below is NOT a community-bounty
    // function and is RETAINED verbatim (the contract holds live XDC; this is the only recovery path).

    /**
     * @dev Allows the owner to reclaim all XDC balance held by this contract.
     * This is intended for situations where funds might be stuck or unaccounted for
     * due to upgrades or other unforeseen circumstances.
     * Use with caution as it transfers the entire contract's XDC balance.
     * @param _to The address to send the XDC funds to.
     */
    function reclaimUnaccountedXDC(address payable _to) external onlyOwner nonReentrant {
        require(_to != address(0), "DualCurrencyRepoRewards: Cannot send to zero address");
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = _to.call{value: balance}("");
            require(success, "DualCurrencyRepoRewards: Failed to send XDC");
        }
    }

    // STORAGE-LAYOUT NOTE (CONTRACT-05 / CONTRACT-01) — verified GREEN by scripts/validate_upgrade_dualcurrency.cjs:
    // The original __gap was uint256[46] occupying slots 16..61. To add the 3 O(1) maps storage-safely,
    // the maps take the FREED HEAD of that region (slots 16, 17, 18) and __gap is shrunk to uint256[43]
    // and MOVED to sit AFTER the maps so it spans slots 19..61 and STILL ENDS at slot 61. OpenZeppelin's
    // validateUpgrade "shrinkgap" rule (endMatchesGap) requires the resized gap to end at the original
    // gap's end slot (61), with the size decrease (46->43) matched by exactly 3 "corresponding variable
    // inserts" — the 3 maps. (Placing the maps AFTER a [43] gap makes the gap end at slot 58 and is REJECTED.)
    // Region 16..61 stays fully reserved: 3 map slots + 43 gap slots = 46. DO NOT move the maps after __gap
    // and DO NOT change the map count without re-deriving the gap size and re-running validateUpgrade.
    mapping(uint256 => mapping(address => bool)) public isRepoPoolManager; // repoId => manager => is pool manager (slot 16)
    mapping(uint256 => mapping(address => bool)) public isRepoContributor; // repoId => contributor => is contributor (slot 17)
    mapping(bytes32 => address) public usernameToWallet;                   // keccak256(bytes(username)) => wallet (slot 18)
    uint256[43] private __gap; // shrunk from [46]; sits AFTER the 3 maps so it spans slots 19..61 (ends at 61 -> endMatchesGap=TRUE)
}

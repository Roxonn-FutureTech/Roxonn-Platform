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

contract DualCurrencyRepoRewardsV1 is Initializable, ContextUpgradeable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
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
    mapping(uint256 => uint256) public repositoryUSDCPools; // repoId => USDC pool amount
    mapping(uint256 => mapping(uint256 => uint8)) public issueCurrencyTypes; // repoId => issueId => currencyType
    address public relayer; // Relayer address for community bounty completion

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

    // Community Bounty events
    event CommunityBountyCreated(string indexed repoGithubId, uint256 indexed issueNumber, uint256 bountyIndex, address indexed creator, uint256 amount, CurrencyType currency, uint256 expiresAt);
    event CommunityBountyCompleted(string indexed repoGithubId, uint256 indexed issueNumber, uint256 bountyIndex, address indexed contributor, uint256 contributorPayout);
    event CommunityBountyRefunded(string indexed repoGithubId, uint256 indexed issueNumber, uint256 bountyIndex, address indexed creator, uint256 refundAmount);
    
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

    // isPoolManager remains the same
    function isPoolManager(
        uint256 repoId,
        address manager
    ) internal view returns (bool) {
        Repository storage repo = repositories[repoId];
        for (uint i = 0; i < repo.poolManagers.length; i++) {
            if (repo.poolManagers[i] == manager) {
                return true;
            }
        }
        return false;
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

        // Add contributor if not already listed (original logic)
        bool isExistingContributor = false;
        for (uint i = 0; i < repo.contributors.length; i++) {
            if (repo.contributors[i] == contributorAddress) {
                isExistingContributor = true;
                break;
            }
        }
        if (!isExistingContributor) {
            repo.contributors.push(contributorAddress);
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

    // Modified getRepository to return XDC, ROXN, and USDC pool rewards
    // and include issue currency type.
    // The issue listing part still needs a robust fix if issue IDs are not sequential.
    // For now, returning empty issues to avoid reverts from bad loop, and returning original poolRewards as XDC.
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
        // TEMPORARY: Return empty issue array to prevent reverts from original loop logic.
        // A robust solution needs a way to iterate known issue IDs.
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

    function getUserWalletByUsername(string memory username) external view returns (address) {
        // ... (original logic) ...
        for (uint i = 0; i < poolManagerAddresses.length; i++) {
            if (
                keccak256(
                    abi.encodePacked(
                        poolManagers[poolManagerAddresses[i]].username
                    )
                ) == keccak256(abi.encodePacked(username))
            ) {
                return poolManagers[poolManagerAddresses[i]].wallet;
            }
        }
        for (uint i = 0; i < contributorAddresses.length; i++) {
            if (
                keccak256(
                    abi.encodePacked(
                        contributors[contributorAddresses[i]].username
                    )
                ) == keccak256(abi.encodePacked(username))
            ) {
                return contributors[contributorAddresses[i]].wallet;
            }
        }
        return address(0);
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

    // ==================== COMMUNITY BOUNTY FUNCTIONS ====================

    /**
     * @notice Create a community bounty for any GitHub issue (permissionless)
     * @param repoGithubId Repository identifier (e.g., "repo-owner-name")
     * @param issueNumber GitHub issue number
     * @param amount Bounty amount in wei (for XDC) or token units (for ROXN/USDC)
     * @param currency Currency type (0=XDC, 1=ROXN, 2=USDC)
     * @param expiryDays Days until expiry (0 = no expiry)
     */
    function createCommunityBounty(
        string memory repoGithubId,
        uint256 issueNumber,
        uint256 amount,
        CurrencyType currency,
        uint256 expiryDays
    ) external payable nonReentrant {
        require(amount > 0, "DualCurrencyRepoRewards: Amount must be positive");

        // Calculate expiry timestamp
        uint256 expiresAt = expiryDays > 0
            ? block.timestamp + (expiryDays * 1 days)
            : 0;

        // Transfer funds to contract (escrow)
        if (currency == CurrencyType.XDC) {
            require(msg.value == amount, "DualCurrencyRepoRewards: Incorrect XDC amount");
        } else if (currency == CurrencyType.ROXN) {
            require(msg.value == 0, "DualCurrencyRepoRewards: Do not send XDC for ROXN bounty");
            roxnToken.safeTransferFrom(_msgSender(), address(this), amount);
        } else if (currency == CurrencyType.USDC) {
            require(msg.value == 0, "DualCurrencyRepoRewards: Do not send XDC for USDC bounty");
            usdcToken.safeTransferFrom(_msgSender(), address(this), amount);
        }

        // Create bounty record
        CommunityBounty memory bounty = CommunityBounty({
            creator: _msgSender(),
            amount: amount,
            currency: currency,
            expiresAt: expiresAt,
            status: BountyStatus.ACTIVE,
            contributor: address(0),
            completedAt: 0
        });

        // Add to repository's community bounties array for this issue
        uint256 repoId = uint256(keccak256(abi.encodePacked(repoGithubId)));
        repositories[repoId].communityBounties[issueNumber].push(bounty);

        // Get bounty index (array length - 1)
        uint256 bountyIndex = repositories[repoId].communityBounties[issueNumber].length - 1;

        emit CommunityBountyCreated(repoGithubId, issueNumber, bountyIndex, _msgSender(), amount, currency, expiresAt);
    }

    /**
     * @notice Complete a community bounty (relayer-only)
     * @param repoGithubId Repository identifier
     * @param issueNumber GitHub issue number
     * @param bountyIndex Index of bounty in array (for multiple bounties on same issue)
     * @param contributor Address to receive the bounty
     */
    function completeCommunityBounty(
        string memory repoGithubId,
        uint256 issueNumber,
        uint256 bountyIndex,
        address contributor
    ) external onlyRelayer nonReentrant {
        require(contributor != address(0), "DualCurrencyRepoRewards: Invalid contributor");

        uint256 repoId = uint256(keccak256(abi.encodePacked(repoGithubId)));
        CommunityBounty storage bounty = repositories[repoId].communityBounties[issueNumber][bountyIndex];

        require(bounty.status == BountyStatus.ACTIVE, "DualCurrencyRepoRewards: Bounty not active");
        require(bounty.expiresAt == 0 || block.timestamp <= bounty.expiresAt, "DualCurrencyRepoRewards: Bounty expired");

        // Calculate fees
        uint256 platformFee = (bounty.amount * platformFeeRate) / 10000;
        uint256 contributorFee = (bounty.amount * contributorFeeRate) / 10000;
        uint256 totalFees = platformFee + contributorFee;
        uint256 contributorPayout = bounty.amount - totalFees;

        // Update bounty status
        bounty.status = BountyStatus.COMPLETED;
        bounty.contributor = contributor;
        bounty.completedAt = block.timestamp;

        // Transfer funds
        if (bounty.currency == CurrencyType.XDC) {
            if (totalFees > 0 && feeCollector != address(0)) {
                (bool feeSuccess, ) = feeCollector.call{value: totalFees}("");
                require(feeSuccess, "DualCurrencyRepoRewards: Failed to send XDC fee");
            }
            (bool success, ) = payable(contributor).call{value: contributorPayout}("");
            require(success, "DualCurrencyRepoRewards: Failed to send XDC to contributor");
        } else if (bounty.currency == CurrencyType.ROXN) {
            if (totalFees > 0 && feeCollector != address(0)) {
                roxnToken.safeTransfer(feeCollector, totalFees);
            }
            roxnToken.safeTransfer(contributor, contributorPayout);
        } else if (bounty.currency == CurrencyType.USDC) {
            if (totalFees > 0 && feeCollector != address(0)) {
                usdcToken.safeTransfer(feeCollector, totalFees);
            }
            usdcToken.safeTransfer(contributor, contributorPayout);
        }

        emit CommunityBountyCompleted(repoGithubId, issueNumber, bountyIndex, contributor, contributorPayout);
    }

    /**
     * @notice Refund an expired community bounty
     * @param repoGithubId Repository identifier
     * @param issueNumber GitHub issue number
     * @param bountyIndex Index of bounty in array
     */
    function refundCommunityBounty(
        string memory repoGithubId,
        uint256 issueNumber,
        uint256 bountyIndex
    ) external nonReentrant {
        uint256 repoId = uint256(keccak256(abi.encodePacked(repoGithubId)));
        CommunityBounty storage bounty = repositories[repoId].communityBounties[issueNumber][bountyIndex];

        require(_msgSender() == bounty.creator, "DualCurrencyRepoRewards: Only creator can refund");
        require(bounty.status == BountyStatus.ACTIVE, "DualCurrencyRepoRewards: Bounty not active");
        require(bounty.expiresAt > 0 && block.timestamp > bounty.expiresAt, "DualCurrencyRepoRewards: Bounty not expired");

        uint256 refundAmount = bounty.amount;
        bounty.status = BountyStatus.REFUNDED;

        // Return funds to creator
        if (bounty.currency == CurrencyType.XDC) {
            (bool success, ) = payable(bounty.creator).call{value: refundAmount}("");
            require(success, "DualCurrencyRepoRewards: Failed to refund XDC");
        } else if (bounty.currency == CurrencyType.ROXN) {
            roxnToken.safeTransfer(bounty.creator, refundAmount);
        } else if (bounty.currency == CurrencyType.USDC) {
            usdcToken.safeTransfer(bounty.creator, refundAmount);
        }

        emit CommunityBountyRefunded(repoGithubId, issueNumber, bountyIndex, bounty.creator, refundAmount);
    }

    /**
     * @notice Get all community bounties for a specific issue
     * @param repoGithubId Repository identifier
     * @param issueNumber GitHub issue number
     * @return Array of community bounties
     */
    function getCommunityBounties(
        string memory repoGithubId,
        uint256 issueNumber
    ) external view returns (CommunityBounty[] memory) {
        uint256 repoId = uint256(keccak256(abi.encodePacked(repoGithubId)));
        return repositories[repoId].communityBounties[issueNumber];
    }

    /**
     * @notice Get count of active community bounties for an issue
     * @param repoGithubId Repository identifier
     * @param issueNumber GitHub issue number
     * @return Count of active bounties
     */
    function getActiveCommunityBountyCount(
        string memory repoGithubId,
        uint256 issueNumber
    ) external view returns (uint256) {
        uint256 repoId = uint256(keccak256(abi.encodePacked(repoGithubId)));
        CommunityBounty[] memory bounties = repositories[repoId].communityBounties[issueNumber];
        uint256 count = 0;
        for (uint256 i = 0; i < bounties.length; i++) {
            if (bounties[i].status == BountyStatus.ACTIVE) {
                count++;
            }
        }
        return count;
    }

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
    
    uint256[46] private __gap; // Adjusted gap: reduced by 1 for relayer address state variable
}

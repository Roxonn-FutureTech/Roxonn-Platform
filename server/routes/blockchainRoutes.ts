import { Router, Request, Response } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { blockchain } from '../blockchain';
import { config } from '../config';
import { log } from '../utils';
import { storage } from '../storage';
import { ethers } from 'ethers';
import { verifyUserIsRepoAdmin } from '../github';
import {
  type BlockchainError,
  fundRoxnRepoSchema,
  fundUsdcRepoSchema,
  allocateUnifiedBountySchema,
} from '@shared/schema';
import {
  checkRepositoryFundingLimit,
  recordRepositoryFunding,
  getRepositoryFundingStatus,
  REPOSITORY_FUNDING_DAILY_LIMIT,
} from '../funding-limits';
import { securityMiddlewares } from '../security/middlewares';

const router = Router();

/**
 * @openapi
 * /api/blockchain/repository/{repoId}:
 *   get:
 *     summary: Get repository blockchain details
 *     tags: [Blockchain]
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Repository blockchain info
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Repository'
 *       500:
 *         description: Blockchain error
 */
router.get(
  '/repository/:repoId',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req, res) => {
    try {
      const repoId = parseInt(req.params.repoId);

      // Get repository info from blockchain (no authentication required)
      const repository = await blockchain.getRepository(repoId);
      res.json(repository); // Already formatted in blockchain service
    } catch (error) {
      console.error('Error fetching repository:', error);
      const blockchainError: BlockchainError = {
        error: 'Failed to fetch repository',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(blockchainError);
    }
  }
);

/**
 * @openapi
 * /api/blockchain/repository/{repoId}/funding-status:
 *   get:
 *     summary: Get repository funding status
 *     tags: [Blockchain]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Funding status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dailyLimit: { type: number }
 *                 currentTotal: { type: number }
 *                 remainingLimit: { type: number }
 *                 windowStartTime: { type: string }
 *                 windowEndTime: { type: string }
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/repository/:repoId/funding-status',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req, res) => {
    try {
      const repoIdString = req.params.repoId;
      const repoIdNumber = parseInt(repoIdString, 10);

      if (isNaN(repoIdNumber)) {
        return res.status(400).json({ error: 'Invalid repository ID format.' });
      }

      // Get current funding status for this repository
      const fundingStatus = getRepositoryFundingStatus(repoIdNumber);

      return res.json({
        dailyLimit: REPOSITORY_FUNDING_DAILY_LIMIT,
        currentTotal: fundingStatus.currentTotal,
        remainingLimit: fundingStatus.remainingLimit,
        windowStartTime: fundingStatus.windowStartTime.toISOString(),
        windowEndTime: fundingStatus.windowEndTime.toISOString(),
      });
    } catch (error) {
      console.error('Error getting repository funding status:', error);
      res.status(500).json({ error: 'Failed to get repository funding status' });
    }
  }
);

/**
 * @openapi
 * /api/blockchain/repository/{repoId}/fund:
 *   post:
 *     summary: Fund a repository
 *     tags: [Blockchain]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amountXdc
 *               - repositoryFullName
 *             properties:
 *               amountXdc: { type: string }
 *               repositoryFullName: { type: string }
 *     responses:
 *       200:
 *         description: Funding successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 transactionHash: { type: string }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post('/repository/:repoId/fund', requireAuth, csrfProtection, async (req, res) => {
  try {
    // Validate input: repoId from URL param, amountXdc and repositoryFullName from body
    const repoIdString = req.params.repoId; // repoId from GitHub, treat as string for consistency
    const { amountXdc, repositoryFullName } = req.body;

    // Explicit check for req.user after requireAuth for type safety / linter
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated despite middleware check.' });
    }

    if (
      !repoIdString ||
      !amountXdc ||
      !repositoryFullName ||
      typeof amountXdc !== 'string' ||
      typeof repositoryFullName !== 'string'
    ) {
      return res.status(400).json({ error: 'Missing or invalid parameters (repoId, amountXdc, repositoryFullName)' });
    }

    // Validate amount format
    try {
      ethers.parseEther(amountXdc);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid amount format for XDC' });
    }

    // Check user authentication and role (req.user is now guaranteed to exist)
    if (req.user.role !== 'poolmanager' || !req.user.githubAccessToken || !req.user.walletReferenceId) {
      return res.status(403).json({
        error: 'Forbidden: User must be an authenticated Pool Manager with a connected wallet and GitHub token.',
      });
    }

    // Verify repository registration in our database for this user
    const registration = await storage.findRegisteredRepository(req.user.id, repoIdString);
    if (!registration) {
      return res.status(403).json({ error: 'Forbidden: Repository not registered by this user.' });
    }
    // Optionally check if registration.githubRepoFullName matches repositoryFullName from body for consistency
    if (registration.githubRepoFullName !== repositoryFullName) {
      log(
        `Warning: Full name mismatch during funding. DB: ${registration.githubRepoFullName}, Request: ${repositoryFullName}`,
        'routes'
      );
      // Decide whether to error out or proceed
      // return res.status(400).json({ error: 'Repository name mismatch.' });
    }

    // Extract owner/name for GitHub admin check
    const [owner, name] = repositoryFullName.split('/');
    if (!owner || !name) {
      return res.status(400).json({ error: 'Invalid repository name format in request body.' });
    }

    // Strictly verify admin permissions on GitHub
    log(`Verifying admin permissions for ${req.user.id} on ${repositoryFullName}`, 'routes');
    const isAdmin = await verifyUserIsRepoAdmin(req.user.githubAccessToken, owner, name);
    if (!isAdmin) {
      // If they were admin when registering but not now, forbid funding
      return res.status(403).json({ error: 'Forbidden: User no longer has admin rights on the GitHub repository.' });
    }

    // Log funding action with XDC
    log(`User ${req.user.id} funding registered repository ${repoIdString} with ${amountXdc} XDC`, 'routes');

    // Call blockchain service (passing repoId as number, amountXdc as string)
    const repoIdNumber = parseInt(repoIdString, 10);
    if (isNaN(repoIdNumber)) {
      return res.status(400).json({ error: 'Invalid repository ID format.' });
    }

    // Check daily funding limit for this repository
    const amountXdcNumber = parseFloat(amountXdc);
    const fundingCheck = checkRepositoryFundingLimit(repoIdNumber, amountXdcNumber);

    if (!fundingCheck.allowed) {
      const resetTimeStr = fundingCheck.limitResetTime ? fundingCheck.limitResetTime.toISOString() : 'unknown';
      log(
        `Funding rejected: Repository ${repoIdNumber} has reached daily limit of ${REPOSITORY_FUNDING_DAILY_LIMIT} XDC`,
        'routes'
      );
      return res.status(429).json({
        error: `Daily funding limit reached for this repository.`,
        details: {
          remainingLimit: fundingCheck.remainingLimit,
          dailyLimit: REPOSITORY_FUNDING_DAILY_LIMIT,
          limitResetTime: resetTimeStr,
        },
      });
    }

    // Use addXDCFundToRepository for XDC funding
    const txResponse = await blockchain.addXDCFundToRepository(repoIdNumber, amountXdc, req.user.id);

    // Record the successful funding transaction
    recordRepositoryFunding(repoIdNumber, amountXdcNumber);

    // Respond with transaction details using the correct 'res' object
    return res.json({
      // Added return here
      message: 'Funding transaction submitted successfully.',
      transactionHash: txResponse.hash,
    });
  } catch (error: any) {
    log(`Error funding repository ${req.params.repoId}: ${error}`, 'routes');
    // Provide more specific error messages if possible (e.g., from blockchain service)
    const errorMessage = error.message || 'Failed to fund repository';
    const status = errorMessage.includes('Insufficient') ? 400 : 500; // Basic error mapping
    res.status(status).json({ error: errorMessage });
  }
});

// Add endpoint to get rewards for multiple repositories (this needs to be updated for dual currency)
router.post('/repository-rewards', async (req: Request, res: Response) => {
  // Temporarily removed express.json() for diagnostics
  try {
    const { repoIds } = req.body; // repoIds is expected to be number[]

    if (!Array.isArray(repoIds) || !repoIds.every((id) => typeof id === 'number')) {
      return res.status(400).json({ error: 'Invalid or empty repoIds array, must be numbers' });
    }

    // blockchain.getRepositoryRewards now takes a single repoId and returns {rewardsXDC, rewardsROXN}
    // To get for multiple, we'd loop or the service method needs to be adapted.
    // For now, let's assume we adapt this endpoint to fetch for one repoId at a time, or adjust service.
    // Simpler: This endpoint might be better served by client calling /api/blockchain/pool-info/:repoId for each.
    // Or, if batching is essential, blockchain.getRepositoryRewards needs to be a batch-supporting function.
    // Let's assume for now this endpoint is for a single repoId for simplicity, or it's deprecated by pool-info.
    // For now, I will comment it out as its current logic is incompatible with the refactored blockchain service.
    // If needed, it can be re-implemented to loop or call a new batch service method.
    /*
    const rewardsData = [];
    for (const repoId of repoIds) {
      const data = await blockchain.getRepositoryRewards(repoId); // This now returns {rewardsXDC, rewardsROXN}
      rewardsData.push({
        repoId,
        rewardsXDC: data.rewardsXDC,
        rewardsROXN: data.rewardsROXN
      });
    }
    res.json({ rewards: rewardsData });
    */
    return res.status(501).json({ error: 'Endpoint /api/blockchain/repository-rewards needs reimplementation for dual currency.' });
  } catch (error) {
    console.error('Error fetching repository rewards:', error);
    const blockchainError: BlockchainError = {
      error: 'Failed to fetch repository rewards',
      details: error instanceof Error ? error.message : 'Unknown error',
    };
    res.status(500).json(blockchainError);
  }
});

// --- Unified Dual Currency Rewards System Routes ---

// Approve ROXN spending for the unified rewards contract
router.post('/approve-roxn', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { amount } = req.body; // Spender is always the main rewards contract now
    if (!req.user) return res.status(401).json({ error: 'User not authenticated' });
    if (!amount || typeof amount !== 'string') {
      return res.status(400).json({ error: 'Missing amount' });
    }

    const spenderAddress = config.repoRewardsContractAddress.replace('xdc', '0x'); // Unified contract address

    log(`User ${req.user.id} approving ${amount} ROXN for spender ${spenderAddress} (Unified System)`, 'routes-unified');
    const txResponse = await blockchain.approveTokensForContract(amount, req.user.id, spenderAddress);

    if (txResponse && txResponse.hash) {
      return res.json({ message: 'ROXN approval transaction submitted.', transactionHash: txResponse.hash });
    } else {
      log(
        `Error in /new-roxn/approve: Approval call completed but no transaction hash returned. Response: ${JSON.stringify(txResponse)}`,
        'routes-new-roxn-ERROR'
      );
      return res.status(500).json({
        error: 'Failed to approve ROXN tokens',
        details: 'Approval succeeded but no transaction hash was returned.',
      });
    }
  } catch (error: any) {
    log(`Error in /new-roxn/approve: ${error.message}`, 'routes-new-roxn-ERROR');
    if (!res.headersSent) {
      // Ensure headers haven't been sent by another error handler
      res.status(500).json({ error: 'Failed to approve ROXN tokens', details: error.message });
    }
  }
});

// Get ROXN allowance for the unified rewards contract
router.get('/roxn-allowance', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user || !req.user.xdcWalletAddress) {
      return res.status(401).json({ error: 'User not authenticated or wallet address missing' });
    }
    const ownerAddress = req.user.xdcWalletAddress;
    const spenderAddress = config.repoRewardsContractAddress; // The unified rewards contract

    log(`Fetching ROXN allowance for owner ${ownerAddress} and spender ${spenderAddress}`, 'routes-unified');
    const allowanceWei = await blockchain.getRoxnAllowance(ownerAddress, spenderAddress);

    res.json({ allowance: allowanceWei.toString() }); // Return allowance in wei as a string
  } catch (error: any) {
    log(`Error fetching ROXN allowance: ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to fetch ROXN allowance', details: error.message });
  }
});

// Fund a repository with ROXN (Unified System)
// Path changed from /api/blockchain/new-roxn/fund/:repoId
router.post('/fund-roxn/:repoId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { repoId } = req.params;
    const validationResult = fundRoxnRepoSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: 'Invalid ROXN funding data', details: validationResult.error.format() });
    }
    const { roxnAmount } = validationResult.data;

    if (!req.user) return res.status(401).json({ error: 'User not authenticated' });
    if (req.user.role !== 'poolmanager') {
      return res.status(403).json({ error: 'Only pool managers can fund with ROXN' });
    }

    log(`User ${req.user.id} attempting to fund repository ${repoId} with ${roxnAmount} ROXN (Unified System)`, 'routes-unified');
    const txResponse = await blockchain.addROXNFundToRepository(
      // Corrected method name
      parseInt(repoId),
      roxnAmount,
      req.user.id
    );
    res.json({ message: 'ROXN funding transaction submitted successfully.', transactionHash: txResponse?.hash });
  } catch (error: any) {
    log(`Error funding repository ${req.params.repoId} with ROXN (Unified System): ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to fund repository with ROXN', details: error.message });
  }
});

// Fund a repository with USDC (Unified System)
router.post('/fund-usdc/:repoId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { repoId } = req.params;
    const validationResult = fundUsdcRepoSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: 'Invalid USDC funding data', details: validationResult.error.format() });
    }
    const { usdcAmount } = validationResult.data;

    if (!req.user) return res.status(401).json({ error: 'User not authenticated' });
    if (req.user.role !== 'poolmanager') {
      return res.status(403).json({ error: 'Only pool managers can fund with USDC' });
    }

    log(`User ${req.user.id} attempting to fund repository ${repoId} with ${usdcAmount} USDC (Unified System)`, 'routes-unified');
    const txResponse = await blockchain.addUSDCFundToRepository(parseInt(repoId), usdcAmount, req.user.id);
    res.json({ message: 'USDC funding transaction submitted successfully.', transactionHash: txResponse?.hash });
  } catch (error: any) {
    log(`Error funding repository ${req.params.repoId} with USDC (Unified System): ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to fund repository with USDC', details: error.message });
  }
});

// Allocate a bounty (XDC, ROXN, or USDC) to an issue (Unified System)
// This replaces old /api/blockchain/repository/:repoId/issue/:issueId/reward
// and old /api/blockchain/new-roxn/allocate/:repoId/:issueId
router.post('/allocate-bounty/:repoId/:issueId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { repoId, issueId } = req.params;
    const validationResult = allocateUnifiedBountySchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: 'Invalid bounty allocation data', details: validationResult.error.format() });
    }
    // Ensure all necessary fields from allocateUnifiedBountySchema are used
    const { bountyAmount, currencyType, githubRepoFullName, issueTitle, issueUrl } = validationResult.data;

    if (!req.user) return res.status(401).json({ error: 'User not authenticated' });
    if (req.user.role !== 'poolmanager') {
      return res.status(403).json({ error: 'Only pool managers can allocate bounties' });
    }

    log(
      `User ${req.user.id} attempting to allocate ${bountyAmount} ${currencyType} to issue ${issueId} in repo ${repoId} (Unified System)`,
      'routes-unified'
    );

    const result = await blockchain.allocateIssueReward(
      // This method in blockchain.ts now takes currencyType
      parseInt(repoId),
      parseInt(issueId),
      bountyAmount,
      currencyType,
      req.user.id
    );

    if (githubRepoFullName && issueTitle && issueUrl) {
      log(`Attempting to send bounty notification for ${githubRepoFullName}#${issueId}`, 'zoho');
      import('../zoho.js')
        .then((zoho) => {
          zoho
            .sendBountyNotification(githubRepoFullName, parseInt(issueId), issueTitle, bountyAmount, issueUrl, currencyType === 'ROXN')
            .catch((err) => log(`Failed to send bounty notification: ${err.message}`, 'zoho'));
        })
        .catch((err) => log(`Error importing zoho module: ${err.message}`, 'zoho'));
    } else {
      log(`Skipping Zoho notification due to missing data in request body for issue ${issueId}`, 'zoho');
    }

    res.json({
      message: `${currencyType} bounty allocation transaction submitted.`,
      transactionHash: result?.transactionHash,
      blockNumber: result?.blockNumber,
    });
  } catch (error: any) {
    log(`Error allocating bounty for ${req.params.repoId}/#${req.params.issueId} (Unified System): ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to allocate bounty', details: error.message });
  }
});

// Distribute a bounty (Unified System)
// Path changed from /api/blockchain/new-roxn/distribute/:repoId/:issueId
// and replaces old /api/blockchain/repository/:repoId/issue/:issueId/distribute
router.post('/distribute-bounty/:repoId/:issueId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { repoId, issueId } = req.params;
    const { contributorAddress } = req.body;

    if (!contributorAddress || typeof contributorAddress !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid contributorAddress' });
    }
    if (!req.user) return res.status(401).json({ error: 'User not authenticated' });
    if (req.user.role !== 'poolmanager') {
      return res.status(403).json({ error: 'Only pool managers can distribute bounties' });
    }

    log(
      `User ${req.user.id} attempting to distribute bounty for issue ${issueId} in repo ${repoId} to ${contributorAddress} (Unified System)`,
      'routes-unified'
    );
    const receipt = await blockchain.distributeReward(
      // This method in blockchain.ts is now for unified contract
      parseInt(repoId),
      parseInt(issueId),
      contributorAddress,
      req.user.id
    );
    res.json({ message: 'Bounty distribution transaction submitted successfully.', transactionHash: receipt?.hash });
  } catch (error: any) {
    log(`Error distributing bounty for ${req.params.repoId}/#${req.params.issueId} (Unified System): ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to distribute bounty', details: error.message });
  }
});

// Get unified pool info for a repository (replaces GET /api/blockchain/new-roxn/pool/:repoId)
// and also effectively replaces GET /api/blockchain/repository/:repoId for pool info
// Made PUBLIC: Removed requireAuth
router.get('/pool-info/:repoId', async (req: Request, res: Response) => {
  try {
    const { repoId } = req.params;
    log(`Fetching unified pool info for repo ${repoId} (public access)`, 'routes-unified');
    const poolInfo = await blockchain.getRepository(parseInt(repoId)); // getRepository now returns unified info
    res.json(poolInfo);
  } catch (error: any) {
    log(`Error fetching unified pool info for repo ${req.params.repoId}: ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to fetch pool info', details: error.message });
  }
});

// Diagnostic endpoint to check repository initialization status
router.get(
  '/repository/:repoId/status',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;
      log(`Checking initialization status for repository ${repoId}`, 'routes-diagnostic');

      const status = await blockchain.checkRepositoryInitialization(parseInt(repoId));

      res.json({
        repoId: parseInt(repoId),
        ...status,
        recommendation: status.isInitialized
          ? 'Repository is ready for operations'
          : 'Repository needs initialization. Either add a pool manager or fund the repository to auto-initialize.',
      });
    } catch (error: any) {
      log(`Error checking repository status: ${error.message}`, 'routes-diagnostic-ERROR');
      res.status(500).json({ error: 'Failed to check repository status', details: error.message });
    }
  }
);

// Initialize repository endpoint (for pool managers)
router.post('/repository/:repoId/initialize', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  try {
    const { repoId } = req.params;

    if (!req.user || req.user.role !== 'poolmanager') {
      return res.status(403).json({ error: 'Only pool managers can initialize repositories' });
    }

    const userAddress = req.user.xdcWalletAddress;
    if (!userAddress) {
      return res.status(400).json({ error: 'User wallet address not found' });
    }

    log(`User ${req.user.id} attempting to initialize repository ${repoId}`, 'routes-init');

    const receipt = await blockchain.initializeRepository(
      parseInt(repoId),
      userAddress,
      req.user.username,
      parseInt(req.user.githubId),
      req.user.id
    );

    if (receipt) {
      res.json({
        message: 'Repository initialized successfully',
        transactionHash: receipt.hash,
        poolManager: userAddress,
      });
    } else {
      res.status(500).json({ error: 'Failed to initialize repository' });
    }
  } catch (error: any) {
    log(`Error initializing repository ${req.params.repoId}: ${error.message}`, 'routes-init-ERROR');
    res.status(500).json({ error: 'Failed to initialize repository', details: error.message });
  }
});

// Get unified bounty details for a specific issue (replaces GET /api/blockchain/new-roxn/issue/:repoId/:issueId)
router.get('/issue-bounty/:repoId/:issueId', async (req: Request, res: Response) => {
  try {
    const { repoId, issueId } = req.params;
    log(`Fetching unified bounty details for issue ${issueId} in repo ${repoId} (public access)`, 'routes-unified');
    const issueDetailsArray = await blockchain.getIssueRewards(parseInt(repoId), [parseInt(issueId)]); // getIssueRewards now returns IssueBountyDetails[]
    if (issueDetailsArray.length > 0) {
      res.json(issueDetailsArray[0]);
    } else {
      // It's possible an issue exists but has no bounty, or the issue ID is wrong.
      // The contract's getIssueRewards returns an array of Issue structs. If an issueId is not found in mapping, it's a zeroed struct.
      // The blockchain service maps this to IssueBountyDetails. An empty rewardAmountFormatted might mean no bounty.
      // Consider if 404 is right or if an object with "0.0" reward is better.
      // For now, if the array is empty (e.g. if getIssueRewards filters out zeroed structs), 404 is okay.
      // If it returns a zeroed struct mapped to IssueBountyDetails, then a 200 with that data is fine.
      // Current blockchain.getIssueRewards returns IssueBountyDetails[], so an empty array means no matching issues found by contract.
      res.status(404).json({ error: 'Bounty details not found for this issue or issue ID is invalid.' });
    }
  } catch (error: any) {
    log(`Error fetching unified bounty details for ${req.params.repoId}/#${req.params.issueId}: ${error.message}`, 'routes-unified-ERROR');
    res.status(500).json({ error: 'Failed to fetch bounty details', details: error.message });
  }
});

export default router;


/**
 * COMMUNITY BOUNTIES ROUTES
 *
 * WHY THIS FILE:
 * - Handles all community bounty HTTP endpoints
 * - Bounty creation, payment, claiming, and exploration
 * - Permissionless bounties (works on any public GitHub repo)
 *
 * ENDPOINTS:
 * - POST /api/community-bounties - Create bounty (CLIENT only)
 * - POST /api/community-bounties/:id/pay - Pay for bounty (CLIENT only - creator)
 * - POST /api/community-bounties/:id/claim - Claim bounty (DEVELOPER only)
 * - GET /api/community-bounties - List/filter bounties (public)
 * - GET /api/community-bounties/:id - Get single bounty (public)
 * - GET /api/community-bounties/leaderboard - Top contributors (public)
 *
 * PROFILE TYPE RESTRICTIONS:
 * - CLIENT (poolmanager): Can create and fund bounties
 * - DEVELOPER (contributor): Can claim/submit to bounties
 *
 * SECURITY:
 * - Rate limiting on all endpoints
 * - Authentication required for create/pay/claim
 * - Profile type (role) enforcement on restricted endpoints
 * - CSRF protection on state-changing operations
 * - Input validation with Zod schemas
 */

import { Router, type Request, Response } from 'express';
import { requireAuth, csrfProtection, requireClient, requireDeveloper } from '../auth';
import { storage } from '../storage';
import { blockchain } from '../blockchain';
import { resolveInstallationIdForRepo } from '../github';
import { log, sanitizeUserInput } from '../utils';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { createCommunityBountySchema } from '../../shared/schema';

// Custom error class for business logic errors
class BusinessError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BusinessError';
  }
}

// Rate limiters
const createBountyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Max 10 bounties per hour per user
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many bounty creation requests, please try again later.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const payBountyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Max 20 payment attempts per 15 minutes
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many payment requests, please try again later.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const claimBountyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Max 30 claim attempts per 15 minutes
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many claim requests, please try again later.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

/**
 * POST /api/community-bounties
 * Create a new community bounty (database record only, no blockchain yet)
 *
 * WHY TWO-STEP PROCESS:
 * - Step 1: Create DB record (this endpoint)
 * - Step 2: Pay bounty to escrow (separate endpoint)
 * - Allows user to review bounty details before committing funds
 * - Better error handling (can retry payment without recreating bounty)
 *
 * REQUEST BODY:
 * {
 *   githubRepoOwner: string,
 *   githubRepoName: string,
 *   githubIssueNumber: number,
 *   githubIssueId: string,
 *   githubIssueUrl: string,
 *   title: string,
 *   description?: string,
 *   amount: string,
 *   currency: 'XDC' | 'ROXN' | 'USDC',
 *   expiresAt?: Date
 * }
 *
 * RESPONSE:
 * {
 *   bounty: {
 *     id: number,
 *     status: 'pending_payment',
 *     ... all bounty fields
 *   }
 * }
 */
router.post(
  '/api/community-bounties',
  requireAuth,
  requireClient, // CLIENT only: Only Clients can create bounties
  csrfProtection,
  createBountyRateLimiter,
  async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      log(`Creating community bounty for user ${req.user.id} (role: ${req.user.role})`, 'community-bounties');

      // Validate input
      const validatedData = createCommunityBountySchema.parse(req.body);

      // WHY CHECK USER: Ensure user has wallet address
      const user = await storage.getUserById(req.user.id);
      if (!user || !user.xdcWalletAddress) {
        throw new BusinessError('User wallet not found. Please complete wallet setup.', 400);
      }

      // WHY VALIDATE AMOUNT: Ensure positive amount
      const amount = parseFloat(validatedData.amount);
      if (amount <= 0) {
        throw new BusinessError('Bounty amount must be greater than 0', 400);
      }

      // WHY VALIDATE CURRENCY: Only allow supported currencies
      if (!['XDC', 'ROXN', 'USDC'].includes(validatedData.currency)) {
        throw new BusinessError('Currency must be XDC, ROXN, or USDC', 400);
      }

      // CRITICAL-5 FIX: Sanitize user-provided title and description
      const sanitizedTitle = sanitizeUserInput(validatedData.title, {
        maxLength: 500,
        allowNewlines: false,
        context: 'all'
      });

      const sanitizedDescription = validatedData.description
        ? sanitizeUserInput(validatedData.description, {
            maxLength: 5000,
            allowNewlines: true,
            context: 'all'
          })
        : undefined;

      // Create bounty in database
      // WHY STATUS pending_payment: User hasn't paid yet (set automatically by createCommunityBounty)
      const bounty = await storage.createCommunityBounty({
        githubRepoOwner: validatedData.githubRepoOwner,
        githubRepoName: validatedData.githubRepoName,
        githubIssueNumber: validatedData.githubIssueNumber,
        githubIssueId: validatedData.githubIssueId,
        githubIssueUrl: validatedData.githubIssueUrl,
        creatorUserId: req.user.id,
        createdByGithubUsername: user.githubUsername || '',
        title: sanitizedTitle,
        description: sanitizedDescription,
        amount: validatedData.amount,
        currency: validatedData.currency,
        expiresAt: validatedData.expiresAt
      });

      log(`Community bounty ${bounty.id} created in DB. Status: pending_payment`, 'community-bounties');

      res.status(201).json({
        bounty,
        message: 'Bounty created successfully. Please proceed to payment.'
      });

    } catch (error: any) {
      log(`Error creating community bounty: ${error.message}`, 'community-bounties-ERROR');

      if (error instanceof ZodError) {
        return res.status(400).json({
          error: 'Invalid input',
          details: error.errors
        });
      }

      if (error instanceof BusinessError) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to create bounty' });
    }
  }
);

/**
 * POST /api/community-bounties/:id/pay
 * Pay for a bounty (creates blockchain escrow)
 *
 * WHY SEPARATE ENDPOINT:
 * - User creates bounty first (DB only)
 * - Then pays via this endpoint (blockchain)
 * - Allows retry on blockchain failures
 * - Better UX (show payment modal after creation)
 *
 * REQUEST BODY:
 * {
 *   // No body needed - amount/currency from bounty record
 * }
 *
 * RESPONSE:
 * {
 *   txHash: string,
 *   bountyId: number (blockchain),
 *   status: 'funded'
 * }
 */
router.post(
  '/api/community-bounties/:id/pay',
  requireAuth,
  requireClient, // CLIENT only: Only Clients can pay for bounties
  csrfProtection,
  payBountyRateLimiter,
  async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const bountyId = parseInt(req.params.id);
      if (isNaN(bountyId)) {
        return res.status(400).json({ error: 'Invalid bounty ID' });
      }

      log(`Processing payment for community bounty ${bountyId} by user ${req.user.id} (role: ${req.user.role})`, 'community-bounties');

      // Fetch bounty
      const bounty = await storage.getCommunityBounty(bountyId);
      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found' });
      }

      // WHY CHECK CREATOR: Only creator can pay
      if (bounty.creatorUserId !== req.user.id) {
        return res.status(403).json({ error: 'Only bounty creator can pay' });
      }

      // WHY CHECK STATUS: Only allow payment for pending bounties
      if (bounty.status !== 'pending_payment') {
        return res.status(400).json({
          error: `Bounty is not in pending_payment status (current: ${bounty.status})`
        });
      }

      // Call blockchain service based on currency
      // IMPORTANT: We now pass the TOTAL amount client must pay (base + client fee)
      // The blockchain service will handle the fee breakdown internally
      let result: { tx: any; bountyId: number };
      const expiryTimestamp = bounty.expiresAt ? Math.floor(new Date(bounty.expiresAt).getTime() / 1000) : 0;

      // Use totalPaidByClient (base amount + 2.5% client fee) for escrow
      const totalAmountToPay = bounty.totalPaidByClient || bounty.amount;

      if (bounty.currency === 'XDC') {
        result = await blockchain.createCommunityBountyWithXDC(
          req.user.id,
          totalAmountToPay,
          expiryTimestamp,
          bounty.baseBountyAmount || bounty.amount, // Pass base amount separately
          bounty.clientFeeAmount || '0',
          bounty.contributorFeeAmount || '0'
        );
      } else if (bounty.currency === 'ROXN') {
        result = await blockchain.createCommunityBountyWithROXN(
          req.user.id,
          totalAmountToPay,
          expiryTimestamp,
          bounty.baseBountyAmount || bounty.amount,
          bounty.clientFeeAmount || '0',
          bounty.contributorFeeAmount || '0'
        );
      } else if (bounty.currency === 'USDC') {
        result = await blockchain.createCommunityBountyWithUSDC(
          req.user.id,
          totalAmountToPay,
          expiryTimestamp,
          bounty.baseBountyAmount || bounty.amount,
          bounty.clientFeeAmount || '0',
          bounty.contributorFeeAmount || '0'
        );
      } else {
        throw new BusinessError('Unsupported currency', 400);
      }

      // FUND-03: best-effort capture of the GitHub App installation id at funding time.
      // This is the exact step the 12 stuck bounties never reached. Wrapped in try/catch and
      // NEVER allowed to abort a funded payment — on lookup failure the installation id is
      // backfilled later at claim time or by sweepPendingInstallationBounties. Use the in-scope
      // bounty object fields (bounty.githubRepoOwner / bounty.githubRepoName), NOT bare owner/repo.
      let resolvedInstallationId: string | null = null;
      try {
        resolvedInstallationId = await resolveInstallationIdForRepo(bounty.githubRepoOwner, bounty.githubRepoName);
      } catch (installLookupErr: any) {
        log(`Installation-id lookup failed at funding for bounty ${bountyId} (non-fatal): ${installLookupErr.message}`, 'community-bounties');
        resolvedInstallationId = null;
      }

      // Update bounty status in DB with comprehensive transaction data
      const updatedBounty = await storage.updateCommunityBounty(bountyId, {
        status: 'funded',
        paymentStatus: 'completed',
        paymentMethod: 'crypto',
        escrowTxHash: result.tx.hash,
        escrowDepositedAt: new Date(),
        blockchainBountyId: result.bountyId,
        // FUND-03: capture-forward (null is a valid no-op; backfilled later if unresolved)
        ...(resolvedInstallationId ? { githubInstallationId: resolvedInstallationId } : {}),
        // CRITICAL-4 FIX: Store blockchain confirmation data
        escrowBlockNumber: (result.receipt as any)?.blockNumber || null,
      });

      log(`Community bounty ${bountyId} paid successfully. TX: ${result.tx.hash}, Blockchain ID: ${result.bountyId}`, 'community-bounties');

      res.status(200).json({
        txHash: result.tx.hash,
        blockchainBountyId: result.bountyId,
        status: 'funded',
        bounty: updatedBounty,
        message: 'Bounty funded successfully'
      });

    } catch (error: any) {
      log(`Error paying community bounty: ${error.message}`, 'community-bounties-ERROR');

      if (error instanceof BusinessError) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      res.status(500).json({
        error: 'Failed to process payment',
        details: error.message
      });
    }
  }
);

/**
 * POST /api/community-bounties/:id/claim
 * Claim a bounty by submitting PR number
 *
 * WHY THIS ENDPOINT:
 * - Contributor submits PR that closes the issue
 * - Backend marks bounty as 'claimed'
 * - Relayer service will verify PR merge and complete payout
 *
 * REQUEST BODY:
 * {
 *   prNumber: number,
 *   prUrl: string
 * }
 *
 * RESPONSE:
 * {
 *   status: 'claimed',
 *   message: 'Bounty claimed. Payout will be processed after PR merge.'
 * }
 */
router.post(
  '/api/community-bounties/:id/claim',
  requireAuth,
  requireDeveloper, // DEVELOPER only: Only Developers can claim bounties
  csrfProtection,
  claimBountyRateLimiter,
  async (req: Request, res: Response) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const bountyId = parseInt(req.params.id);
      if (isNaN(bountyId)) {
        return res.status(400).json({ error: 'Invalid bounty ID' });
      }

      const { prNumber, prUrl } = req.body;

      if (!prNumber || typeof prNumber !== 'number') {
        return res.status(400).json({ error: 'PR number is required' });
      }

      log(`Processing claim for community bounty ${bountyId} by user ${req.user.id} (role: ${req.user.role}), PR #${prNumber}`, 'community-bounties');

      // Fetch bounty
      const bounty = await storage.getCommunityBounty(bountyId);
      if (!bounty) {
        return res.status(404).json({ error: 'Bounty not found' });
      }

      // WHY CHECK STATUS: Only allow claiming funded bounties
      if (bounty.status !== 'funded') {
        return res.status(400).json({
          error: `Bounty is not available for claiming (status: ${bounty.status})`
        });
      }

      // WHY GET USER: Need GitHub username and wallet for payout
      const user = await storage.getUserById(req.user.id);
      if (!user || !user.githubUsername) {
        return res.status(400).json({ error: 'GitHub account not linked' });
      }

      if (!user.xdcWalletAddress) {
        return res.status(400).json({ error: 'Wallet not set up. Please create a wallet first.' });
      }

      // CRITICAL-3 FIX: Use atomic claim method to prevent race condition
      let updatedBounty;
      try {
        updatedBounty = await storage.claimCommunityBountyAtomic(
          bountyId,
          req.user.id,
          user.githubUsername,
          prNumber,
          prUrl
        );
      } catch (claimError: any) {
        log(`Atomic claim failed for bounty ${bountyId}: ${claimError.message}`, 'community-bounties-ERROR');
        return res.status(400).json({
          error: claimError.message || 'Bounty is no longer available for claiming'
        });
      }

      log(`Community bounty ${bountyId} claimed by ${user.githubUsername} with PR #${prNumber}`, 'community-bounties');

      res.status(200).json({
        status: 'claimed',
        bounty: updatedBounty,
        message: 'Bounty claimed successfully. Payout will be processed automatically after your PR is merged.'
      });

    } catch (error: any) {
      log(`Error claiming community bounty: ${error.message}`, 'community-bounties-ERROR');

      if (error instanceof BusinessError) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      res.status(500).json({
        error: 'Failed to claim bounty',
        details: error.message
      });
    }
  }
);

/**
 * GET /api/community-bounties
 * List and filter community bounties
 *
 * QUERY PARAMETERS:
 * - status: Filter by status (funded, claimed, completed, etc.)
 * - currency: Filter by currency (XDC, ROXN, USDC)
 * - repo: Filter by repository (owner/name format)
 * - creator: Filter by creator username
 * - limit: Results per page (default: 20, max: 100)
 * - offset: Pagination offset (default: 0)
 *
 * RESPONSE:
 * {
 *   bounties: [...],
 *   total: number,
 *   limit: number,
 *   offset: number
 * }
 */
router.get('/api/community-bounties', async (req: Request, res: Response) => {
  try {
    const {
      status,
      currency,
      repo,
      creator,
      limit = '20',
      offset = '0'
    } = req.query;

    const limitNum = Math.min(parseInt(limit as string) || 20, 100);
    const offsetNum = parseInt(offset as string) || 0;

    log(`Fetching community bounties with filters: status=${status}, currency=${currency}, repo=${repo}`, 'community-bounties');

    // Build filters
    const filters: any = {};
    if (status) filters.status = status;
    if (currency) filters.currency = currency;
    if (creator) filters.createdByGithubUsername = creator;

    if (repo && typeof repo === 'string') {
      const [owner, name] = repo.split('/');
      if (owner && name) {
        filters.githubRepoOwner = owner;
        filters.githubRepoName = name;
      }
    }

    // Fetch bounties (using storage service)
    // For now, get active bounties and filter in memory
    // TODO: Add proper filtering to storage.getActiveCommunityBounties()
    const allBounties = await storage.getActiveCommunityBounties();

    let filteredBounties = allBounties;

    if (filters.status) {
      filteredBounties = filteredBounties.filter(b => b.status === filters.status);
    }
    if (filters.currency) {
      filteredBounties = filteredBounties.filter(b => b.currency === filters.currency);
    }
    if (filters.githubRepoOwner && filters.githubRepoName) {
      filteredBounties = filteredBounties.filter(
        b => b.githubRepoOwner === filters.githubRepoOwner && b.githubRepoName === filters.githubRepoName
      );
    }
    if (filters.createdByGithubUsername) {
      filteredBounties = filteredBounties.filter(b => b.createdByGithubUsername === filters.createdByGithubUsername);
    }

    const total = filteredBounties.length;
    const paginatedBounties = filteredBounties.slice(offsetNum, offsetNum + limitNum);

    res.status(200).json({
      bounties: paginatedBounties,
      total,
      limit: limitNum,
      offset: offsetNum
    });

  } catch (error: any) {
    log(`Error fetching community bounties: ${error.message}`, 'community-bounties-ERROR');
    res.status(500).json({ error: 'Failed to fetch bounties' });
  }
});

/**
 * GET /api/community-bounties/:id
 * Get single bounty by ID
 *
 * RESPONSE:
 * {
 *   bounty: { ... all fields }
 * }
 */
router.get('/api/community-bounties/:id', async (req: Request, res: Response) => {
  try {
    const bountyId = parseInt(req.params.id);
    if (isNaN(bountyId)) {
      return res.status(400).json({ error: 'Invalid bounty ID' });
    }

    const bounty = await storage.getCommunityBounty(bountyId);
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    res.status(200).json({ bounty });

  } catch (error: any) {
    log(`Error fetching community bounty: ${error.message}`, 'community-bounties-ERROR');
    res.status(500).json({ error: 'Failed to fetch bounty' });
  }
});

/**
 * GET /api/community-bounties/leaderboard
 * Get top contributors by bounties completed
 *
 * QUERY PARAMETERS:
 * - limit: Number of contributors (default: 10, max: 50)
 *
 * RESPONSE:
 * {
 *   leaderboard: [
 *     {
 *       githubUsername: string,
 *       totalEarned: string,
 *       bounties Completed: number,
 *       currencies: { XDC: string, ROXN: string, USDC: string }
 *     }
 *   ]
 * }
 */
router.get('/api/community-bounties/leaderboard', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    log(`Fetching community bounties leaderboard (limit: ${limit})`, 'community-bounties');

    // Get all completed bounties
    const completedBounties = await storage.getActiveCommunityBounties();
    const completed = completedBounties.filter(b => b.status === 'completed');

    // Aggregate by contributor
    const contributorStats = new Map<string, {
      githubUsername: string;
      totalEarnedXDC: number;
      totalEarnedROXN: number;
      totalEarnedUSDC: number;
      bountiesCompleted: number;
    }>();

    for (const bounty of completed) {
      if (!bounty.claimedByGithubUsername) continue;

      const username = bounty.claimedByGithubUsername;
      const stats = contributorStats.get(username) || {
        githubUsername: username,
        totalEarnedXDC: 0,
        totalEarnedROXN: 0,
        totalEarnedUSDC: 0,
        bountiesCompleted: 0
      };

      stats.bountiesCompleted++;

      const amount = parseFloat(bounty.amount);
      if (bounty.currency === 'XDC') {
        stats.totalEarnedXDC += amount;
      } else if (bounty.currency === 'ROXN') {
        stats.totalEarnedROXN += amount;
      } else if (bounty.currency === 'USDC') {
        stats.totalEarnedUSDC += amount;
      }

      contributorStats.set(username, stats);
    }

    // Convert to array and sort by bounties completed
    const leaderboard = Array.from(contributorStats.values())
      .sort((a, b) => b.bountiesCompleted - a.bountiesCompleted)
      .slice(0, limit)
      .map(stats => ({
        githubUsername: stats.githubUsername,
        bountiesCompleted: stats.bountiesCompleted,
        currencies: {
          XDC: stats.totalEarnedXDC.toFixed(2),
          ROXN: stats.totalEarnedROXN.toFixed(2),
          USDC: stats.totalEarnedUSDC.toFixed(2)
        }
      }));

    res.status(200).json({ leaderboard });

  } catch (error: any) {
    log(`Error fetching leaderboard: ${error.message}`, 'community-bounties-ERROR');
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

export default router;

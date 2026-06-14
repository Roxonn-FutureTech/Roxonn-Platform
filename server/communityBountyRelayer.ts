/**
 * COMMUNITY BOUNTY RELAYER SERVICE
 *
 * WHY THIS SERVICE:
 * - Processes claimed community bounties by verifying PR merges
 * - Calls smart contract completeBounty() after verification
 * - Acts as trusted oracle for GitHub merge events
 * - Prevents fraudulent claims without actual PR merge
 *
 * HOW IT WORKS:
 * 1. Background job runs every 30 seconds
 * 2. Fetches all bounties in 'claimed' status from DB
 * 3. For each bounty:
 *    a. Verify PR was merged and closes the issue (via GitHub API)
 *    b. If verified, call blockchain.completeCommunityBounty()
 *    c. Update DB status to 'completed' with transaction hash
 *    d. Handle errors (retry logic, failed verification, etc.)
 *
 * WHY RELAYER PATTERN:
 * - Smart contracts cannot verify GitHub events directly
 * - Relayer acts as bridge between off-chain (GitHub) and on-chain (XDC)
 * - Only relayer wallet can call completeBounty() (security)
 * - Provides audit trail for all bounty completions
 *
 * SECURITY CONSIDERATIONS:
 * - Relayer private key stored in AWS Secrets Manager
 * - All verifications logged for audit
 * - Failed verifications do not call smart contract
 * - Idempotent processing (can retry safely)
 * - Rate limiting to prevent API abuse
 */

import { storage, recordPayoutWithRetry } from './storage';
import { buildCommunityPayoutRow } from './utils/payoutMapper';
import { blockchain } from './blockchain';
import { verifyPRMergedAndClosesIssue } from './github';
import { log } from './utils';

/**
 * Process a single claimed bounty
 *
 * WHY SEPARATE FUNCTION:
 * - Easier to test individual bounty processing
 * - Better error isolation (one bounty failure doesn't stop others)
 * - Cleaner code organization
 *
 * FLOW:
 * 1. Verify bounty is in 'claimed' status
 * 2. Verify PR merge via GitHub API
 * 3. Get contributor wallet address
 * 4. Call smart contract completeBounty()
 * 5. Update DB with completion details
 *
 * ERROR HANDLING:
 * - If verification fails: Log error, keep status as 'claimed' (manual review)
 * - If blockchain call fails: Log error, keep status as 'claimed' (will retry)
 * - If DB update fails: Log error (bounty completed on-chain but DB out of sync)
 *
 * @param bountyId - Community bounty ID from database
 */
async function processClaimedBounty(bountyId: number): Promise<void> {
  try {
    log(`Processing claimed bounty ${bountyId}`, 'relayer');

    // STEP 1: Fetch bounty details from DB
    // WHY: Need PR number, issue number, repo info for verification
    const bounty = await storage.getCommunityBounty(bountyId);

    if (!bounty) {
      log(`Bounty ${bountyId} not found in DB`, 'relayer-ERROR');
      return;
    }

    // WHY VERIFY STATUS: Prevent processing already-completed bounties
    if (bounty.status !== 'claimed') {
      log(`Bounty ${bountyId} is not in claimed status (current: ${bounty.status}). Skipping.`, 'relayer');
      return;
    }

    // WHY CHECK REQUIRED FIELDS: Ensure we have all data needed for verification
    if (!bounty.claimedPrNumber || !bounty.claimedByGithubUsername || !bounty.githubRepoOwner || !bounty.githubRepoName) {
      log(`Bounty ${bounty.id} missing required fields for verification. PR#=${bounty.claimedPrNumber}, claimedBy=${bounty.claimedByGithubUsername}`, 'relayer-ERROR');
      // Update status to failed so admin can review
      await storage.updateCommunityBounty(bountyId, {
        status: 'failed_verification'
      });
      return;
    }

    // STEP 2: Verify PR merge via GitHub API
    // WHY: Ensure PR was actually merged before paying out bounty
    log(`Verifying PR #${bounty.claimedPrNumber} merged and closes issue #${bounty.githubIssueNumber} in ${bounty.githubRepoOwner}/${bounty.githubRepoName}`, 'relayer');

    // WHY INSTALLATION ID: Community bounties may be on unregistered repos
    // We need to get installation ID for the repo to use GitHub App auth
    // For now, we'll assume the repo has our GitHub App installed
    // TODO: Add installation ID lookup or store it during bounty creation
    const installationId = bounty.githubInstallationId;
    if (!installationId) {
      log(`Bounty ${bountyId} missing GitHub installation ID. Cannot verify PR.`, 'relayer-ERROR');
      await storage.updateCommunityBounty(bountyId, {
        status: 'failed_verification'
      });
      return;
    }

    const verification = await verifyPRMergedAndClosesIssue(
      bounty.githubRepoOwner,
      bounty.githubRepoName,
      bounty.claimedPrNumber,
      bounty.githubIssueNumber,
      installationId
    );

    // WHY LOG VERIFICATION RESULT: Audit trail for all verification attempts
    log(`Verification result for bounty ${bountyId}: ${JSON.stringify(verification)}`, 'relayer');

    if (!verification.verified) {
      log(`Bounty ${bountyId} verification failed: ${verification.error}`, 'relayer-ERROR');
      await storage.updateCommunityBounty(bountyId, {
        status: 'failed_verification'
      });
      return;
    }

    // STEP 3: Get contributor wallet address
    // WHY: Smart contract needs contributor address to send funds
    const contributor = await storage.getUserByGithubUsername(bounty.claimedByGithubUsername);
    if (!contributor || !contributor.xdcWalletAddress) {
      log(`Contributor ${bounty.claimedByGithubUsername} not found or has no wallet address`, 'relayer-ERROR');
      await storage.updateCommunityBounty(bountyId, {
        status: 'failed_verification'
      });
      return;
    }

    // STEP 4: Call smart contract completeBounty()
    // WHY: Transfer funds to contributor on-chain
    log(`Calling blockchain.completeCommunityBounty(${bounty.blockchainBountyId}, ${contributor.xdcWalletAddress})`, 'relayer');

    const result = await blockchain.completeCommunityBounty(
      bounty.blockchainBountyId!,
      contributor.xdcWalletAddress
    );

    log(`Bounty ${bountyId} completed on-chain. TX: ${result.txHash}, Block: ${result.blockNumber}`, 'relayer');

    // STEP 5: Record payout for idempotency tracking (FUND-04)
    // WHY: Prevents duplicate payouts in community bounties system
    // NOTE: This is separate from pool bounty payouts (which are tracked in github.ts)
    // D-12: pay-then-record — blockchain tx completed above; recordPayoutWithRetry never re-throws
    await recordPayoutWithRetry(buildCommunityPayoutRow({
      repositoryGithubId: `community-${bounty.githubRepoOwner}-${bounty.githubRepoName}`,
      issueNumber: bounty.githubIssueNumber,
      recipientGithubUsername: bounty.claimedByGithubUsername!,
      recipientUserId: bounty.claimedByUserId ?? null,
      recipientWalletAddress: contributor.xdcWalletAddress,
      baseBountyAmount: parseFloat(bounty.baseBountyAmount || bounty.amount),
      currency: bounty.currency,
      txHash: result.txHash,
      blockNumber: result.blockNumber ?? null,
      communityBountyId: bounty.id,
    }));

    // STEP 6: Update DB with completion details
    // WHY: Keep DB in sync with blockchain state
    await storage.updateCommunityBounty(bountyId, {
      status: 'completed',
      payoutTxHash: result.txHash,
      payoutExecutedAt: new Date(),
      payoutRecipientAddress: contributor.xdcWalletAddress
    });

    log(`✅ Bounty ${bountyId} processing complete`, 'relayer');

  } catch (error: any) {
    // WHY LOG ERROR BUT DON'T THROW: Allow other bounties to be processed
    log(`Error processing bounty ${bountyId}: ${error.message}`, 'relayer-ERROR');
    console.error(`Full error for bounty ${bountyId}:`, error);

    // WHY KEEP STATUS AS CLAIMED: Will be retried next cycle
    // Don't update DB on error - let it retry
  }
}

/**
 * Main relayer background job
 *
 * WHY THIS FUNCTION:
 * - Runs periodically to process claimed bounties
 * - Ensures timely payouts after PR merge
 * - Provides continuous monitoring of bounty claims
 *
 * HOW IT WORKS:
 * 1. Fetch all bounties in 'claimed' status
 * 2. Process each bounty sequentially (to avoid race conditions)
 * 3. Log summary of processing results
 * 4. Handle errors gracefully (don't crash the job)
 *
 * WHY SEQUENTIAL PROCESSING:
 * - Prevents concurrent blockchain calls with same relayer wallet
 * - Avoids nonce conflicts in blockchain transactions
 * - Easier to debug (one at a time)
 * - Rate limiting on GitHub API calls
 *
 * WHY NOT PARALLEL:
 * - Risk of nonce conflicts (multiple txs from same wallet)
 * - GitHub API rate limits
 * - Claimed bounties are rare enough that sequential is fine
 */
export async function processClaimedBounties(): Promise<void> {
  try {
    log('Starting community bounty relayer cycle', 'relayer');

    // STEP 1: Fetch all claimed bounties
    // WHY: Get bounties waiting for payout
    const claimedBounties = await storage.getClaimedCommunityBounties();

    if (claimedBounties.length === 0) {
      log('No claimed bounties to process', 'relayer');
      return;
    }

    log(`Found ${claimedBounties.length} claimed bounties to process`, 'relayer');

    // STEP 2: Process each bounty sequentially
    // WHY SEQUENTIAL: Prevent nonce conflicts and rate limit issues
    for (const bounty of claimedBounties) {
      await processClaimedBounty(bounty.id);

      // WHY DELAY: Rate limiting for GitHub API and blockchain
      // Prevents overwhelming GitHub API or blockchain RPC
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between bounties
    }

    log(`Community bounty relayer cycle complete. Processed ${claimedBounties.length} bounties.`, 'relayer');

  } catch (error: any) {
    log(`Error in community bounty relayer cycle: ${error.message}`, 'relayer-ERROR');
    console.error('Full relayer error:', error);
    // Don't throw - let the interval continue
  }
}

/**
 * Start the community bounty relayer background job
 *
 * WHY THIS FUNCTION:
 * - Initializes the background job interval
 * - Provides single entry point for starting the service
 * - Returns interval ID for cleanup/testing
 *
 * CONFIGURATION:
 * - Runs every 30 seconds (configurable)
 * - Processes all claimed bounties each cycle
 * - Logs all activity for monitoring
 *
 * WHY 30 SECONDS:
 * - Fast enough for timely payouts (most PRs take minutes to merge)
 * - Slow enough to avoid rate limits
 * - Good balance between responsiveness and resource usage
 *
 * @param intervalMs - Interval in milliseconds (default: 300000 = 5 minutes)
 * @returns NodeJS.Timeout - Interval ID for cleanup
 */
export function startCommunityBountyRelayer(intervalMs: number = 300000): NodeJS.Timeout {
  log(`Starting community bounty relayer service (interval: ${intervalMs}ms, backup mode)`, 'relayer');

  // WHY RUN IMMEDIATELY: Process any existing claimed bounties without waiting
  processClaimedBounties().catch(error => {
    log(`Error in initial community bounty relayer run: ${error.message}`, 'relayer-ERROR');
  });

  // WHY SET INTERVAL: Continuous background processing
  const interval = setInterval(async () => {
    await processClaimedBounties();
  }, intervalMs);

  log('Community bounty relayer service started successfully', 'relayer');

  return interval;
}

/**
 * Stop the community bounty relayer background job
 *
 * WHY THIS FUNCTION:
 * - Allows graceful shutdown
 * - Useful for testing
 * - Cleanup on server shutdown
 *
 * @param interval - The interval ID returned by startCommunityBountyRelayer()
 */
export function stopCommunityBountyRelayer(interval: NodeJS.Timeout): void {
  log('Stopping community bounty relayer service', 'relayer');
  clearInterval(interval);
  log('Community bounty relayer service stopped', 'relayer');
}

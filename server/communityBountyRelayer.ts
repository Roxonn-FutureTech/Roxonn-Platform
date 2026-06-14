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
import { verifyPRMergedAndClosesIssue, resolveInstallationIdForRepo } from './github';
import { log } from './utils';

/**
 * FUND-03: max resolution attempts before a pending_installation bounty is TTL-demoted to 'expired'.
 * Each sweep cycle counts as one attempt (tracked in metadata.installationResolveAttempts).
 */
const MAX_INSTALLATION_RESOLVE_ATTEMPTS = 10;

/**
 * FUND-03 resolution ladder: resolve a bounty's GitHub App installation id WITHOUT throwing.
 *   (a) the value already stored on the bounty (bounty.githubInstallationId);
 *   (b) the registered_repositories row for `${owner}/${repo}`;
 *   (c) the App-JWT fallback (resolveInstallationIdForRepo).
 * Returns the resolved id (string) or null. Persistence is the caller's responsibility.
 */
async function resolveBountyInstallationId(bounty: any): Promise<string | null> {
  // (a) already captured on the bounty
  if (bounty.githubInstallationId) {
    return bounty.githubInstallationId;
  }

  const owner = bounty.githubRepoOwner;
  const repo = bounty.githubRepoName;
  if (!owner || !repo) {
    return null;
  }

  // (b) registered_repositories by full_name
  try {
    const registration = await storage.findRepositoryByFullName(`${owner}/${repo}`);
    if (registration && registration.installationId) {
      return registration.installationId;
    }
  } catch (regErr: any) {
    log(`registered_repositories lookup failed for ${owner}/${repo}: ${regErr.message}`, 'relayer-ERROR');
  }

  // (c) App-JWT fallback (best-effort, null on 404/failure)
  return await resolveInstallationIdForRepo(owner, repo);
}

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

    // WHY INSTALLATION ID: Community bounties may be on unregistered repos.
    // FUND-03: resolve via a ladder — stored value → registered_repositories → App-JWT fallback.
    // A missing installation id is RECOVERABLE: route to 'pending_installation' (NOT terminal
    // 'failed_verification') so the gated sweep re-attempts resolution. This is distinct from a
    // genuine merge-verification failure below, which remains terminal 'failed_verification'.
    const installationId = await resolveBountyInstallationId(bounty);
    if (!installationId) {
      log(`Bounty ${bountyId} has no resolvable GitHub installation id. Routing to pending_installation for sweep retry.`, 'relayer');
      await storage.updateCommunityBounty(bountyId, {
        status: 'pending_installation'
      });
      return;
    }

    // FUND-03: persist a freshly-resolved installation id so the sweep/next cycle skips the lookup.
    if (installationId !== bounty.githubInstallationId) {
      await storage.updateCommunityBounty(bountyId, {
        githubInstallationId: installationId
      });
    }

    const verification = await verifyPRMergedAndClosesIssue(
      bounty.githubRepoOwner,
      bounty.githubRepoName,
      bounty.claimedPrNumber,
      bounty.githubIssueNumber,
      installationId
    );

    // WHY LOG VERIFICATION RESULT: Audit trail for all verification attempts (SEC-03: scalar fields only)
    log(`Verification result for bounty ${bountyId}: verified=${verification.verified}, error=${verification.error ?? 'none'}`, 'relayer');

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
    // SEC-03: log only error.message (no full error object dump)
    log(`Error processing bounty ${bountyId}: ${error.message}`, 'relayer-ERROR');

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
  // OPS-01: Per-cycle kill-switch — re-checked every cycle, no restart needed (D-16)
  // Fail-safe: any read error treats relayer as DISABLED
  let isEnabled = false;
  try {
    isEnabled = await storage.getRelayerEnabled();
  } catch (flagErr: any) {
    log(`Kill-switch flag read failed: ${flagErr.message}. Treating relayer as DISABLED.`, 'relayer-ERROR');
    return;
  }
  if (!isEnabled) {
    log('Community bounty relayer is DISABLED via kill-switch. Skipping cycle.', 'relayer');
    return;
  }

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
    // SEC-03: log only error.message (no full error object dump)
    log(`Error in community bounty relayer cycle: ${error.message}`, 'relayer-ERROR');
    // Don't throw - let the interval continue
  }
}

/**
 * FUND-03 RECOVERY SWEEP — re-resolve bounties stuck in 'pending_installation'.
 *
 * WHY: A bounty whose installation id could not be resolved at verification time is parked in
 * the recoverable 'pending_installation' state instead of terminal 'failed_verification'. This
 * sweep re-attempts the resolution ladder (registered_repositories → App-JWT) each cycle.
 *
 * ON RESOLUTION (FIX 10): persist the installation id AND restore the bounty to 'claimed' — the
 * exact status getClaimedCommunityBounties()/processClaimedBounties() scans — so the very next
 * relayer cycle re-picks it and drives the payout. A resolved bounty MUST land back in the
 * scanned 'claimed' state, never a non-scanned limbo.
 *
 * TTL: after MAX_INSTALLATION_RESOLVE_ATTEMPTS unresolved attempts, demote to terminal 'expired'
 * (defunct/uninstalled repos hold no on-chain funds — no bounty stalls forever).
 *
 * GATING: per-cycle kill-switch via storage.getRelayerEnabled() (identical to processClaimedBounties);
 * the interval itself is wired behind FEATURE_FLAGS.COMMUNITY_RELAYER_ENABLED in server/index.ts.
 */
export async function sweepPendingInstallationBounties(): Promise<void> {
  // Per-cycle kill-switch — fail-safe: any read error treats relayer as DISABLED
  let isEnabled = false;
  try {
    isEnabled = await storage.getRelayerEnabled();
  } catch (flagErr: any) {
    log(`Kill-switch flag read failed: ${flagErr.message}. Treating relayer as DISABLED.`, 'relayer-ERROR');
    return;
  }
  if (!isEnabled) {
    log('Community bounty relayer is DISABLED via kill-switch. Skipping pending-installation sweep.', 'relayer');
    return;
  }

  try {
    const pending = await storage.getBountiesPendingInstallation();
    if (pending.length === 0) {
      log('No pending_installation bounties to sweep', 'relayer');
      return;
    }

    log(`Sweeping ${pending.length} pending_installation bounties`, 'relayer');

    for (const bounty of pending) {
      try {
        const installationId = await resolveBountyInstallationId(bounty);

        if (installationId) {
          // RESOLVED → persist id + restore to 'claimed' so the main relayer scan re-picks it
          await storage.updateCommunityBounty(bounty.id, {
            githubInstallationId: installationId,
            status: 'claimed',
          });
          log(`Bounty ${bounty.id} installation id resolved by sweep; restored to claimed for relayer re-pickup`, 'relayer');
          continue;
        }

        // UNRESOLVED → increment attempt counter; TTL-demote to expired past the cap
        const existingMeta = (bounty.metadata && typeof bounty.metadata === 'object') ? bounty.metadata : {};
        const attempts = (Number(existingMeta.installationResolveAttempts) || 0) + 1;

        if (attempts >= MAX_INSTALLATION_RESOLVE_ATTEMPTS) {
          await storage.updateCommunityBounty(bounty.id, {
            status: 'expired',
          });
          log(`Bounty ${bounty.id} unresolved after ${attempts} attempts; TTL-demoted to expired`, 'relayer');
        } else {
          await storage.updateCommunityBounty(bounty.id, {
            metadata: { ...existingMeta, installationResolveAttempts: attempts },
          } as any);
          log(`Bounty ${bounty.id} still unresolved (attempt ${attempts}/${MAX_INSTALLATION_RESOLVE_ATTEMPTS}); will retry next sweep`, 'relayer');
        }
      } catch (perBountyErr: any) {
        log(`Error sweeping pending_installation bounty ${bounty.id}: ${perBountyErr.message}`, 'relayer-ERROR');
        // continue with the rest of the sweep
      }

      // Rate-limit between bounties (GitHub App API)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    log(`Pending-installation sweep complete. Examined ${pending.length} bounties.`, 'relayer');
  } catch (error: any) {
    log(`Error in pending-installation sweep: ${error.message}`, 'relayer-ERROR');
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

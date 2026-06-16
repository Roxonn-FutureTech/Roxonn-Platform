/**
 * scripts/reconcile-payouts.ts
 *
 * FUND-05: Historical on-chain reconciliation / backfill script.
 *
 * Usage:
 *   tsx scripts/reconcile-payouts.ts                  # Dry-run (default) — ZERO DB writes
 *   tsx scripts/reconcile-payouts.ts --apply          # Live backfill (REQUIRES DB-01 index)
 *   tsx scripts/reconcile-payouts.ts --from-block N   # Override scan floor
 *
 * Dry-run:  scans on-chain events, writes a detailed report to
 *           .planning/backfill-mismatch-<date>.csv  (LOCAL, outside the public repo build)
 *           and prints a counts summary to stdout.  Makes ZERO DB writes.
 *
 * --apply:  guards on the presence of the uq_payouts_tx_hash unique index (DB-01),
 *           then upserts each row via onConflictDoNothing({ target: payouts.txHash }).
 *           Re-running is safe: already-inserted rows are silently skipped.
 *           Sends a counts-only ops email (no usernames/amounts in transit — T-02-20).
 *
 * Security notes:
 *  - T-02-20: Detailed username+amount report lives only under .planning/ (local box).
 *  - T-02-21: Script ONLY inserts DB rows. It calls NO contract method, transfers NO funds.
 *  - T-02-22: Defaults to dry-run; mandatory human review of report before --apply.
 *  - T-02-23: Detects same-contributor/repo/issue with differing tx_hash (double-pay flag).
 *  - T-02-24: --apply guards on pg_indexes for the DB-01 unique constraint.
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from '../server/db';
import { payouts } from '../shared/schema';
import { storage } from '../server/storage';
import { config } from '../server/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// ─── Env setup ────────────────────────────────────────────────────────────────
dotenv.config({ path: './server/.env' });

// ─── Script flags ─────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const FROM_BLOCK_ARG: number | undefined = (() => {
  const idx = process.argv.indexOf('--from-block');
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(n)) return n;
  }
  return undefined;
})();

// ─── Block chunk size ─────────────────────────────────────────────────────────
// Q5 (RESEARCH.md) RESOLVED at execution: the configured Ankr XDC RPC
// (rpc.ankr.com/xdc) caps eth_getLogs at ~10,000 blocks (10k OK, 50k → -32062
// "Block range is too large"). 1,000 worked but needed ~14k calls for the
// ~14.4M-block span; 10,000 cuts that ~10x. Override via RECONCILE_CHUNK_SIZE
// for other RPCs. The chunkScan helper still halves the range on RPC rejection.
const CHUNK_SIZE = Number(process.env.RECONCILE_CHUNK_SIZE) || 10000;

// ─── ABI artifacts ────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DualCurrencyArtifact = JSON.parse(
  readFileSync(
    join(__dirname, '../contracts/artifacts/contracts/DualCurrencyRepoRewards.sol/DualCurrencyRepoRewards.json'),
    'utf-8'
  )
);
const CommunityEscrowArtifact = JSON.parse(
  readFileSync(
    join(__dirname, '../contracts/artifacts/contracts/CommunityBountyEscrow.sol/CommunityBountyEscrow.json'),
    'utf-8'
  )
);

// ─── Currency decimals ────────────────────────────────────────────────────────
// Q2 (RESEARCH.md): USDC on XDC uses 6 decimals (standard). Confirmed assumption;
// will be validated at dry-run execution via usdcToken.decimals() if needed.
// XDC and ROXN use 18 decimals (EVM-standard).
const CURRENCY_DECIMALS: Record<string, number> = {
  XDC: 18,
  ROXN: 18,
  USDC: 6,
};

// ─── Type definitions ─────────────────────────────────────────────────────────

interface MismatchEntry {
  txHash: string;
  blockNumber: number;
  contributorAddress: string;
  repoId: string;
  issueId: number;
  reason: string;
}

interface DoublePay {
  repoId: string;
  issueId: number;
  recipientAddress: string;
  txHashes: string[];
}

interface ReportData {
  generatedAt: string;
  deploymentBlock: number;
  toBlock: number;
  rewardDistributedCount: number;
  escrowBountyCompletedCount: number;
  plannedInsertCount: number;
  unresolvedWalletCount: number;
  doublePayCount: number;
  mismatches: MismatchEntry[];
  doublePayFlags: DoublePay[];
  rows: PlannedRow[];
}

interface PlannedRow {
  txHash: string;
  blockNumber: number;
  repoId: string;
  issueId: number;
  contributorAddress: string;
  recipientGithubUsername: string;
  currency: string;
  netAmountHuman: number;
  baseBountyAmount: number;
  amount: string; // contributorPayout from calculateBountyFees
  clientFeeAmount: string;
  contributorFeeAmount: string;
  totalPlatformFee: string;
  walletResolved: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the block where the proxy contract was first deployed by scanning
 * for its Initialized(uint64) event from block 0.
 *
 * Q1 (RESEARCH.md): Exact deployment block unknown until dry-run.
 * Q4 (RESEARCH.md): XDC RPC may or may not accept fromBlock:0 for a broad scan;
 *   if the provider rejects it, fall back to the hardcoded fallback value.
 *
 * Fallback value comment: If the Initialized scan fails, set DEPLOYMENT_BLOCK_FALLBACK
 * to the known deployment block from XDCScan (https://explorer.xinfin.network/).
 */
// Verified 2026-06-16 via eth_getCode binary search on the proxy: block 89474401
// has NO code, 89474402 HAS code → proxy 0x53A2 deployed at block 89474402.
// Used when the Initialized(uint64) scan is rejected (Ankr rejects the full-range
// getLogs), so the scan floor is correct instead of falling back to 0 (#runaway-scan).
const DEPLOYMENT_BLOCK_FALLBACK = 89474402;

async function findDeploymentBlock(
  provider: ethers.JsonRpcProvider,
  proxyAddress: string
): Promise<number> {
  // Topic for Initialized(uint64) — used by OpenZeppelin UUPS proxies
  const initTopic = ethers.id('Initialized(uint64)');
  try {
    console.log(`  Searching for Initialized(uint64) event on proxy ${proxyAddress} from block 0...`);
    const logs = await provider.getLogs({
      address: proxyAddress,
      topics: [initTopic],
      fromBlock: 0,
      toBlock: 'latest',
    });
    if (logs.length > 0) {
      console.log(`  Deployment block found via Initialized event: ${logs[0].blockNumber}`);
      return logs[0].blockNumber;
    }
    console.warn(`  Initialized event not found; falling back to block ${DEPLOYMENT_BLOCK_FALLBACK}`);
    return DEPLOYMENT_BLOCK_FALLBACK;
  } catch (err: any) {
    console.warn(
      `  getLogs for Initialized event failed (${err.message}); falling back to block ${DEPLOYMENT_BLOCK_FALLBACK}`
    );
    return DEPLOYMENT_BLOCK_FALLBACK;
  }
}

/**
 * Chunked event scan with half-range retry on RPC range rejection.
 * Pauses 100ms between chunks to respect XDC rate limits.
 * Q5 (RESEARCH.md): CHUNK_SIZE of 1000 is a safe default; reduce if RPC rejects.
 */
async function chunkScan(
  contract: ethers.Contract,
  eventName: string,
  fromBlock: number,
  toBlock: number
): Promise<ethers.EventLog[]> {
  const events: ethers.EventLog[] = [];

  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, toBlock);

    try {
      const batch = await contract.queryFilter(
        contract.filters[eventName](),
        start,
        end
      );
      events.push(...(batch as ethers.EventLog[]));
      if (batch.length > 0) {
        console.log(`    Blocks ${start}-${end}: ${batch.length} ${eventName} events`);
      }
    } catch (err: any) {
      // XDC RPC may reject large ranges; retry with half-chunk
      console.warn(`    Range ${start}-${end} failed (${err.message}). Retrying with half-chunk...`);
      const mid = Math.floor((start + end) / 2);
      try {
        const half1 = await contract.queryFilter(contract.filters[eventName](), start, mid);
        const half2 = await contract.queryFilter(contract.filters[eventName](), mid + 1, end);
        events.push(...(half1 as ethers.EventLog[]), ...(half2 as ethers.EventLog[]));
        console.log(`    Blocks ${start}-${end} (split): ${half1.length + half2.length} events`);
      } catch (retryErr: any) {
        console.error(`    Half-chunk retry also failed for ${start}-${end}: ${retryErr.message}`);
        throw retryErr;
      }
    }

    // Brief pause between chunks to avoid RPC rate-limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  return events;
}

/**
 * Map a single RewardDistributed event to a planned payout row.
 *
 * event.args:
 *   [0] repoId       BigInt (indexed)
 *   [1] issueId      BigInt (indexed)
 *   [2] contributor  address string (indexed)
 *   [3] amount       BigInt (net payout sent to contributor, non-indexed)
 *   [4] currencyType uint8 (0=XDC, 1=ROXN, 2=USDC, non-indexed)
 *
 * The event.amount is the NET contributor payout (after contributorFee deduction).
 * To derive baseBountyAmount for calculateBountyFees (which uses 2.5% hardcoded):
 *   baseBountyAmount ≈ netAmountHuman / 0.975
 * This is an estimate — tagged metadata.fees_estimated=true per D-04.
 *
 * Q3 (RESEARCH.md): Actual on-chain contributorFeeRate may differ from 2.5% in calculateBountyFees;
 * the estimate is the accepted fallback (D-04). Verify by reading contract.contributorFeeRate().
 */
async function mapEventToRow(
  event: ethers.EventLog
): Promise<{ plannedRow: PlannedRow; mismatch: MismatchEntry | null }> {
  const repoId = event.args[0] as bigint;
  const issueId = event.args[1] as bigint;
  const contributorAddress = event.args[2] as string;  // '0x...' Ethereum-prefixed
  const netAmount = event.args[3] as bigint;
  const currencyType = Number(event.args[4]);

  const currency = ['XDC', 'ROXN', 'USDC'][currencyType] ?? 'XDC';
  const txHash = event.transactionHash;
  const blockNumber = event.blockNumber;

  // Convert net amount to human-readable float with correct decimals
  let netAmountHuman: number;
  if (currency === 'USDC') {
    // Q2: USDC on XDC uses 6 decimals (standard USDC)
    netAmountHuman = Number(netAmount) / 1e6;
  } else {
    // XDC and ROXN use 18 decimals (EVM standard)
    netAmountHuman = parseFloat(ethers.formatEther(netAmount));
  }

  // Derive base bounty amount: the event amount is the net contributor payout
  // after the 0.5% contributor fee (CONTRIBUTOR_FEE_RATE=50bps). Invert: base ≈ netAmount / 0.995.
  // (Verified at dry-run: calculateBountyFees uses 0.5%, so net/0.975 over-estimated base ~2%.)
  const baseBountyAmount = netAmountHuman / 0.995;
  const fees = storage.calculateBountyFees(baseBountyAmount);

  // Sanity check: fees.contributorPayout should ≈ netAmountHuman (within float epsilon)
  const delta = Math.abs(fees.contributorPayout - netAmountHuman);
  if (delta > 0.001 * netAmountHuman) {
    console.warn(
      `  Warning: fee inversion mismatch for tx ${txHash}: ` +
      `event.amount=${netAmountHuman}, fees.contributorPayout=${fees.contributorPayout} (delta=${delta})`
    );
  }

  // Resolve contributor wallet → DB user
  // XDC chain emits '0x'-prefixed addresses; DB stores 'xdc'-prefixed.
  // DB stores xdc-wallet addresses lowercase and getUserByWalletAddress is an exact match,
  // but the on-chain event yields a checksummed (mixed-case) address. Lowercase before lookup
  // (verified at dry-run: without this, all 15 historical payees falsely resolved to "unknown-wallet").
  const xdcAddress = ('xdc' + contributorAddress.slice(2)).toLowerCase();
  let user: any;
  try {
    user = await storage.getUserByWalletAddress(xdcAddress)
      || await storage.getUserByWalletAddress(contributorAddress.toLowerCase());
  } catch (err: any) {
    console.warn(`  User lookup failed for ${xdcAddress}: ${err.message}`);
    user = null;
  }

  const recipientGithubUsername =
    user?.username ?? `unknown-wallet-${contributorAddress.slice(0, 10)}`;
  const recipientUserId: number | null = user?.id ?? null;
  const walletResolved = user != null;

  const mismatch: MismatchEntry | null = walletResolved
    ? null
    : {
        txHash,
        blockNumber,
        contributorAddress,
        repoId: repoId.toString(),
        issueId: Number(issueId),
        reason: 'No DB user found for wallet address',
      };

  const plannedRow: PlannedRow = {
    txHash,
    blockNumber,
    repoId: repoId.toString(),
    issueId: Number(issueId),
    contributorAddress,
    recipientGithubUsername,
    currency,
    netAmountHuman,
    baseBountyAmount: fees.baseBountyAmount,
    // Record the ACTUAL on-chain net payout (the RewardDistributed.amount, ground truth) — NOT the
    // recalculated fees.contributorPayout. The fee breakdown below stays an estimate (fees_estimated=true).
    amount: netAmountHuman.toString(),
    clientFeeAmount: fees.clientFeeAmount.toString(),
    contributorFeeAmount: fees.contributorFeeAmount.toString(),
    totalPlatformFee: fees.totalPlatformFee.toString(),
    walletResolved,
  };

  return { plannedRow, mismatch };
}

/**
 * Detect potential double-pay: two different tx_hashes mapping to the same
 * (recipient wallet, repoId, issueId) tuple. Per T-02-23 / ROADMAP criterion #3.
 */
function detectDoublePay(rows: PlannedRow[]): DoublePay[] {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.contributorAddress}|${row.repoId}|${row.issueId}`;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key)!.add(row.txHash);
  }
  const doublePays: DoublePay[] = [];
  for (const [key, txSet] of seen.entries()) {
    if (txSet.size > 1) {
      const [contributorAddress, repoId, issueIdStr] = key.split('|');
      doublePays.push({
        repoId,
        issueId: Number(issueIdStr),
        recipientAddress: contributorAddress,
        txHashes: Array.from(txSet),
      });
    }
  }
  return doublePays;
}

/**
 * Write the detailed dry-run report to .planning/backfill-mismatch-<date>.csv
 * This file is LOCAL to this box — it must NOT be committed to the public repo (T-02-20).
 * .planning/ is in .gitignore (chore commit 7d9d9d3).
 */
async function writeDryRunReport(report: ReportData): Promise<string> {
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir = path.resolve(process.cwd(), '.planning');
  const reportPath = path.join(reportDir, `backfill-mismatch-${dateStr}.csv`);

  // Ensure .planning/ directory exists
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const lines: string[] = [];

  // Header section
  lines.push('# FUND-05 Reconciliation Report');
  lines.push(`# Generated: ${report.generatedAt}`);
  lines.push(`# Deployment block: ${report.deploymentBlock}`);
  lines.push(`# Scan range: ${report.deploymentBlock}..${report.toBlock}`);
  lines.push(`# RewardDistributed events found: ${report.rewardDistributedCount}`);
  lines.push(`# CommunityBountyEscrow BountyCompleted events: ${report.escrowBountyCompletedCount}`);
  lines.push(`# Planned inserts: ${report.plannedInsertCount}`);
  lines.push(`# Unresolved wallet mismatches: ${report.unresolvedWalletCount}`);
  lines.push(`# Double-pay flags: ${report.doublePayCount}`);
  lines.push('');

  // Escrow verification
  if (report.escrowBountyCompletedCount === 0) {
    lines.push('# VERIFIED: CommunityBountyEscrow has 0 BountyCompleted events');
  } else {
    lines.push(`# WARNING: CommunityBountyEscrow has ${report.escrowBountyCompletedCount} BountyCompleted events — unexpected!`);
  }
  lines.push('');

  // Double-pay flags
  if (report.doublePayFlags.length > 0) {
    lines.push('# === DOUBLE-PAY FLAGS (same contributor/repo/issue, different tx_hash) ===');
    for (const dp of report.doublePayFlags) {
      lines.push(`# DOUBLE-PAY: repoId=${dp.repoId} issueId=${dp.issueId} contributor=${dp.recipientAddress} txHashes=${dp.txHashes.join(',')}`);
    }
    lines.push('');
  }

  // Planned rows CSV
  lines.push('tx_hash,block_number,repo_id,issue_id,contributor_address,github_username,currency,net_amount_human,base_bounty_amount,amount,client_fee,contributor_fee,total_platform_fee,wallet_resolved');
  for (const row of report.rows) {
    lines.push([
      row.txHash,
      row.blockNumber,
      row.repoId,
      row.issueId,
      row.contributorAddress,
      row.recipientGithubUsername,
      row.currency,
      row.netAmountHuman,
      row.baseBountyAmount,
      row.amount,
      row.clientFeeAmount,
      row.contributorFeeAmount,
      row.totalPlatformFee,
      row.walletResolved,
    ].join(','));
  }
  lines.push('');

  // Mismatch section
  if (report.mismatches.length > 0) {
    lines.push('# === UNRESOLVED WALLET MISMATCHES ===');
    lines.push('mismatch_tx_hash,block_number,contributor_address,repo_id,issue_id,reason');
    for (const m of report.mismatches) {
      lines.push([m.txHash, m.blockNumber, m.contributorAddress, m.repoId, m.issueId, m.reason].join(','));
    }
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

/**
 * Send a SHORT counts-only ops summary email via SES.
 * Per T-02-20: the detailed username+amount report stays local; only counts travel over the wire.
 */
async function sendOpsSummaryEmail(params: {
  insertedCount: number;
  skippedCount: number;
  mismatchCount: number;
  doublePayCount: number;
  escrowCount: number;
  deploymentBlock: number;
}): Promise<void> {
  const ses = new SESClient({ region: config.awsRegion });
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || config.supportEmail;
  const SOURCE_EMAIL = config.supportEmail;

  const body = `FUND-05 Backfill Applied — Counts Summary

Deployment block scanned from: ${params.deploymentBlock}
Rows inserted: ${params.insertedCount}
Rows skipped (already present): ${params.skippedCount}
Unresolved wallet mismatches: ${params.mismatchCount}
Double-pay flags: ${params.doublePayCount}
CommunityBountyEscrow BountyCompleted events: ${params.escrowCount} (expected 0)

Detailed username/amount report: LOCAL only (under .planning/ on this box — NOT emailed).

Review the report file and the payouts table to confirm correctness.
If double-pay flags > 0, investigate before closing FUND-05.`;

  try {
    await ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        Source: SOURCE_EMAIL,
        Message: {
          Subject: { Data: '[FUND-05] Backfill applied — counts summary' },
          Body: { Text: { Data: body } },
        },
      })
    );
    console.log(`Ops summary email sent to ${ADMIN_EMAIL}`);
  } catch (err: any) {
    console.warn(`Failed to send ops summary email: ${err.message} (non-fatal)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== FUND-05: Payout Reconciliation Script ===');
  console.log(`Mode: ${APPLY ? 'APPLY (live DB writes)' : 'DRY-RUN (no DB writes)'}`);
  if (FROM_BLOCK_ARG !== undefined) {
    console.log(`Block floor override: ${FROM_BLOCK_ARG}`);
  }
  console.log('');

  // ─── Provider setup ─────────────────────────────────────────────────────────
  const rpcUrl = config.xdcNodeUrl || 'https://rpc.xinfin.network';
  console.log(`Connecting to XDC RPC: ${rpcUrl}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });

  // Verify connection
  const latestBlock = await provider.getBlockNumber();
  console.log(`Connected. Latest block: ${latestBlock}`);

  // ─── Contract instances ──────────────────────────────────────────────────────
  const rewardsAddress = config.repoRewardsContractAddress.replace(/^xdc/, '0x');
  if (!rewardsAddress || rewardsAddress === '0x') {
    throw new Error('DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS (or REPO_REWARDS_CONTRACT_ADDRESS) is not set');
  }

  const rewardsContract = new ethers.Contract(
    rewardsAddress,
    DualCurrencyArtifact.abi,
    provider
  );

  const escrowAddress = config.communityBountyEscrowAddress
    ? config.communityBountyEscrowAddress.replace(/^xdc/, '0x')
    : null;
  if (!escrowAddress) {
    throw new Error('COMMUNITY_BOUNTY_ESCROW_ADDRESS is not set in config');
  }

  const escrowContract = new ethers.Contract(
    escrowAddress,
    CommunityEscrowArtifact.abi,
    provider
  );

  // ─── Determine scan floor ────────────────────────────────────────────────────
  const fromBlock =
    FROM_BLOCK_ARG !== undefined
      ? FROM_BLOCK_ARG
      : await findDeploymentBlock(provider, rewardsAddress);
  const toBlock = latestBlock;

  console.log(`\nScan range: blocks ${fromBlock}..${toBlock} (${toBlock - fromBlock + 1} blocks)`);

  // ─── Step 1: Scan RewardDistributed events ───────────────────────────────────
  console.log('\nStep 1: Scanning RewardDistributed events on rewards proxy...');
  const rewardEvents = await chunkScan(rewardsContract, 'RewardDistributed', fromBlock, toBlock);
  console.log(`  Total RewardDistributed events found: ${rewardEvents.length}`);

  // ─── Step 2: Verify CommunityBountyEscrow has 0 BountyCompleted events ───────
  console.log('\nStep 2: Checking CommunityBountyEscrow (0x6E3B) for BountyCompleted events...');
  const escrowEvents = await chunkScan(escrowContract, 'BountyCompleted', fromBlock, toBlock);
  console.log(`  CommunityBountyEscrow BountyCompleted events: ${escrowEvents.length}`);
  if (escrowEvents.length === 0) {
    console.log('  VERIFIED: CommunityBountyEscrow has 0 BountyCompleted events');
  } else {
    console.warn(`  WARNING: Unexpected ${escrowEvents.length} BountyCompleted events found on escrow!`);
  }

  // ─── Step 3: Map events to planned rows ─────────────────────────────────────
  console.log('\nStep 3: Mapping events to payout rows...');
  const plannedRows: PlannedRow[] = [];
  const mismatches: MismatchEntry[] = [];

  for (let i = 0; i < rewardEvents.length; i++) {
    const event = rewardEvents[i];
    if (i % 10 === 0 || i === rewardEvents.length - 1) {
      process.stdout.write(`\r  Processing event ${i + 1}/${rewardEvents.length}...`);
    }
    const { plannedRow, mismatch } = await mapEventToRow(event);
    plannedRows.push(plannedRow);
    if (mismatch) mismatches.push(mismatch);
  }
  if (rewardEvents.length > 0) process.stdout.write('\n');

  // ─── Step 4: Double-pay detection ────────────────────────────────────────────
  const doublePayFlags = detectDoublePay(plannedRows);
  if (doublePayFlags.length > 0) {
    console.warn(`\nWARNING: ${doublePayFlags.length} potential double-pay(s) detected (same contributor/repo/issue, different tx_hash):`);
    for (const dp of doublePayFlags) {
      console.warn(`  repoId=${dp.repoId} issueId=${dp.issueId} contributor=${dp.recipientAddress} txHashes=${dp.txHashes.join(', ')}`);
    }
  } else {
    console.log('\nNo double-pays detected.');
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const reportData: ReportData = {
    generatedAt: new Date().toISOString(),
    deploymentBlock: fromBlock,
    toBlock,
    rewardDistributedCount: rewardEvents.length,
    escrowBountyCompletedCount: escrowEvents.length,
    plannedInsertCount: plannedRows.length,
    unresolvedWalletCount: mismatches.length,
    doublePayCount: doublePayFlags.length,
    mismatches,
    doublePayFlags,
    rows: plannedRows,
  };

  // ─── Dry-run path ─────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\n=== DRY-RUN SUMMARY ===');
    console.log(`  Deployment block used:        ${fromBlock}`);
    console.log(`  Latest block scanned:         ${toBlock}`);
    console.log(`  RewardDistributed events:     ${rewardEvents.length}`);
    console.log(`  BountyCompleted (escrow):     ${escrowEvents.length} (expected 0)`);
    console.log(`  Planned inserts:              ${plannedRows.length}`);
    console.log(`  Unresolved wallet mismatches: ${mismatches.length}`);
    console.log(`  Double-pay flags:             ${doublePayFlags.length}`);
    console.log('');
    console.log('ZERO DB writes performed (dry-run mode).');

    const reportPath = await writeDryRunReport(reportData);
    console.log(`\nDetailed report written to: ${reportPath}`);
    console.log('(This file is LOCAL — it is outside the public repo and must not be committed.)');
    console.log('\nTo apply the backfill (AFTER human review of this report):');
    console.log('  tsx scripts/reconcile-payouts.ts --apply');
    return;
  }

  // ─── Apply path ───────────────────────────────────────────────────────────────
  console.log('\n=== APPLY MODE: Writing to live DB ===');

  // Guard: verify the DB-01 unique index exists before proceeding (T-02-24)
  // The uq_payouts_tx_hash unique constraint is required for onConflictDoNothing to resolve.
  console.log('Checking for DB-01 UNIQUE index on payouts.tx_hash...');
  // Match a UNIQUE single-column index on tx_hash specifically — NOT any index whose name
  // contains "tx_hash". The stale non-unique idx_payouts_tx_hash (migration 0022) would satisfy
  // a `LIKE '%tx_hash%'` name match and false-pass this guard in exactly the pre-0026 state the
  // guard exists to catch; onConflictDoNothing then fails loud with Postgres 42P10. Check
  // indisunique=true on a single column named tx_hash instead (and ignore the constraint name,
  // so a Drizzle-pushed `payouts_tx_hash_unique` is also accepted).
  const indexCheck = await db.execute(sql`
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE t.relname = 'payouts'
      AND i.indisunique = true
      AND i.indnatts = 1
      AND a.attname = 'tx_hash'
  `);
  const indexRows = Array.isArray(indexCheck) ? indexCheck : ((indexCheck as any).rows ?? []);
  if (indexRows.length === 0) {
    throw new Error(
      'DB-01 UNIQUE index on payouts.tx_hash not found. Run the DB-01 migration first:\n' +
      '  psql "$DATABASE_URL" -f migrations/0026_add_payouts_tx_hash_unique.sql\n' +
      'A UNIQUE constraint (not the legacy non-unique idx_payouts_tx_hash) is required for\n' +
      'onConflictDoNothing({ target: payouts.txHash }) to correctly identify duplicates.'
    );
  }
  console.log('  DB-01 unique index found — proceeding with upsert.');

  // Upsert each row via onConflictDoNothing keyed on txHash (idempotent, T-02-21)
  let insertedCount = 0;
  let skippedCount = 0;

  for (const row of plannedRows) {
    // Build the NewPayout insert object matching shared/schema.ts columns
    const insertRow = {
      repositoryGithubId: row.repoId,
      issueNumber: row.issueId,
      recipientUserId: null as number | null, // re-resolve via walletResolved flag
      recipientGithubUsername: row.recipientGithubUsername,
      recipientWalletAddress: ('xdc' + row.contributorAddress.slice(2)).toLowerCase(),
      amount: row.amount,
      currency: row.currency,
      baseBountyAmount: row.baseBountyAmount.toString(),
      clientFeeAmount: row.clientFeeAmount,
      contributorFeeAmount: row.contributorFeeAmount,
      totalPlatformFee: row.totalPlatformFee,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      payoutType: 'pool' as const,
      poolManagerAddress: null as string | null,
      communityBountyId: null as number | null,
      metadata: {
        backfilled: true,
        fees_estimated: true,
        scanBlock: row.blockNumber,
      },
    };

    // Resolve recipientUserId if user was found during planning
    if (row.walletResolved) {
      try {
        const xdcAddr = ('xdc' + row.contributorAddress.slice(2)).toLowerCase();
        const user = await storage.getUserByWalletAddress(xdcAddr)
          || await storage.getUserByWalletAddress(row.contributorAddress.toLowerCase());
        insertRow.recipientUserId = user?.id ?? null;
      } catch {
        insertRow.recipientUserId = null;
      }
    }

    const result = await db
      .insert(payouts)
      .values(insertRow)
      .onConflictDoNothing({ target: payouts.txHash })
      .returning({ id: payouts.id });

    if (result.length > 0) {
      insertedCount++;
    } else {
      skippedCount++;
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Rows inserted:              ${insertedCount}`);
  console.log(`  Rows skipped (duplicates):  ${skippedCount}`);
  console.log(`  Mismatches (no user):       ${mismatches.length}`);
  console.log(`  Double-pay flags:           ${doublePayFlags.length}`);
  if (escrowEvents.length === 0) {
    console.log('  VERIFIED: CommunityBountyEscrow has 0 BountyCompleted events');
  }

  // Write the detailed report locally even in apply mode (for audit trail)
  const reportPath = await writeDryRunReport(reportData);
  console.log(`\nDetailed report written to: ${reportPath}`);

  // Send counts-only ops email (T-02-20: no usernames/amounts in transit)
  await sendOpsSummaryEmail({
    insertedCount,
    skippedCount,
    mismatchCount: mismatches.length,
    doublePayCount: doublePayFlags.length,
    escrowCount: escrowEvents.length,
    deploymentBlock: fromBlock,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

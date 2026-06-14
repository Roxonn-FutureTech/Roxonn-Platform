/**
 * scripts/reconcile-installations.ts
 *
 * FUND-03: Installation-id backfill / stuck-bounty reconciliation script.
 *
 * Recovers the existing stuck community bounties (SC#5: "existing bounties are
 * backfillable so none permanently stalls"). A stuck bounty is one with a NULL
 * github_installation_id whose status is not yet terminal
 * (NOT IN ('completed','refunded','expired')).
 *
 * Usage:
 *   tsx scripts/reconcile-installations.ts            # Dry-run (default) — ZERO DB writes
 *   tsx scripts/reconcile-installations.ts --apply    # Live backfill (REQUIRES FUND-03 column)
 *
 * Resolution order PER bounty (RC-3) — ALL THREE steps are attempted for EVERY
 * stuck bounty and the per-bounty source + last step reached is RECORDED BEFORE
 * any bounty is classified expirable (FIX 12):
 *   (1) registered_repositories.installation_id by exact full_name `${owner}/${repo}`
 *   (2) registered_repositories.github_repo_id == webhook_deliveries.repository_id
 *       (latest by received_at) → webhook_deliveries.installation_id
 *   (3) resolveInstallationIdForRepo(owner, repo) — GitHub App JWT fallback
 *       (attempted even for defunct repos; expect a 404/null).
 * Only AFTER all three steps fail may a bounty be classified expirable.
 *
 * The webhook_deliveries repo-NAME-column join is INFEASIBLE (that column is NULL
 * on all 17,007 rows) and is deliberately NOT used; we join on the numeric
 * repository_id instead.
 *
 * Dry-run:  resolves each stuck bounty through the 3-step chain (including a REAL
 *           App-JWT call for unresolved repos), writes a detailed per-bounty
 *           source-tagged report to .planning/installations-backfill-<date>.csv
 *           (LOCAL, outside the public repo), and prints a counts summary.
 *           Makes ZERO DB writes.
 *
 * --apply:  guards on the presence of the FUND-03 github_installation_id column,
 *           then for each resolved bounty sets github_installation_id (idempotent),
 *           and for each bounty unresolvable after all 3 steps sets status='expired'
 *           (terminal — Risk #16; these hold no on-chain funds). Re-running is a
 *           no-op. Sends a counts-only ops email (no owner/repo in transit).
 *
 * Security notes:
 *  - T-04-B3: Detailed owner/repo + installation-id report lives only under
 *    .planning/ (local box). SES email is counts-only.
 *  - T-04-B4: Resolution uses EXACT full_name / github_repo_id joins (never the
 *    fuzzy/NULL repo-name column); all 3 steps attempted + recorded before expiry.
 *  - T-04-B2: 3-step resolution attempted ONCE per bounty; unresolved repos go
 *    terminal 'expired' (not retried forever).
 *  - T-04-B1: defaults to dry-run; --apply guards on the FUND-03 column; writes
 *    are idempotent; mandatory human review of the report before --apply.
 *  - T-04-SC: no new packages (tsx/drizzle/SES already present).
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { sql, eq, and, isNull, notInArray, desc } from 'drizzle-orm';
import { db } from '../server/db';
import {
  communityBounties,
  registeredRepositories,
  webhookDeliveries,
} from '../shared/schema';
import { config } from '../server/config';
import { resolveInstallationIdForRepo } from '../server/github';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// ─── Env setup ────────────────────────────────────────────────────────────────
dotenv.config({ path: './server/.env' });

// ─── Script flags ─────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');

// Terminal statuses a stuck bounty must NOT already be in.
const TERMINAL_STATUSES = ['completed', 'refunded', 'expired'];

// ─── Types ──────────────────────────────────────────────────────────────────-─
type ResolutionStep =
  | 'registered_repositories.full_name'
  | 'webhook_deliveries.repository_id'
  | 'app_jwt'
  | 'unresolved';

interface BountyResolution {
  id: number;
  owner: string;
  repo: string;
  fullName: string;
  issueNumber: number;
  status: string;
  // Per-step trace (recorded for ALL bounties BEFORE any expiry classification — FIX 12)
  step1FullNameResult: string | null;     // installation_id from registered_repositories.full_name
  step2RepoIdResult: string | null;       // installation_id from webhook_deliveries via github_repo_id
  step3AppJwtAttempted: boolean;          // App-JWT fallback actually invoked
  step3AppJwtResult: string | null;       // installation_id from App JWT (null => 404/not-installed)
  resolvedInstallationId: string | null;  // first non-null across steps 1→2→3
  resolvedBy: ResolutionStep;             // which step produced the id (or 'unresolved')
  classification: 'recover' | 'expire';   // expire ONLY after all 3 steps failed
}

interface ReportData {
  generatedAt: string;
  mode: 'DRY-RUN' | 'APPLY';
  totalStuck: number;
  recoverCount: number;
  expireCount: number;
  // apply-only outcomes
  recoveredWritten: number;
  recoveredSkipped: number;
  expiredWritten: number;
  expiredSkipped: number;
  resolutions: BountyResolution[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the stuck community bounties: github_installation_id IS NULL AND status
 * NOT IN ('completed','refunded','expired'). Matches the RESEARCH.md find-stuck SQL.
 */
async function findStuckBounties() {
  return db
    .select({
      id: communityBounties.id,
      owner: communityBounties.githubRepoOwner,
      repo: communityBounties.githubRepoName,
      issueNumber: communityBounties.githubIssueNumber,
      status: communityBounties.status,
    })
    .from(communityBounties)
    .where(
      and(
        isNull(communityBounties.githubInstallationId),
        notInArray(communityBounties.status, TERMINAL_STATUSES)
      )
    )
    .orderBy(communityBounties.id);
}

/**
 * Step 1: registered_repositories.installation_id by exact full_name.
 */
async function resolveViaRegisteredFullName(fullName: string): Promise<string | null> {
  const rows = await db
    .select({ installationId: registeredRepositories.installationId })
    .from(registeredRepositories)
    .where(eq(registeredRepositories.githubRepoFullName, fullName))
    .limit(1);
  return rows[0]?.installationId ?? null;
}

/**
 * Step 2: registered_repositories.github_repo_id == webhook_deliveries.repository_id
 * (latest delivery by received_at) → webhook_deliveries.installation_id.
 * Uses the numeric repository_id, NEVER the NULL-on-all-rows repo-name column.
 */
async function resolveViaWebhookRepositoryId(fullName: string): Promise<string | null> {
  // Find the registered_repositories.github_repo_id for this full_name.
  const reg = await db
    .select({ githubRepoId: registeredRepositories.githubRepoId })
    .from(registeredRepositories)
    .where(eq(registeredRepositories.githubRepoFullName, fullName))
    .limit(1);
  const githubRepoId = reg[0]?.githubRepoId;
  if (!githubRepoId) return null;

  // Latest webhook delivery for that repository_id that carries an installation_id.
  const wd = await db
    .select({ installationId: webhookDeliveries.installationId })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.repositoryId, githubRepoId))
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(50);
  for (const row of wd) {
    if (row.installationId) return row.installationId;
  }
  return null;
}

/**
 * Resolve a single stuck bounty through ALL THREE steps, recording each.
 * The App-JWT fallback (step 3) is ALWAYS attempted when steps 1-2 fail,
 * including for defunct repos (expected 404 → null) — FIX 12.
 */
async function resolveBounty(b: {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  status: string;
}): Promise<BountyResolution> {
  const fullName = `${b.owner}/${b.repo}`;

  // Step 1 — registered_repositories.full_name
  const step1 = await resolveViaRegisteredFullName(fullName);

  // Step 2 — webhook_deliveries via github_repo_id (only meaningful if step 1 null,
  // but always recorded for the trace)
  const step2 = step1 === null ? await resolveViaWebhookRepositoryId(fullName) : null;

  // Step 3 — App-JWT fallback. Attempted for EVERY bounty not resolved by 1-2,
  // so the 10 defunct repos actually reach + 404 the App API before being expired.
  let step3Attempted = false;
  let step3: string | null = null;
  if (step1 === null && step2 === null) {
    step3Attempted = true;
    step3 = await resolveInstallationIdForRepo(b.owner, b.repo);
  }

  const resolvedInstallationId = step1 ?? step2 ?? step3 ?? null;
  let resolvedBy: ResolutionStep = 'unresolved';
  if (step1 !== null) resolvedBy = 'registered_repositories.full_name';
  else if (step2 !== null) resolvedBy = 'webhook_deliveries.repository_id';
  else if (step3 !== null) resolvedBy = 'app_jwt';

  return {
    id: b.id,
    owner: b.owner,
    repo: b.repo,
    fullName,
    issueNumber: b.issueNumber,
    status: b.status,
    step1FullNameResult: step1,
    step2RepoIdResult: step2,
    step3AppJwtAttempted: step3Attempted,
    step3AppJwtResult: step3,
    resolvedInstallationId,
    resolvedBy,
    // Expire ONLY after all 3 steps have failed (FIX 12 / Risk #16).
    classification: resolvedInstallationId !== null ? 'recover' : 'expire',
  };
}

/**
 * --apply precondition guard: verify the FUND-03 github_installation_id column
 * exists on community_bounties before writing (analogous to reconcile-payouts.ts's
 * pg_index precondition). Refuse to write if absent.
 */
async function assertFund03ColumnExists(): Promise<void> {
  const res = await db.execute(sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'community_bounties'
      AND column_name = 'github_installation_id'
  `);
  const rows = Array.isArray(res) ? res : ((res as any).rows ?? []);
  if (rows.length === 0) {
    throw new Error(
      'FUND-03 precondition failed: community_bounties.github_installation_id column not found.\n' +
      'Apply the FUND-03 schema migration (plan 04-03) before running --apply.'
    );
  }
}

/**
 * Write the detailed per-bounty report to .planning/installations-backfill-<date>.csv.
 * LOCAL only — must NOT be committed to the public repo (T-04-B3). .planning/ is gitignored.
 */
function writeReport(report: ReportData): string {
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir = path.resolve(process.cwd(), '.planning');
  const reportPath = path.join(reportDir, `installations-backfill-${dateStr}.csv`);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const lines: string[] = [];
  lines.push('# FUND-03 Installation-id Backfill Report');
  lines.push(`# Generated: ${report.generatedAt}`);
  lines.push(`# Mode: ${report.mode}`);
  lines.push(`# Stuck bounties found: ${report.totalStuck}`);
  lines.push(`# Recoverable (installation_id resolved): ${report.recoverCount}`);
  lines.push(`# Expirable (all 3 steps failed): ${report.expireCount}`);
  if (report.mode === 'APPLY') {
    lines.push(`# Recovered written: ${report.recoveredWritten} (skipped/no-op: ${report.recoveredSkipped})`);
    lines.push(`# Expired written: ${report.expiredWritten} (skipped/no-op: ${report.expiredSkipped})`);
  }
  lines.push('');
  lines.push(
    'id,full_name,issue_number,status,' +
    'step1_registered_full_name,step2_webhook_repository_id,' +
    'step3_app_jwt_attempted,step3_app_jwt_result,' +
    'resolved_installation_id,resolved_by,classification'
  );
  for (const r of report.resolutions) {
    lines.push([
      r.id,
      r.fullName,
      r.issueNumber,
      r.status,
      r.step1FullNameResult ?? '',
      r.step2RepoIdResult ?? '',
      r.step3AppJwtAttempted ? 'yes' : 'no',
      r.step3AppJwtResult ?? (r.step3AppJwtAttempted ? '404/null' : ''),
      r.resolvedInstallationId ?? '',
      r.resolvedBy,
      r.classification,
    ].join(','));
  }
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

/**
 * Counts-only SES ops email (T-04-B3: no owner/repo/installation-id in transit).
 */
async function sendOpsSummaryEmail(report: ReportData): Promise<void> {
  const ses = new SESClient({ region: config.awsRegion });
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || config.supportEmail;
  const SOURCE_EMAIL = config.supportEmail;

  const body = `FUND-03 Installation-id Backfill Applied — Counts Summary

Stuck bounties found: ${report.totalStuck}
Recoverable (installation_id resolved): ${report.recoverCount}
Expirable (all 3 steps failed incl. App-JWT 404): ${report.expireCount}
Recovered rows written: ${report.recoveredWritten} (no-op: ${report.recoveredSkipped})
Expired rows written: ${report.expiredWritten} (no-op: ${report.expiredSkipped})

Detailed per-bounty owner/repo report: LOCAL only (under .planning/ — NOT emailed).`;

  try {
    await ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        Source: SOURCE_EMAIL,
        Message: {
          Subject: { Data: '[FUND-03] Installation-id backfill — counts summary' },
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
  console.log('=== FUND-03: Installation-id Backfill / Stuck-Bounty Reconciliation ===');
  console.log(`Mode: ${APPLY ? 'APPLY (live DB writes)' : 'DRY-RUN (no DB writes)'}`);
  console.log('');

  // ─── Step 0: find stuck bounties ──────────────────────────────────────────
  const stuck = await findStuckBounties();
  console.log(`Found ${stuck.length} stuck bount${stuck.length === 1 ? 'y' : 'ies'} ` +
    `(github_installation_id NULL, status NOT IN ${JSON.stringify(TERMINAL_STATUSES)}).`);
  console.log('');

  // ─── Step 1: resolve EVERY stuck bounty through all 3 steps (FIX 12) ───────
  const resolutions: BountyResolution[] = [];
  for (const b of stuck) {
    const r = await resolveBounty(b);
    resolutions.push(r);
    const stepNote =
      r.classification === 'recover'
        ? `RECOVER via ${r.resolvedBy} → installation_id ${r.resolvedInstallationId}`
        : `EXPIRE (step1 null, step2 null, App-JWT attempted=${r.step3AppJwtAttempted} → ${r.step3AppJwtResult ?? '404/null'})`;
    console.log(`  [#${r.id}] ${r.fullName} issue#${r.issueNumber} (${r.status}): ${stepNote}`);
  }
  console.log('');

  const recover = resolutions.filter((r) => r.classification === 'recover');
  const expire = resolutions.filter((r) => r.classification === 'expire');

  const report: ReportData = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    totalStuck: stuck.length,
    recoverCount: recover.length,
    expireCount: expire.length,
    recoveredWritten: 0,
    recoveredSkipped: 0,
    expiredWritten: 0,
    expiredSkipped: 0,
    resolutions,
  };

  // ─── Dry-run path ─────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('=== DRY-RUN SUMMARY ===');
    console.log(`  Stuck bounties:            ${report.totalStuck}`);
    console.log(`  Recoverable:               ${report.recoverCount}`);
    console.log(`  Expirable (3 steps failed):${report.expireCount}`);
    console.log('');
    console.log('ZERO DB writes performed (dry-run mode).');
    const reportPath = writeReport(report);
    console.log(`\nDetailed report written to: ${reportPath}`);
    console.log('(This file is LOCAL — under .planning/, must not be committed.)');
    console.log('\nTo apply the backfill (AFTER human review of this report):');
    console.log('  tsx scripts/reconcile-installations.ts --apply');
    return;
  }

  // ─── Apply path ───────────────────────────────────────────────────────────
  console.log('=== APPLY MODE: Writing to live DB ===');
  await assertFund03ColumnExists();
  console.log('  FUND-03 column github_installation_id present — proceeding.');

  // Recover: set github_installation_id. Idempotent — only update rows still NULL.
  for (const r of recover) {
    const res = await db
      .update(communityBounties)
      .set({ githubInstallationId: r.resolvedInstallationId! })
      .where(
        and(
          eq(communityBounties.id, r.id),
          isNull(communityBounties.githubInstallationId)
        )
      )
      .returning({ id: communityBounties.id });
    if (res.length > 0) report.recoveredWritten++;
    else report.recoveredSkipped++;
  }

  // Expire: set status='expired' (terminal). Idempotent — only update rows not
  // already terminal AND still missing an installation id.
  for (const r of expire) {
    const res = await db
      .update(communityBounties)
      .set({ status: 'expired' })
      .where(
        and(
          eq(communityBounties.id, r.id),
          isNull(communityBounties.githubInstallationId),
          notInArray(communityBounties.status, TERMINAL_STATUSES)
        )
      )
      .returning({ id: communityBounties.id });
    if (res.length > 0) report.expiredWritten++;
    else report.expiredSkipped++;
  }

  console.log('\nBackfill complete:');
  console.log(`  Recovered written:  ${report.recoveredWritten} (no-op: ${report.recoveredSkipped})`);
  console.log(`  Expired written:    ${report.expiredWritten} (no-op: ${report.expiredSkipped})`);

  const reportPath = writeReport(report);
  console.log(`\nDetailed report written to: ${reportPath}`);
  await sendOpsSummaryEmail(report);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

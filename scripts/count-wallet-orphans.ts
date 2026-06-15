/**
 * scripts/count-wallet-orphans.ts
 *
 * D-09: pending_wallets orphan counter — FUND-02 evidence trail.
 *
 * Usage:
 *   tsx scripts/count-wallet-orphans.ts
 *
 * Prints a counts summary to stdout:
 *   - Total rows in pending_wallets
 *   - True orphans: rows whose referenceId has NO matching users.walletReferenceId
 *   - TTL-at-risk: rows whose expiresAt is already in the past
 *
 * Security notes (T-05-12, T-05-13):
 *  - T-05-12: READ-ONLY by construction. Performs ZERO DB writes. No --apply branch.
 *             No update/delete/insert call anywhere in this file. No backfill.
 *  - T-05-13: Prints COUNTS ONLY. Never prints encryptedPrivateKey or encryptedMnemonic
 *             values. No key material is ever emitted to stdout or logs.
 *
 * Expected result on prod: 0 orphans, 0 expired (confirmed by CONTEXT.md + RESEARCH.md).
 * If this script reports > 0 orphans, file a follow-up — this phase's FUND-02 fix
 * (scripts/autoRegistration.ts transaction-safe promotion) prevents future orphans,
 * but a one-time cleanup may be needed for any pre-fix rows.
 */

import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from '../server/db';
import { pendingWallets, users } from '../shared/schema';

// ─── Env setup ────────────────────────────────────────────────────────────────
dotenv.config({ path: './server/.env' });

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== pending_wallets orphan count (READ-ONLY) ===');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log('');

  // 1. Total rows in pending_wallets
  const totalResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingWallets);
  const totalPending = totalResult[0]?.count ?? 0;

  // 2. True orphans: pending rows with no matching users.walletReferenceId
  //    A "true orphan" means FUND-02 promotion never ran for this referenceId
  //    (or the user row was never created / walletReferenceId was never set).
  const orphanResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingWallets)
    .where(
      sql`${pendingWallets.referenceId} NOT IN (
        SELECT wallet_reference_id
        FROM ${users}
        WHERE wallet_reference_id IS NOT NULL
      )`
    );
  const trueOrphans = orphanResult[0]?.count ?? 0;

  // 3. TTL-at-risk: pending rows already past expiresAt
  //    These would be cleaned up by getWalletSecret() on next access (aws.ts:318-326)
  //    but represent keys that can no longer be retrieved via the pending fallback path.
  const expiredResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingWallets)
    .where(sql`${pendingWallets.expiresAt} < NOW()`);
  const expiredRows = expiredResult[0]?.count ?? 0;

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('Results:');
  console.log(`  Total pending_wallets rows : ${totalPending}`);
  console.log(`  True orphans (no user match): ${trueOrphans}`);
  console.log(`  TTL-at-risk (expiresAt past) : ${expiredRows}`);
  console.log('');

  if (trueOrphans === 0 && expiredRows === 0) {
    console.log('STATUS: CLEAN — no orphans, no expired rows. FUND-02 is fully satisfied.');
  } else {
    console.log('STATUS: ACTION NEEDED');
    if (trueOrphans > 0) {
      console.log(`  WARNING: ${trueOrphans} true orphan(s) found. These users may lose wallet access`);
      console.log('           once the pending_wallets TTL expires. File a follow-up for manual promotion.');
    }
    if (expiredRows > 0) {
      console.log(`  WARNING: ${expiredRows} expired row(s) found. These keys are already unretrievable`);
      console.log('           via the pending fallback path (aws.ts getWalletSecret).');
    }
  }

  console.log('');
  console.log('NOTE: This script makes ZERO DB writes. Re-running is always safe.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('count-wallet-orphans: fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

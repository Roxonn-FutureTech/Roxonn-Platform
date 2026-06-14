/**
 * server/__tests__/payoutIntegration.test.ts
 *
 * Real-DB integration test: insert a payout via storage.recordPayout() against
 * the dedicated roxonn_test Postgres database, then select it back and assert
 * that the correct columns round-trip and that the persisted amount equals the
 * net contributor payout (the FUND-04 regression a mocked DB cannot catch).
 *
 * SAFETY DESIGN:
 *   - The entire suite is wrapped in `describe.skipIf(!TEST_DATABASE_URL)` so
 *     it is SKIPPED (exits 0) when TEST_DATABASE_URL is unset — `npm test` stays
 *     green for mocked-only runs that have no local DB.
 *   - Inside, `beforeAll(() => requireTestDb())` is a second line of defence: it
 *     throws unless the active DATABASE_URL (post-swap by tests/setup.ts) names
 *     exactly "roxonn_test", so the destructive truncate can never touch prod even
 *     if this file is somehow invoked with a misconfigured URL.
 *   - The test NEVER sets DATABASE_URL itself.
 *   - All fixtures are synthetic (no real wallet/key/tx literals).
 *
 * Cases:
 *   (1) INSERT -> SELECT (FUND-04 catch): real recordPayout insert; select back;
 *       assert every NOT-NULL column round-trips and amount === net contributorPayout.
 *   (2) DUP-GUARD: getPayoutByRepoAndIssue returns the inserted row for the same
 *       repo/issue pair — the real (repository_github_id, issue_number) guard fires.
 *   (3) TX_HASH UNIQUENESS: a second insert with the same txHash rejects with a
 *       "tx_hash idempotency" message — the real UNIQUE constraint drives the error.
 */

import { describe, beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { requireTestDb } from '../../tests/setup';
import { db } from '../db';
import { storage } from '../storage';
import { payouts } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { buildPoolPayoutRow } from '../utils/payoutMapper';
import {
  seedUser,
  seedRepo,
  truncateAll,
} from '../../tests/fixtures/payoutFixtures';

// ---------------------------------------------------------------------------
// Safety: skip the entire suite when TEST_DATABASE_URL is not set.
// describe.skipIf returns a skipped suite when the condition is truthy, so we
// negate: skip when the env var is falsy (unset / empty string).
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_DATABASE_URL)('payout integration (roxonn_test)', () => {

  // Belt-and-suspenders: requireTestDb() throws unless DATABASE_URL names roxonn_test.
  // This runs BEFORE any truncate/seed so we can never truncate the wrong DB.
  beforeAll(() => requireTestDb());

  // Shared state seeded fresh before each test
  let userId: number;
  let repoGithubId: string;
  let walletAddress: string;
  let githubUsername: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await seedUser();
    const repo = await seedRepo(user.id);
    userId = user.id;
    repoGithubId = repo.githubRepoId;
    walletAddress = user.xdcWalletAddress!;
    githubUsername = user.githubUsername;
  });

  afterAll(async () => {
    await truncateAll();
  });

  // -------------------------------------------------------------------------
  // Case (1): INSERT -> SELECT — the FUND-04 regression catch
  // -------------------------------------------------------------------------
  it('inserts a payout row and selects it back with correct columns and net amount', async () => {
    const BASE_BOUNTY = 100;
    const TX_HASH = '0xtesthash1';
    const ISSUE_NUMBER = 42;

    // Build the insert row using the same mapper the live code uses.
    // amount = storage.calculateBountyFees(baseBountyAmount).contributorPayout
    const row = buildPoolPayoutRow({
      repositoryGithubId: repoGithubId,
      issueNumber: ISSUE_NUMBER,
      recipientGithubUsername: githubUsername,
      recipientUserId: userId,
      recipientWalletAddress: walletAddress,
      baseBountyAmount: BASE_BOUNTY,
      currency: 'XDC',
      txHash: TX_HASH,
      blockNumber: 1,
      poolManagerAddress: walletAddress,
    });

    // Real insert — must not throw
    const inserted = await storage.recordPayout(row);
    expect(inserted).toBeDefined();

    // Select the row back from the DB directly to prove the insert landed
    const [persisted] = await db.select().from(payouts).where(eq(payouts.txHash, TX_HASH));

    expect(persisted).toBeDefined();

    // Core identity columns
    expect(persisted.recipientGithubUsername).toBe(githubUsername);
    expect(persisted.recipientWalletAddress).toBe(walletAddress);
    expect(persisted.payoutType).toBe('pool');
    expect(persisted.txHash).toBe(TX_HASH);
    expect(persisted.issueNumber).toBe(ISSUE_NUMBER);
    expect(persisted.repositoryGithubId).toBe(repoGithubId);
    expect(persisted.currency).toBe('XDC');

    // FUND-04: amount must equal the NET contributor payout (not the baseBountyAmount)
    const expectedContributorPayout = storage.calculateBountyFees(BASE_BOUNTY).contributorPayout;
    expect(Number(persisted.amount)).toBeCloseTo(expectedContributorPayout, 6);

    // Spot-check the fee columns (they should round-trip from the mapper output)
    expect(Number(persisted.baseBountyAmount)).toBeCloseTo(BASE_BOUNTY, 6);
    expect(Number(persisted.clientFeeAmount)).toBeGreaterThan(0);
    expect(Number(persisted.contributorFeeAmount)).toBeGreaterThan(0);

    // The original bogus 'status' column was never in the schema — assert it's absent
    expect(persisted).not.toHaveProperty('status');
  });

  // -------------------------------------------------------------------------
  // Case (2): DUP-GUARD — getPayoutByRepoAndIssue returns the inserted row
  // -------------------------------------------------------------------------
  it('dup-guard: getPayoutByRepoAndIssue returns the inserted row for the same repo/issue', async () => {
    const TX_HASH = '0xtesthash2';
    const ISSUE_NUMBER = 99;

    const row = buildPoolPayoutRow({
      repositoryGithubId: repoGithubId,
      issueNumber: ISSUE_NUMBER,
      recipientGithubUsername: githubUsername,
      recipientUserId: userId,
      recipientWalletAddress: walletAddress,
      baseBountyAmount: 50,
      currency: 'XDC',
      txHash: TX_HASH,
      blockNumber: 2,
      poolManagerAddress: walletAddress,
    });

    await storage.recordPayout(row);

    // The real dup-guard: query by repo + issue number
    const found = await storage.getPayoutByRepoAndIssue(repoGithubId, ISSUE_NUMBER);

    expect(found).not.toBeNull();
    expect(found!.txHash).toBe(TX_HASH);
    expect(found!.issueNumber).toBe(ISSUE_NUMBER);
    expect(found!.repositoryGithubId).toBe(repoGithubId);
  });

  // -------------------------------------------------------------------------
  // Case (3): TX_HASH UNIQUENESS — duplicate txHash must throw the idempotency error
  // -------------------------------------------------------------------------
  it('tx_hash uniqueness: duplicate txHash insert rejects with tx_hash idempotency error', async () => {
    const TX_HASH = '0xtesthash3';

    // First insert — must succeed
    const firstRow = buildPoolPayoutRow({
      repositoryGithubId: repoGithubId,
      issueNumber: 10,
      recipientGithubUsername: githubUsername,
      recipientUserId: userId,
      recipientWalletAddress: walletAddress,
      baseBountyAmount: 200,
      currency: 'XDC',
      txHash: TX_HASH,
      blockNumber: 3,
      poolManagerAddress: walletAddress,
    });
    await storage.recordPayout(firstRow);

    // Second insert with the SAME txHash (different issue) — must throw idempotency error
    const duplicateRow = buildPoolPayoutRow({
      repositoryGithubId: repoGithubId,
      issueNumber: 11,  // different issue to avoid the repo/issue unique constraint
      recipientGithubUsername: githubUsername,
      recipientUserId: userId,
      recipientWalletAddress: walletAddress,
      baseBountyAmount: 200,
      currency: 'XDC',
      txHash: TX_HASH,  // same txHash — this is what we are testing
      blockNumber: 4,
      poolManagerAddress: walletAddress,
    });

    await expect(storage.recordPayout(duplicateRow)).rejects.toThrow('tx_hash idempotency');
  });

});

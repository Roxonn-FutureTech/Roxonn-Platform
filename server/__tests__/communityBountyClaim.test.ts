/**
 * server/__tests__/communityBountyClaim.test.ts
 *
 * Regression test: canonical claim-marking uses correct columns + idempotency (D-10 #3, INFLIGHT-03).
 *
 * DESIGN:
 *   Primary suite: pure-mock unit tests — no DB required; always runs; npm test stays green.
 *   Optional suite: describe.skipIf(!TEST_DATABASE_URL) integration block using requireTestDb().
 *
 * INFLIGHT-03 discharge:
 *   - Test 1 (correct columns): claimCommunityBountyAtomic marks status:'claimed' with the 6
 *     correct claim columns (claimedByUserId, claimedByGithubUsername, claimedPrNumber,
 *     claimedPrUrl, claimedAt — plus githubInstallationId captured post-claim in the caller).
 *     It does NOT reference phantom columns repoFullName / issueNumber / rewardAmount.
 *   - Test 2 (idempotency): a second claim attempt against a bounty whose status is NOT 'funded'
 *     throws (the status guard in the Drizzle transaction fires) — no double-claim.
 *
 * SEC-03: this file does not log full bounty/error objects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock db — vi.mock is hoisted, so the factory must be self-contained.
// We use vi.hoisted() to hoist the mock function definitions so they are
// available when the factory runs.
// ---------------------------------------------------------------------------
const { mockTransaction, mockSelect, mockFrom, mockSelectWhere, mockFor, mockLimit,
        mockUpdate, mockSet, mockUpdateWhere, mockReturning,
        mockInsertReturning, mockInsertValues, mockInsert } = vi.hoisted(() => {
  const mockReturning = vi.fn();
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const mockLimit = vi.fn();
  const mockFor = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockSelectWhere = vi.fn().mockReturnValue({ for: mockFor });
  const mockFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const mockTransaction = vi.fn();

  // Insert chain for createCommunityBounty tests
  const mockInsertReturning = vi.fn();
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  return {
    mockTransaction,
    mockSelect,
    mockFrom,
    mockSelectWhere,
    mockFor,
    mockLimit,
    mockUpdate,
    mockSet,
    mockUpdateWhere,
    mockReturning,
    mockInsertReturning,
    mockInsertValues,
    mockInsert,
  };
});

vi.mock('../db', () => ({
  db: {
    transaction: mockTransaction,
    insert: mockInsert,
  },
}));

// Mock resolveInstallationIdForRepo — default returns null; individual tests override as needed.
const mockResolveInstallationId = vi.fn().mockResolvedValue(null);
vi.mock('../github', () => ({
  resolveInstallationIdForRepo: (...args: any[]) => mockResolveInstallationId(...args),
}));

// Import storage AFTER the mock is established
import { storage } from '../storage';

describe('claimCommunityBountyAtomic — canonical claim-marking contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire the chains after clearAllMocks resets all mock implementations
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ for: mockFor });
    mockFor.mockReturnValue({ limit: mockLimit });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockReturning });
    // Re-wire insert chain
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
  });

  // -------------------------------------------------------------------------
  // Test 1: correct claim columns
  // -------------------------------------------------------------------------
  it('Test 1 (correct columns): UPDATE sets status:claimed with the 6 correct claim columns', async () => {
    const fundedBounty = {
      id: 42,
      status: 'funded',
      amount: '100',
      currency: 'XDC',
    };

    const claimedBounty = {
      ...fundedBounty,
      status: 'claimed',
      claimedByUserId: 7,
      claimedByGithubUsername: 'alice',
      claimedPrNumber: 99,
      claimedPrUrl: 'https://github.com/org/repo/pull/99',
      claimedAt: new Date(),
    };

    // mock the transaction to run the callback with a mock tx
    mockTransaction.mockImplementation(async (cb: (tx: any) => any) => {
      const mockTx = {
        select: mockSelect,
        update: mockUpdate,
      };
      return cb(mockTx);
    });

    // SELECT returns funded bounty
    mockLimit.mockResolvedValue([fundedBounty]);
    // UPDATE .returning() resolves with claimed bounty
    mockReturning.mockResolvedValue([claimedBounty]);

    const result = await storage.claimCommunityBountyAtomic(
      42,
      7,
      'alice',
      99,
      'https://github.com/org/repo/pull/99'
    );

    // Verify db.transaction was called
    expect(mockTransaction).toHaveBeenCalledOnce();

    // Verify UPDATE .set(...) was called
    expect(mockSet).toHaveBeenCalledOnce();
    const setCallArg = mockSet.mock.calls[0][0] as Record<string, unknown>;

    // Assert all 6 correct claim columns are present
    expect(setCallArg).toMatchObject({
      status: 'claimed',
      claimedByUserId: 7,
      claimedByGithubUsername: 'alice',
      claimedPrNumber: 99,
      claimedPrUrl: 'https://github.com/org/repo/pull/99',
      claimedAt: expect.any(Date),
    });

    // Assert ABSENCE of phantom columns from the deleted communityBountyWebhookHandlers.ts bug
    expect(setCallArg).not.toHaveProperty('repoFullName');
    expect(setCallArg).not.toHaveProperty('issueNumber');
    expect(setCallArg).not.toHaveProperty('rewardAmount');

    // Verify return value
    expect(result).toEqual(claimedBounty);
  });

  // -------------------------------------------------------------------------
  // Test 2: idempotency — second claim on non-funded bounty throws
  // -------------------------------------------------------------------------
  it('Test 2 (idempotency): throws when bounty status is not "funded" — prevents double-claim', async () => {
    const alreadyClaimedBounty = {
      id: 42,
      status: 'claimed', // already claimed — NOT 'funded'
    };

    mockTransaction.mockImplementation(async (cb: (tx: any) => any) => {
      const mockTx = {
        select: mockSelect,
        update: mockUpdate,
      };
      return cb(mockTx);
    });

    // SELECT returns already-claimed bounty (non-funded status)
    mockLimit.mockResolvedValue([alreadyClaimedBounty]);

    // The status guard (bounty.status !== 'funded') must throw
    await expect(
      storage.claimCommunityBountyAtomic(
        42,
        7,
        'alice',
        99,
        'https://github.com/org/repo/pull/99'
      )
    ).rejects.toThrow(/not claimable/i);

    // UPDATE should NOT have been called (guard fires before update)
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: bounty not found throws
  // -------------------------------------------------------------------------
  it('throws when bounty does not exist', async () => {
    mockTransaction.mockImplementation(async (cb: (tx: any) => any) => {
      const mockTx = {
        select: mockSelect,
        update: mockUpdate,
      };
      return cb(mockTx);
    });

    // SELECT returns empty (bounty not found)
    mockLimit.mockResolvedValue([]);

    await expect(
      storage.claimCommunityBountyAtomic(
        999,
        7,
        'alice',
        99,
        'https://github.com/org/repo/pull/99'
      )
    ).rejects.toThrow(/not found/i);

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-06: createCommunityBounty — githubInstallationId null-tolerant & resolver-throws-non-fatal
//
// Pure-mock unit tests (no TEST_DATABASE_URL required).
// Validates the D-06 safety property: bounty creation NEVER fails due to a
// resolver null or throw — both cases must result in a successful insert with
// githubInstallationId: null written to the row.
// ---------------------------------------------------------------------------
describe('createCommunityBounty — D-06 installation-id null-tolerant safety', () => {
  const minimalBountyData = {
    githubRepoOwner: 'test-owner',
    githubRepoName: 'test-repo',
    githubIssueNumber: 1,
    githubIssueId: 'I_test123',
    githubIssueUrl: 'https://github.com/test-owner/test-repo/issues/1',
    createdByGithubUsername: 'testuser',
    title: 'Test bounty',
    amount: '10',
    currency: 'XDC',
  };

  const mockBountyRow = { id: 1, ...minimalBountyData, status: 'pending_payment', githubInstallationId: null };

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire insert chain
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([mockBountyRow]);
    // Re-wire select/update chains so existing tests still work if combined
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ for: mockFor });
    mockFor.mockReturnValue({ limit: mockLimit });
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockReturning });
    // Reset resolver mock to default (null)
    mockResolveInstallationId.mockResolvedValue(null);
  });

  // Test 2 (null-tolerant): createCommunityBounty with githubInstallationId omitted succeeds.
  // The storage insert is called and a bounty is returned even when no installation id is provided.
  it('Test 2 (null-tolerant): create succeeds with githubInstallationId omitted/null; row inserted', async () => {
    const bounty = await storage.createCommunityBounty(minimalBountyData);

    // Insert was called (bounty was created — not aborted)
    expect(mockInsert).toHaveBeenCalledOnce();

    // .values() was called with githubInstallationId: null (no-op path)
    const valuesArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.githubInstallationId).toBeNull();

    // Return value is the mocked bounty row
    expect(bounty).toEqual(mockBountyRow);
  });

  // Test 2b: explicit null passed through correctly
  it('Test 2b (explicit null): create with githubInstallationId: null still inserts null', async () => {
    const bounty = await storage.createCommunityBounty({
      ...minimalBountyData,
      githubInstallationId: null,
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const valuesArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.githubInstallationId).toBeNull();
    expect(bounty).toEqual(mockBountyRow);
  });

  // Test 3 (resolver-throws is non-fatal): the caller try/catch catches a resolver throw,
  // passes null into createCommunityBounty, and the bounty insert still proceeds.
  // Verified by calling createCommunityBounty with null (mirrors what the route/bot callers do
  // after catching the resolver throw) — the storage layer does not throw on null installationId.
  it('Test 3 (resolver-throws non-fatal): createCommunityBounty with null (from caught throw) still inserts row', async () => {
    // Simulate the caller behaviour: resolver throws, caller sets null, calls createCommunityBounty
    mockResolveInstallationId.mockRejectedValue(new Error('GitHub App not installed'));

    // Mimic the try/catch pattern from the route handler and bot caller
    let creationInstallationId: string | null = null;
    try {
      creationInstallationId = await mockResolveInstallationId('test-owner', 'test-repo');
    } catch {
      // resolver threw — creationInstallationId stays null (non-fatal)
    }
    // Assert the resolver set null after the throw
    expect(creationInstallationId).toBeNull();

    // Now call createCommunityBounty with the null installation id — must succeed
    const bounty = await storage.createCommunityBounty({
      ...minimalBountyData,
      githubInstallationId: creationInstallationId,
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const valuesArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesArg.githubInstallationId).toBeNull();
    expect(bounty).toEqual(mockBountyRow);
  });
});

// ---------------------------------------------------------------------------
// Optional integration suite — skipped when TEST_DATABASE_URL is not set
// so `npm test` stays green without a real database.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'claimCommunityBountyAtomic integration (roxonn_test)',
  () => {
    // Resolved lazily inside beforeEach so they are only accessed when the
    // suite actually runs (TEST_DATABASE_URL is set).
    let requireTestDb: () => void;
    let realDb: any;
    let communityBountiesTable: any;
    let realEq: any;
    let realStorage: any;

    beforeEach(async () => {
      const setup = await import('../../tests/setup');
      requireTestDb = setup.requireTestDb;
      const dbMod = await import('../db');
      realDb = dbMod.db;
      const schema = await import('../../shared/schema');
      communityBountiesTable = schema.communityBounties;
      const drizzle = await import('drizzle-orm');
      realEq = drizzle.eq;
      const storageMod = await import('../storage');
      realStorage = storageMod.storage;

      requireTestDb();
      // Clean up any leftover test rows
      await realDb.delete(communityBountiesTable)
        .where(realEq(communityBountiesTable.repositoryGithubId, 'test-repo-claim-99999'));
    });

    it('real-DB: claim marks correct columns; second claim throws (idempotent)', async () => {
      // Seed a minimal funded community bounty row
      const [seeded] = await realDb.insert(communityBountiesTable).values({
        repositoryGithubId: 'test-repo-claim-99999',
        issueNumber: 1,
        status: 'funded',
        amount: '10',
        currency: 'XDC',
        issueTitle: 'Test integration claim',
        issueUrl: 'https://github.com/test/repo/issues/1',
      } as any).returning();

      // First claim — should succeed
      const claimed = await realStorage.claimCommunityBountyAtomic(
        seeded.id,
        1001,
        'testclaimuser',
        55,
        'https://github.com/test/repo/pull/55'
      );

      expect(claimed.status).toBe('claimed');
      expect(claimed.claimedByUserId).toBe(1001);
      expect(claimed.claimedByGithubUsername).toBe('testclaimuser');
      expect(claimed.claimedPrNumber).toBe(55);
      expect(claimed.claimedPrUrl).toBe('https://github.com/test/repo/pull/55');
      expect(claimed.claimedAt).toBeInstanceOf(Date);
      // Phantom columns must not be present
      expect(Object.keys(claimed)).not.toContain('repoFullName');
      expect(Object.keys(claimed)).not.toContain('rewardAmount');

      // Second claim — must throw (idempotency guard)
      await expect(
        realStorage.claimCommunityBountyAtomic(
          seeded.id,
          1001,
          'testclaimuser',
          55,
          'https://github.com/test/repo/pull/55'
        )
      ).rejects.toThrow(/not claimable/i);
    });
  }
);

// ---------------------------------------------------------------------------
// D-06 integration suite (Test 1) — verifies githubInstallationId is persisted.
// Skipped when TEST_DATABASE_URL is not set so `npm test` stays green.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'createCommunityBounty D-06 integration (roxonn_test)',
  () => {
    let requireTestDb: () => void;
    let realDb: any;
    let communityBountiesTable: any;
    let realEq: any;
    let realStorage: any;

    beforeEach(async () => {
      const setup = await import('../../tests/setup');
      requireTestDb = setup.requireTestDb;
      const dbMod = await import('../db');
      realDb = dbMod.db;
      const schema = await import('../../shared/schema');
      communityBountiesTable = schema.communityBounties;
      const drizzle = await import('drizzle-orm');
      realEq = drizzle.eq;
      const storageMod = await import('../storage');
      realStorage = storageMod.storage;

      requireTestDb();
      // Clean up any leftover test rows from D-06 create tests
      await realDb.delete(communityBountiesTable).where(
        realEq(communityBountiesTable.githubIssueId, 'I_d06_integration_test')
      );
    });

    // Test 1 (D-06 happy path): createCommunityBounty persists githubInstallationId
    // when a value is provided (confirms the column write reaches the DB row).
    it('Test 1 (happy path): persists githubInstallationId when provided at creation', async () => {
      const bounty = await realStorage.createCommunityBounty({
        githubRepoOwner: 'test-owner',
        githubRepoName: 'test-repo',
        githubIssueNumber: 9999,
        githubIssueId: 'I_d06_integration_test',
        githubIssueUrl: 'https://github.com/test-owner/test-repo/issues/9999',
        createdByGithubUsername: 'testuser',
        title: 'D-06 integration test bounty',
        amount: '10',
        currency: 'XDC',
        githubInstallationId: 'inst_d06_test_123',
      });

      expect(bounty.githubInstallationId).toBe('inst_d06_test_123');
      expect(bounty.id).toBeGreaterThan(0);
      expect(bounty.status).toBe('pending_payment');

      // Verify the row is also readable back from the DB with the correct field
      const [row] = await realDb.select()
        .from(communityBountiesTable)
        .where(realEq(communityBountiesTable.githubIssueId, 'I_d06_integration_test'));
      expect(row.githubInstallationId).toBe('inst_d06_test_123');
    });
  }
);

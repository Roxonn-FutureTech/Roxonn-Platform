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
        mockUpdate, mockSet, mockUpdateWhere, mockReturning } = vi.hoisted(() => {
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
  };
});

vi.mock('../db', () => ({
  db: {
    transaction: mockTransaction,
  },
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

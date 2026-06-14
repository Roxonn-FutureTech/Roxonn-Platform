/**
 * tests/fixtures/payoutFixtures.ts
 *
 * SYNTHETIC DATA ONLY — no real wallet addresses, private keys, GitHub ids, or tokens.
 * All values are test-only placeholders that can never be mistaken for production data.
 *
 * These helpers are imported exclusively inside integration tests that run against the
 * roxonn_test database. tests/setup.ts must have swapped DATABASE_URL to roxonn_test
 * before any import of server/db.ts occurs (which happens when this module is imported).
 *
 * FK deletion order for truncateAll():
 *   payouts (references users + communityBounties)
 *   → registered_repositories (references users)
 *   → users
 * This order satisfies all FK constraints without needing CASCADE.
 */

import { db } from '../../server/db';
import { users, registeredRepositories, payouts } from '../../shared/schema';

// Simple counter for unique-within-run synthetic ids
let _seq = 0;
function seq(): number {
  return ++_seq;
}

// -----------------------------------------------------------------------
// seedUser — insert a minimal users row with synthetic data
// -----------------------------------------------------------------------
// Required NOT-NULL columns (from shared/schema.ts users table):
//   githubId (unique text), username (unique text), githubUsername (text),
//   githubAccessToken (text), promptBalance (integer, has default so can omit)
// Optional but useful: xdcWalletAddress (text, nullable in schema)
export async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<typeof users.$inferSelect> {
  const n = seq();
  // Synthetic wallet address: 42 chars starting with "xdc", padded with zeros — NOT a real address
  const syntheticWallet = `xdc${'0'.repeat(36)}${String(n).padStart(3, '0')}`;

  const row: typeof users.$inferInsert = {
    githubId: `test-gh-${n}-${Date.now()}`,
    username: `test-user-${n}`,
    githubUsername: `test-user-${n}`,
    githubAccessToken: `ghs_SYNTHETIC_TEST_TOKEN_${n}`,
    xdcWalletAddress: syntheticWallet,
    ...overrides,
  };

  const [inserted] = await db.insert(users).values(row).returning();
  return inserted;
}

// -----------------------------------------------------------------------
// seedRepo — insert a minimal registered_repositories row linked to a user
// -----------------------------------------------------------------------
// Required NOT-NULL columns (from shared/schema.ts registeredRepositories table):
//   githubRepoId (unique text), githubRepoFullName (text)
// Optional: userId (FK to users.id), installationId, isPrivate, isActive
export async function seedRepo(
  userId: number,
  overrides: Partial<typeof registeredRepositories.$inferInsert> = {}
): Promise<typeof registeredRepositories.$inferSelect> {
  const n = seq();

  const row: typeof registeredRepositories.$inferInsert = {
    userId,
    githubRepoId: `test-repo-id-${n}-${Date.now()}`,
    githubRepoFullName: `test-owner-${n}/test-repo-${n}`,
    installationId: null,
    isPrivate: false,
    isActive: true,
    ...overrides,
  };

  const [inserted] = await db.insert(registeredRepositories).values(row).returning();
  return inserted;
}

// -----------------------------------------------------------------------
// truncateAll — delete all test rows in FK-safe child-to-parent order
// -----------------------------------------------------------------------
// Order:
//   1. payouts (FK: recipientUserId -> users, communityBountyId -> communityBounties)
//   2. registered_repositories (FK: userId -> users)
//   3. users (parent)
//
// Does NOT delete communityBounties rows — those are out of scope for this fixture set.
// If a test seeds communityBounties rows it should clean them up itself after payouts
// is cleared (the FK from payouts -> communityBounties uses onDelete: 'set null').
export async function truncateAll(): Promise<void> {
  await db.delete(payouts);
  await db.delete(registeredRepositories);
  await db.delete(users);
}

/**
 * tests/setup.ts — Vitest global setupFile (wired in vitest.config.ts setupFiles)
 *
 * Safety decision: D-03 (03-CONTEXT.md) — hard prod-guard.
 *
 * ORDERING: This file is evaluated BEFORE any test module imports server/db.ts.
 * server/db.ts reads config.databaseUrl at module-import time (via server/config.ts
 * which reads process.env.DATABASE_URL). So we MUST set process.env.DATABASE_URL here,
 * at top-level, before any test file is executed.
 *
 * UNSET = NO-OP: When TEST_DATABASE_URL is UNSET this file does NOTHING.
 * This is intentional (D-01 hybrid): mocked/unit tests (payoutMapper.test.ts, etc.)
 * do not need a DB and must continue running without one. Only integration tests
 * that actually hit the DB are expected to run with TEST_DATABASE_URL set.
 *
 * SET + WRONG NAME = THROW: If TEST_DATABASE_URL is set but points at any database
 * other than "roxonn_test", this file throws a SAFETY error and refuses to proceed.
 * This prevents truncating the production database, even accidentally.
 *
 * SET + CORRECT NAME = SWAP: Only if the URL names exactly "roxonn_test" is
 * process.env.DATABASE_URL overwritten with TEST_DATABASE_URL. This happens here,
 * at module evaluation time, so db.ts reads the test DB URL on its first import.
 */

const testDbUrl = process.env.TEST_DATABASE_URL;

if (testDbUrl) {
  // Parse the database name from the URL (URL.pathname is "/<dbname>")
  let dbName: string;
  try {
    dbName = new URL(testDbUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error(
      `SAFETY: TEST_DATABASE_URL is not a valid URL: "${testDbUrl}". ` +
        'Must be a valid postgres:// connection string naming roxonn_test.'
    );
  }

  if (dbName !== 'roxonn_test') {
    throw new Error(
      `SAFETY: TEST_DATABASE_URL must point to a database named "roxonn_test", ` +
        `but got "${dbName}". ` +
        'Refusing to run — destructive/truncate tests must NEVER touch prod. ' +
        'Create a dedicated roxonn_test database and update TEST_DATABASE_URL.'
    );
  }

  // Assertion passed: swap DATABASE_URL BEFORE db.ts is imported.
  // This must happen at module top-level (not inside beforeAll) so the
  // postgres() client in server/db.ts picks up the test URL on its first import.
  process.env.DATABASE_URL = testDbUrl;
}

// -----------------------------------------------------------------------
// requireTestDb() — hard guard for destructive integration tests
// -----------------------------------------------------------------------
// Call this in beforeAll of any test that truncates tables.
// It re-derives the active db name from process.env.DATABASE_URL (post-swap)
// and throws unless it is exactly "roxonn_test".
//
// This is a second line of defence: even if setup.ts ran as a no-op (because
// TEST_DATABASE_URL was unset), any integration test that calls requireTestDb()
// in its beforeAll will refuse to proceed — DATABASE_URL would still name prod.
export function requireTestDb(): void {
  const activeUrl = process.env.DATABASE_URL;
  if (!activeUrl) {
    throw new Error(
      'SAFETY: DATABASE_URL is not set. ' +
        'Cannot verify test-database isolation. ' +
        'Set TEST_DATABASE_URL=postgres://.../roxonn_test before running integration tests.'
    );
  }

  let activeDbName: string;
  try {
    activeDbName = new URL(activeUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error(
      `SAFETY: DATABASE_URL is not a valid URL: "${activeUrl}". ` +
        'Cannot verify test-database isolation.'
    );
  }

  if (activeDbName !== 'roxonn_test') {
    throw new Error(
      `SAFETY: Active DATABASE_URL points to "${activeDbName}", not "roxonn_test". ` +
        'Refusing to run — destructive integration tests must NEVER touch prod. ' +
        'Ensure TEST_DATABASE_URL is set to a postgres://.../roxonn_test URL and ' +
        'that tests/setup.ts ran before any DB import.'
    );
  }
}

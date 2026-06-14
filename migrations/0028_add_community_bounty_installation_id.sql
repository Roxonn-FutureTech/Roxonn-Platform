-- Migration: Add github_installation_id to community_bounties (FUND-03 schema-drift catch-up)
-- Description: Declares-of-record the GitHub App installation id column on community_bounties.
-- Security: ADDITIVE-ONLY. Contains exactly one idempotent ADD COLUMN IF NOT EXISTS.
--           NO DROP, NO destructive ALTER on any column. Safe against a live, fund-holding DB.

/*
 * WHY THIS MIGRATION EXISTS (RC-4, 04-RESEARCH "FUND-03 Implementation"):
 * - The live prod DB ALREADY HAS this column: it was added out-of-band via `drizzle-kit push`,
 *   with no migration file and no git history. `shared/schema.ts` did NOT declare it until
 *   plan 04-02 (githubInstallationId: text("github_installation_id"), nullable).
 * - This file is the schema-drift catch-up OF RECORD: it brings the migration history in line
 *   with both the live column and the Drizzle declaration.
 *
 * WHY HAND-WRITTEN, NOT drizzle-kit push/generate (Risk #4, HIGH):
 * - `drizzle-kit push` against the live fund DB could attempt DESTRUCTIVE changes if Drizzle's
 *   snapshot disagrees on OTHER already-drifted columns. This file touches ONLY the one column.
 *
 * IDEMPOTENCY / NO-OP ON PROD:
 * - Because the column already exists in prod, `ADD COLUMN IF NOT EXISTS` is a metadata no-op
 *   there (no table rewrite, no lock of consequence). It was validated on the isolated
 *   `roxonn_test` DB first (where it actually adds the column), including a second run to prove
 *   re-application is a clean no-op.
 *
 * TYPE: text, nullable — matches shared/schema.ts:668
 *   `githubInstallationId: text("github_installation_id")`
 *   (mirrors webhook_deliveries.installation_id; FUND-03 capture-forward / pending_installation).
 */

ALTER TABLE community_bounties
  ADD COLUMN IF NOT EXISTS github_installation_id text;

-- Documentation comment (idempotent; COMMENT ON is non-destructive)
COMMENT ON COLUMN community_bounties.github_installation_id IS 'GitHub App installation id for the bounty repo (FUND-03). Captured forward at claim/funding; absence routes to recoverable pending_installation status. Mirrors webhook_deliveries.installation_id.';

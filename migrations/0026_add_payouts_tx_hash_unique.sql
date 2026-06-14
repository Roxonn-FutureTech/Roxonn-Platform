-- Migration: Add UNIQUE constraint on payouts.tx_hash for transaction-level idempotency (DB-01)
-- Description: Enables onConflictDoNothing() keyed on tx_hash; backs up the per-issue unique index
-- Safety: payouts table is empty (0 rows as of 2026-06-14) — no existing duplicates to resolve.

-- Drop the existing non-unique index (redundant once UNIQUE constraint exists)
DROP INDEX IF EXISTS idx_payouts_tx_hash;

-- Add UNIQUE constraint (creates unique index implicitly)
ALTER TABLE payouts ADD CONSTRAINT uq_payouts_tx_hash UNIQUE (tx_hash);

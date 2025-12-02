-- Migration: Add missing columns and fix promotional bounties schema
-- Description: Add reward_distributed fields to promotional submissions and ensure all columns are properly defined

-- Ensure the promotional_submissions table has the correct columns needed for reward tracking
-- These are already defined in shared/schema.ts but may not yet be in the database

ALTER TABLE promotional_submissions
ADD COLUMN IF NOT EXISTS reward_distributed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS reward_distributed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS reward_amount_distributed DECIMAL(18,8);

-- Ensure the promotional_bounties table has the reward_currency column with proper constraints
ALTER TABLE promotional_bounties
ADD COLUMN IF NOT EXISTS reward_currency TEXT DEFAULT 'XDC';

-- Add check constraint for reward_currency if it doesn't exist yet
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'promotional_bounties_reward_currency_check'
    ) THEN
        ALTER TABLE promotional_bounties
        ADD CONSTRAINT promotional_bounties_reward_currency_check
        CHECK (reward_currency IN ('XDC', 'ROXN', 'USDC'));
    END IF;
END $$;

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status ON promotional_bounties(status);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_expires_at ON promotional_bounties(expires_at);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status ON promotional_submissions(bounty_id, status);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_contributor ON promotional_submissions(bounty_id, contributor_id);

-- Add GIN index for the JSONB promotional_channels field to improve filtering performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_channels_gin ON promotional_bounties USING GIN (promotional_channels);

-- Update any existing records that might be missing reward_currency (should use default from schema)
-- This is a safeguard in case the default wasn't properly applied during earlier migrations
UPDATE promotional_bounties
SET reward_currency = 'XDC'
WHERE reward_currency IS NULL;

-- Ensure the status column has the correct default value
ALTER TABLE promotional_bounties ALTER COLUMN status SET DEFAULT 'DRAFT';
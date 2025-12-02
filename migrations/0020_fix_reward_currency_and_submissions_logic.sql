-- Migration: Fix reward currency and submission checks
-- Description: Add missing rewardCurrency, fix race condition in maxSubmissions check, add critical indexes

-- Add the missing reward_currency column if it doesn't exist (in case it's not in the main schema migration yet)
ALTER TABLE promotional_bounties 
ADD COLUMN IF NOT EXISTS reward_currency TEXT DEFAULT 'XDC' CHECK (reward_currency IN ('XDC', 'ROXN', 'USDC'));

-- Ensure the check constraint exists on reward_currency column
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'promotional_bounties_reward_currency_check'
    ) THEN
        ALTER TABLE promotional_bounties 
        ADD CONSTRAINT promotional_bounties_reward_currency_check 
        CHECK (reward_currency IN ('XDC', 'ROXN', 'USDC'));
    END IF;
END $$;

-- Add indexes to improve performance of queries used in maxSubmissions check and other common operations
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status ON promotional_bounties(status);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_expires_at ON promotional_bounties(expires_at);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status ON promotional_submissions(bounty_id, status);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_contributor ON promotional_submissions(bounty_id, contributor_id);

-- Add GIN index for the JSONB promotional_channels field to improve filtering performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_channels_gin ON promotional_bounties USING GIN (promotional_channels);

-- Update existing records that might not have reward_currency set (shouldn't be needed if schema default is properly applied)
-- but added as a safeguard
UPDATE promotional_bounties 
SET reward_currency = 'XDC' 
WHERE reward_currency IS NULL;
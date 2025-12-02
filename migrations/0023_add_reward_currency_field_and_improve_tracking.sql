-- Migration: Add reward currency distributed field and improve promotional submissions tracking
-- Description: Adds rewardCurrencyDistributed field and enhances reward tracking for promotional submissions

-- Add reward_currency_distributed column to track which currency was distributed
ALTER TABLE promotional_submissions 
ADD COLUMN IF NOT EXISTS reward_currency_distributed TEXT CHECK (reward_currency_distributed IN ('XDC', 'ROXN', 'USDC'));

-- Add reward_distribution_failure_reason column to track why distribution failed
ALTER TABLE promotional_submissions 
ADD COLUMN IF NOT EXISTS reward_distribution_failure_reason TEXT;

-- Add indexes to improve performance for reward and submission queries
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_distributed 
ON promotional_submissions(reward_distributed);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_distributed_at 
ON promotional_submissions(reward_distributed_at);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_currency_distributed 
ON promotional_submissions(reward_currency_distributed);

-- Add composite index for efficient maxSubmissions checks (bounty_id + status)
-- This will help with the query that checks for approved/pending submissions
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status 
ON promotional_submissions(bounty_id, status);

-- Add index for bounty submissions query performance (bounty_id + contributor_id)
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_contributor 
ON promotional_submissions(bounty_id, contributor_id);

-- Add indexes for better performance on promotional_bounties table
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status 
ON promotional_bounties(status);

CREATE INDEX IF NOT EXISTS idx_promotional_bounties_repo_id 
ON promotional_bounties(repo_id);

CREATE INDEX IF NOT EXISTS idx_promotional_bounties_creator_id 
ON promotional_bounties(creator_id);

CREATE INDEX IF NOT EXISTS idx_promotional_bounties_expires_at 
ON promotional_bounties(expires_at) WHERE expires_at IS NOT NULL;

-- GIN index for JSONB promotional_channels to improve filtering performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_channels_gin 
ON promotional_bounties USING GIN (promotional_channels);
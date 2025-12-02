-- Migration: Add reward_amount_distributed column to promotional_submissions
-- Description: Adds reward_amount_distributed column to track actual distributed rewards

-- Add reward_amount_distributed column to promotional_submissions table
ALTER TABLE promotional_submissions 
ADD COLUMN IF NOT EXISTS reward_amount_distributed NUMERIC(18, 8);

-- Update the promotional_bounties table to have proper default status (ACTIVE instead of DRAFT)
-- This addresses the issue of bounties being created with DRAFT status by default when they should be ACTIVE
-- ALTER TABLE promotional_bounties 
-- ALTER COLUMN status SET DEFAULT 'ACTIVE';

-- Add indexes for better query performance on the new columns
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_distributed 
ON promotional_submissions(reward_distributed);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_distributed_at 
ON promotional_submissions(reward_distributed_at);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reward_amount_distributed 
ON promotional_submissions(reward_amount_distributed);

-- Also add indexes that were suggested to improve performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status 
ON promotional_bounties(status);

CREATE INDEX IF NOT EXISTS idx_promotional_bounties_repo_id 
ON promotional_bounties(repo_id);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_id 
ON promotional_submissions(bounty_id);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_contributor_id 
ON promotional_submissions(contributor_id);

CREATE INDEX IF NOT EXISTS idx_promotional_submissions_status 
ON promotional_submissions(status);

-- Add GIN index for JSONB promotional_channels for better performance on array operations
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_channels_gin 
ON promotional_bounties USING GIN (promotional_channels);

-- Composite index for max submissions check to prevent race conditions
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status 
ON promotional_submissions(bounty_id, status);
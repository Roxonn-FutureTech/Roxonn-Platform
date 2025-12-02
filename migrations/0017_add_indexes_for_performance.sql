-- Migration: Add indexes for promotional bounties performance
-- Description: Adds performance indexes for commonly queried fields

-- Add indexes for promotional_bounties table
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status ON promotional_bounties(status);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_repo_id ON promotional_bounties(repo_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_creator_id ON promotional_bounties(creator_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_expires_at ON promotional_bounties(expires_at);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_created_at ON promotional_bounties(created_at);

-- Add indexes for promotional_submissions table
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_id ON promotional_submissions(bounty_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_contributor_id ON promotional_submissions(contributor_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_status ON promotional_submissions(status);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_created_at ON promotional_submissions(created_at);

-- Add composite index for max submissions check to prevent race conditions
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status ON promotional_submissions(bounty_id, status);

-- Add JSONB GIN index for promotional channels filtering (improves performance for JSONB queries)
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_channels_gin ON promotional_bounties USING GIN (promotional_channels);
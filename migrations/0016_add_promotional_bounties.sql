-- Migration: Add Promotional Bounties
-- Description: Creates tables for promotional bounties and submissions

-- Promotional bounties table
CREATE TABLE IF NOT EXISTS promotional_bounties (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES registered_repositories(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL DEFAULT 'PROMOTIONAL',
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  promotional_channels JSONB NOT NULL DEFAULT '[]',
  required_deliverable TEXT,
  reward_amount DECIMAL(18, 8) NOT NULL,
  reward_type VARCHAR(20) NOT NULL DEFAULT 'PER_SUBMISSION',
  max_submissions INTEGER,
  total_reward_pool DECIMAL(18, 8),
  campaign_id TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT check_type CHECK (type IN ('CODE', 'PROMOTIONAL')),
  CONSTRAINT check_status CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT check_reward_type CHECK (reward_type IN ('PER_SUBMISSION', 'POOL', 'TIERED'))
);

-- Indexes for promotional bounties
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_repo_id ON promotional_bounties(repo_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_creator_id ON promotional_bounties(creator_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_status ON promotional_bounties(status);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_type ON promotional_bounties(type);

-- Promotional submissions table
CREATE TABLE IF NOT EXISTS promotional_submissions (
  id SERIAL PRIMARY KEY,
  bounty_id INTEGER NOT NULL REFERENCES promotional_bounties(id) ON DELETE CASCADE,
  contributor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  proof_links JSONB NOT NULL DEFAULT '[]',
  description TEXT,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by INTEGER REFERENCES users(id),
  review_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT check_submission_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

-- Indexes for promotional submissions
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_id ON promotional_submissions(bounty_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_contributor_id ON promotional_submissions(contributor_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_status ON promotional_submissions(status);

-- Composite index for efficient max submissions check
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status ON promotional_submissions(bounty_id, status);

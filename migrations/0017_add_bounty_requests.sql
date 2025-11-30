-- Migration: Add Bounty Requests Table
-- Description: Creates table for tracking bounty requests from GitHub issue comments

-- Bounty requests table
CREATE TABLE IF NOT EXISTS bounty_requests (
  id SERIAL PRIMARY KEY,
  github_repo_id TEXT NOT NULL,
  github_issue_id TEXT NOT NULL,
  github_issue_number INTEGER NOT NULL,
  github_issue_url TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  suggested_amount TEXT,
  suggested_currency TEXT,
  status TEXT DEFAULT 'pending' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE,
  processed_by INTEGER REFERENCES users(id)
);

-- Indexes for bounty requests
CREATE INDEX IF NOT EXISTS idx_bounty_requests_github_repo_id ON bounty_requests(github_repo_id);
CREATE INDEX IF NOT EXISTS idx_bounty_requests_github_issue_id ON bounty_requests(github_issue_id);
CREATE INDEX IF NOT EXISTS idx_bounty_requests_requested_by ON bounty_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_bounty_requests_status ON bounty_requests(status);
CREATE INDEX IF NOT EXISTS idx_bounty_requests_created_at ON bounty_requests(created_at);

-- Composite index for efficient lookups by repo and issue
CREATE INDEX IF NOT EXISTS idx_bounty_requests_repo_issue ON bounty_requests(github_repo_id, github_issue_id);


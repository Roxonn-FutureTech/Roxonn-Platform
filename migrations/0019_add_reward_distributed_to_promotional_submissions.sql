-- Migration: Update promotional submissions with better indexing and constraints
-- Description: Adds indexes and constraints to improve performance and data integrity for promotional submissions

-- Add indexes for commonly queried fields
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_status ON promotional_submissions(status);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_id ON promotional_submissions(bounty_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_contributor_id ON promotional_submissions(contributor_id);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_created_at ON promotional_submissions(created_at);
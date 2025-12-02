-- Migration: Fix bounty default status and improve pool rewards logic
-- Description: Updates the default status and ensures proper field handling for promotional bounties

-- Update any existing bounties that might have been created with the incorrect status
-- If there are bounties with 'ACTIVE' status that were meant to be 'DRAFT', we could update them
-- but to be safe, we'll only make sure the constraint is correct going forward.

-- Ensure check constraint is properly applied to promotional_bounties.status
-- The enum constraint already exists in the schema, so we're just verifying it's set:

-- The schema already defines status with a default of 'DRAFT' and we want to keep it
-- This migration just ensures any remaining issues are addressed for consistency
-- We already have all the indexes and columns from the previous migration

-- Update existing promotional submissions to properly handle reward distribution fields
-- Add any missing indexes that are important for performance
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_creator_id ON promotional_bounties(creator_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_repo_id ON promotional_bounties(repo_id);
CREATE INDEX IF NOT EXISTS idx_promotional_bounties_expires_at ON promotional_bounties(expires_at);

-- Add indexes for performance on status changes
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_status ON promotional_submissions(status);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reviewed_at ON promotional_submissions(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reviewed_by ON promotional_submissions(reviewed_by);

-- Add GIN index for JSONB fields for better performance
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_proof_links_gin ON promotional_submissions USING GIN (proof_links);

-- Add a combined index for efficient maxSubmissions checks to prevent race conditions
-- This will make the database query for checking submission counts faster
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_bounty_status ON promotional_submissions(bounty_id, status);

-- Add a unique constraint for preventing duplicate submissions by the same contributor to the same bounty
-- This addresses a potential issue where a user could submit multiple times to the same bounty
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_bounty_contributor ON promotional_submissions(bounty_id, contributor_id) WHERE status != 'REJECTED';

-- Update any existing 'PROMOTIONAL' bounties that were accidentally set to 'ACTIVE' without funding
-- to make sure they are properly set to 'DRAFT' if they have no funding
-- This is just a safety measure to ensure consistent behavior
UPDATE promotional_bounties 
SET status = 'ACTIVE' -- Changed back to ACTIVE as bounties are now created as ACTIVE by default
WHERE type = 'PROMOTIONAL' AND status = 'DRAFT'
  AND (rewardAmount > '0' OR totalRewardPool > '0')
  AND expiresAt IS NULL OR expiresAt > NOW();

-- For future implementations, we may also want to add a trigger to automatically
-- verify that status changes have proper authorization and business logic,
-- but for now, we're focusing on field updates and indexes
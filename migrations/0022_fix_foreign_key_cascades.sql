-- Migration to add proper foreign key constraints with appropriate delete behavior
-- This addresses orphaned records when referenced users are deleted

-- Update bounty_requests.processed_by to handle user deletion properly
-- Using SET NULL instead of CASCADE since we want to preserve the bounty request record
-- but indicate it was processed by a now-deleted user
ALTER TABLE bounty_requests 
DROP CONSTRAINT IF EXISTS "bounty_requests_processed_by_users_id_fk",
ADD CONSTRAINT "bounty_requests_processed_by_users_id_fk" 
FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL;

-- Update promotional_submissions.reviewed_by to handle user deletion properly  
-- Using SET NULL since we want to preserve the submission record but mark that
-- it was reviewed by a now-deleted user
ALTER TABLE promotional_submissions 
DROP CONSTRAINT IF EXISTS "promotional_submissions_reviewed_by_users_id_fk",
ADD CONSTRAINT "promotional_submissions_reviewed_by_users_id_fk" 
FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;

-- Update users.referred_by to handle referrer deletion properly
-- Using SET NULL since we want to preserve the user account but mark that
-- they were referred by a now-deleted user
ALTER TABLE users 
DROP CONSTRAINT IF EXISTS "users_referred_by_users_id_fk",
ADD CONSTRAINT "users_referred_by_users_id_fk" 
FOREIGN KEY ("referred_by") REFERENCES "users"("id") ON DELETE SET NULL;

-- Add index to improve performance for queries involving these nullable foreign keys
-- This is helpful when filtering records by users who have been deleted (NULL values)
CREATE INDEX IF NOT EXISTS idx_bounty_requests_processed_by ON bounty_requests(processed_by);
CREATE INDEX IF NOT EXISTS idx_promotional_submissions_reviewed_by ON promotional_submissions(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
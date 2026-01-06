-- Add functional index for case-insensitive github username lookups
-- This improves performance for the LOWER(github_username) = LOWER($1) queries
CREATE INDEX IF NOT EXISTS idx_users_github_username_lower
ON users(LOWER(github_username));
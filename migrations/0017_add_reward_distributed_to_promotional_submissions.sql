-- Migration: Add reward_distributed columns to promotional_submissions
-- Description: Adds reward_distributed and reward_distributed_at columns to promotional_submissions table

-- Add reward_distributed column
ALTER TABLE promotional_submissions
ADD COLUMN IF NOT EXISTS reward_distributed BOOLEAN DEFAULT FALSE;

-- Add reward_distributed_at column  
ALTER TABLE promotional_submissions
ADD COLUMN IF NOT EXISTS reward_distributed_at TIMESTAMP WITH TIME ZONE;

-- Update existing records to have proper default values
UPDATE promotional_submissions
SET reward_distributed = FALSE
WHERE reward_distributed IS NULL;

-- Add comment to document the new columns
COMMENT ON COLUMN promotional_submissions.reward_distributed IS 'Indicates whether the reward for this submission has been distributed';
COMMENT ON COLUMN promotional_submissions.reward_distributed_at IS 'Timestamp when the reward was distributed';
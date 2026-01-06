-- Migration to add email_opt_out column with explicit transaction handling
-- PostgreSQL DDL statements are automatically wrapped in implicit transactions
-- but this ensures atomicity of the entire migration

-- Add email_opt_out column to users table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'users' AND column_name = 'email_opt_out') THEN
        ALTER TABLE users ADD COLUMN email_opt_out BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email_opt_out ON users(email_opt_out);
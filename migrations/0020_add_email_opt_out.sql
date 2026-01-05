-- Add email_opt_out column to users table
ALTER TABLE users ADD COLUMN email_opt_out BOOLEAN DEFAULT FALSE;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email_opt_out ON users(email_opt_out);
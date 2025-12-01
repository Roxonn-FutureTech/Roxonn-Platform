CREATE INDEX IF NOT EXISTS idx_prompt_transactions_user_id ON prompt_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_transactions_created_at ON prompt_transactions(created_at);
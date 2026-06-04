ALTER TABLE "promotional_bounties"
ADD COLUMN IF NOT EXISTS "reward_currency" text NOT NULL DEFAULT 'ROXN';

ALTER TABLE "promotional_bounties"
ADD CONSTRAINT "promotional_bounties_reward_currency_check"
CHECK ("reward_currency" IN ('XDC', 'ROXN', 'USDC'));

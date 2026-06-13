ALTER TABLE "promotional_bounties"
ADD COLUMN IF NOT EXISTS "reward_currency" text NOT NULL DEFAULT 'ROXN';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'promotional_bounties_reward_currency_check'
      AND conrelid = 'promotional_bounties'::regclass
  ) THEN
    ALTER TABLE "promotional_bounties"
    ADD CONSTRAINT "promotional_bounties_reward_currency_check"
    CHECK ("reward_currency" IN ('XDC', 'ROXN', 'USDC'));
  END IF;
END $$;

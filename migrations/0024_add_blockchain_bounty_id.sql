ALTER TABLE community_bounties ADD COLUMN IF NOT EXISTS blockchain_bounty_id INTEGER;
-- Add documentation
COMMENT ON COLUMN community_bounties.blockchain_bounty_id IS 'On-chain bounty ID from CommunityBountyEscrow.sol, used by relayer to complete payouts';
-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_community_bounties_blockchain_id ON community_bounties(blockchain_bounty_id) WHERE blockchain_bounty_id IS NOT NULL;
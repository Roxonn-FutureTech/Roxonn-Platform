// server/routes/__tests__/payoutMapper.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildPoolPayoutRow, buildCommunityPayoutRow } from '../../utils/payoutMapper';

// Mock storage — calculateBountyFees is pure/synchronous; mock keeps test DB-free
vi.mock('../../storage', () => ({
  storage: {
    calculateBountyFees: (base: number) => ({
      baseBountyAmount: base,
      clientFeeAmount: base * 0.025,
      contributorFeeAmount: base * 0.025,
      totalPlatformFee: base * 0.05,
      totalPaidByClient: base * 1.025,
      contributorPayout: base * 0.975,
    }),
  },
}));

const BASE_POOL_PARAMS = {
  repositoryGithubId: '123456789',
  issueNumber: 42,
  recipientGithubUsername: 'alice',
  recipientUserId: 7,
  recipientWalletAddress: 'xdc1abc',
  baseBountyAmount: 100,
  currency: 'XDC',
  txHash: '0xdeadbeef',
  blockNumber: 99999,
  poolManagerAddress: 'xdc1pm',
};

describe('buildPoolPayoutRow', () => {
  it('maps all keys to correct Drizzle column names', () => {
    const row = buildPoolPayoutRow(BASE_POOL_PARAMS);
    expect(row.recipientGithubUsername).toBe('alice');
    expect(row.recipientUserId).toBe(7);
    expect(row.recipientWalletAddress).toBe('xdc1abc');
    expect(row.txHash).toBe('0xdeadbeef');
    expect(row.payoutType).toBe('pool');
    expect(row.amount).toBe('97.5');       // 100 * 0.975
    expect(row.baseBountyAmount).toBe('100');
    expect(row.clientFeeAmount).toBe('2.5');
    expect(row.contributorFeeAmount).toBe('2.5');
    expect(row.totalPlatformFee).toBe('5');
    expect(row.poolManagerAddress).toBe('xdc1pm');
  });

  it('does NOT contain the old bogus keys', () => {
    const row = buildPoolPayoutRow(BASE_POOL_PARAMS) as any;
    expect(row).not.toHaveProperty('contributorGithubUsername');
    expect(row).not.toHaveProperty('contributorUserId');
    expect(row).not.toHaveProperty('contributorWalletAddress');
    expect(row).not.toHaveProperty('contributorPayout');
    expect(row).not.toHaveProperty('transactionHash');
    expect(row).not.toHaveProperty('poolManagerId');
    expect(row).not.toHaveProperty('status');
  });
});

describe('buildCommunityPayoutRow', () => {
  it('sets payoutType to community and poolManagerAddress to null', () => {
    const row = buildCommunityPayoutRow({
      repositoryGithubId: 'community-owner-repo',
      issueNumber: 42,
      recipientGithubUsername: 'alice',
      recipientUserId: 7,
      recipientWalletAddress: 'xdc1abc',
      baseBountyAmount: 100,
      currency: 'XDC',
      txHash: '0xdeadbeef',
      blockNumber: 99999,
      communityBountyId: 55,
    });
    expect(row.payoutType).toBe('community');
    expect(row.poolManagerAddress).toBeNull();
    expect(row.communityBountyId).toBe(55);
    expect(row.amount).toBe('97.5');       // 100 * 0.975
  });
});

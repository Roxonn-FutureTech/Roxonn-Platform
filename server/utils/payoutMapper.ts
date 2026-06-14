// server/utils/payoutMapper.ts
// Pure functions: map call-site params → NewPayout column objects.
// No DB, no side effects. Extracted per D-19 so unit tests can run without mocking DB.

import type { NewPayout } from '../../shared/schema';
import { storage } from '../storage';

export interface PoolPayoutParams {
  repositoryGithubId: string;
  issueNumber: number;
  recipientGithubUsername: string;
  recipientUserId: number | null;
  recipientWalletAddress: string;
  baseBountyAmount: number;
  currency: string;
  txHash: string;
  blockNumber: number | null;
  poolManagerAddress: string | null;
}

export function buildPoolPayoutRow(params: PoolPayoutParams): NewPayout {
  const fees = storage.calculateBountyFees(params.baseBountyAmount);
  return {
    repositoryGithubId: params.repositoryGithubId,
    issueNumber: params.issueNumber,
    recipientGithubUsername: params.recipientGithubUsername,
    recipientUserId: params.recipientUserId,
    recipientWalletAddress: params.recipientWalletAddress,
    amount: fees.contributorPayout.toString(),
    currency: params.currency,
    baseBountyAmount: fees.baseBountyAmount.toString(),
    clientFeeAmount: fees.clientFeeAmount.toString(),
    contributorFeeAmount: fees.contributorFeeAmount.toString(),
    totalPlatformFee: fees.totalPlatformFee.toString(),
    txHash: params.txHash,
    blockNumber: params.blockNumber,
    payoutType: 'pool',
    poolManagerAddress: params.poolManagerAddress,
  };
}

export interface CommunityPayoutParams {
  repositoryGithubId: string;   // synthesized: `community-<owner>-<name>`
  issueNumber: number;
  recipientGithubUsername: string;
  recipientUserId: number | null;
  recipientWalletAddress: string;
  baseBountyAmount: number;
  currency: string;
  txHash: string;
  blockNumber: number | null;
  communityBountyId: number | null;
}

export function buildCommunityPayoutRow(params: CommunityPayoutParams): NewPayout {
  const fees = storage.calculateBountyFees(params.baseBountyAmount);
  return {
    repositoryGithubId: params.repositoryGithubId,
    issueNumber: params.issueNumber,
    recipientGithubUsername: params.recipientGithubUsername,
    recipientUserId: params.recipientUserId,
    recipientWalletAddress: params.recipientWalletAddress,
    amount: fees.contributorPayout.toString(),
    currency: params.currency,
    baseBountyAmount: fees.baseBountyAmount.toString(),
    clientFeeAmount: fees.clientFeeAmount.toString(),
    contributorFeeAmount: fees.contributorFeeAmount.toString(),
    totalPlatformFee: fees.totalPlatformFee.toString(),
    txHash: params.txHash,
    blockNumber: params.blockNumber,
    payoutType: 'community',
    poolManagerAddress: null,
    communityBountyId: params.communityBountyId,
  };
}

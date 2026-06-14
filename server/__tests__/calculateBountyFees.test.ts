/**
 * server/__tests__/calculateBountyFees.test.ts
 *
 * Unit test for storage.calculateBountyFees (D-14, Phase 4).
 *
 * Locks the backend bounty-fee calculation to the ON-CHAIN escrow rate of 1%
 * total (platformFeeRate = 50 bps + contributorFeeRate = 50 bps = 0.5% + 0.5%),
 * replacing the previous hardcoded 5% (2.5% + 2.5%) mismatch (Phase-3 D-08).
 *
 * calculateBountyFees is a pure, synchronous method — no DB access — so this
 * test imports the storage singleton directly without TEST_DATABASE_URL, exactly
 * as the FUND-04 integration test does for its dynamic fee assertions.
 *
 * The expected numbers are derived from the config defaults (50 bps each), which
 * is the documented PLATFORM_FEE_RATE / CONTRIBUTOR_FEE_RATE default (CLAUDE.md).
 */

import { describe, it, expect } from 'vitest';
import { storage } from '../storage';
import { config } from '../config';

describe('storage.calculateBountyFees (D-14: on-chain-aligned 1%)', () => {
  it('charges 1% total (0.5% client + 0.5% contributor) for base 100', () => {
    const fees = storage.calculateBountyFees(100);

    expect(fees.baseBountyAmount).toBeCloseTo(100, 8);
    expect(fees.clientFeeAmount).toBeCloseTo(0.5, 8);
    expect(fees.contributorFeeAmount).toBeCloseTo(0.5, 8);
    expect(fees.totalPlatformFee).toBeCloseTo(1.0, 8);
    expect(fees.totalPaidByClient).toBeCloseTo(100.5, 8);
    expect(fees.contributorPayout).toBeCloseTo(99.5, 8);
  });

  it('does NOT use the stale 5% rate (regression guard for D-08/D-14)', () => {
    const fees = storage.calculateBountyFees(100);
    // 5% model would yield totalPlatformFee = 5 and contributorPayout = 97.5.
    expect(fees.totalPlatformFee).not.toBeCloseTo(5.0, 6);
    expect(fees.contributorPayout).not.toBeCloseTo(97.5, 6);
  });

  it('sources the rate from config (default 50 bps each), not a literal 0.025', () => {
    // With the config defaults this must equal config.platformFeeRate/10000 of base.
    const base = 200;
    const fees = storage.calculateBountyFees(base);
    expect(fees.clientFeeAmount).toBeCloseTo((base * config.platformFeeRate) / 10000, 8);
    expect(fees.contributorFeeAmount).toBeCloseTo((base * config.contributorFeeRate) / 10000, 8);
  });
});

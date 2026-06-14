// server/routes/__tests__/payoutWithRetry.test.ts
//
// Regression tests for recordPayoutWithRetry idempotency + double-pay detection (D-06 / TEST-01).
// Covers:
//   - tx_hash idempotency conflict → treated as success (no re-throw, no alert, no retry)
//   - possible double-pay conflict → sendLedgerFailureAlert fires, does NOT re-throw
//   - happy path → resolves cleanly after one recordPayout call
//   - transient-error retry → resolves after a failed first attempt and successful second
//   - retry exhaustion → sendLedgerFailureAlert fires, does NOT re-throw
//
// Pattern: blockchainRoutes.test.ts (vi.mock + beforeEach(vi.clearAllMocks()) model)
// DB-free: storage.recordPayout is spied/mocked — no real DB required.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { NewPayout } from '../../../shared/schema';

// ---------------------------------------------------------------------------
// Strategy: import the REAL recordPayoutWithRetry (not mocked), but mock its
// internal dependency: the `storage` singleton's `recordPayout` method.
//
// recordPayoutWithRetry(payoutData) calls storage.recordPayout(payoutData) at
// runtime. `storage` is imported at module level from '../../storage'.
// We use vi.mock with importActual to get the real exports (including
// recordPayoutWithRetry) while replacing the storage singleton's methods.
// ---------------------------------------------------------------------------

// Mock email FIRST so sendLedgerFailureAlert is a vi.fn() before any import
vi.mock('../../email', () => ({
  sendLedgerFailureAlert: vi.fn().mockResolvedValue(undefined),
  sendRefusedPayoutAlert: vi.fn().mockResolvedValue(undefined),
  sendGasAlertEmail: vi.fn().mockResolvedValue(undefined),
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendPayoutRequestNotification: vi.fn().mockResolvedValue(undefined),
}));

// Import the REAL functions; spy on storage.recordPayout after import
import { recordPayoutWithRetry, storage } from '../../storage';
import { sendLedgerFailureAlert } from '../../email';

// ---------------------------------------------------------------------------
// Synthetic NewPayout fixture — no real tx hash / wallet / key literals
// ---------------------------------------------------------------------------
const SYNTHETIC_PAYOUT: NewPayout = {
  repositoryGithubId: 'test-owner/test-repo',
  issueNumber: 5,
  recipientGithubUsername: 'alice-test',
  recipientWalletAddress: 'xdc0test000000000000000000000000000000000001',
  amount: '97.5',
  currency: 'XDC',
  baseBountyAmount: '100',
  clientFeeAmount: '2.5',
  contributorFeeAmount: '2.5',
  totalPlatformFee: '5',
  txHash: '0xtest000000000000000000000000000000000000000000000000000000000001',
  payoutType: 'pool',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('recordPayoutWithRetry', () => {
  let recordPayoutSpy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    // Spy on the real storage.recordPayout so we control what it does
    recordPayoutSpy = vi.spyOn(storage, 'recordPayout') as unknown as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- (a) IDEMPOTENCY SUCCESS ----

  it('(a) resolves without throwing when recordPayout throws tx_hash idempotency (no retry, no alert)', async () => {
    recordPayoutSpy.mockRejectedValue(
      new Error('Payout already recorded (tx_hash idempotency)')
    );

    // Must not throw
    await expect(recordPayoutWithRetry(SYNTHETIC_PAYOUT)).resolves.toBeUndefined();

    // Called exactly once — no retry for idempotency
    expect(recordPayoutSpy).toHaveBeenCalledTimes(1);

    // No alert should fire for a benign idempotency hit
    expect(sendLedgerFailureAlert).not.toHaveBeenCalled();
  });

  // ---- (b) POSSIBLE DOUBLE-PAY ----

  it('(b) resolves without re-throwing and fires sendLedgerFailureAlert on possible double-pay conflict', async () => {
    recordPayoutSpy.mockRejectedValue(
      new Error('Payout conflict: repo/issue already recorded under a different tx (possible double-pay)')
    );

    // Must not throw
    await expect(recordPayoutWithRetry(SYNTHETIC_PAYOUT)).resolves.toBeUndefined();

    // recordPayout called once (double-pay is not retried)
    expect(recordPayoutSpy).toHaveBeenCalledTimes(1);

    // Alert must fire exactly once with the payout's tx/repo/issue
    expect(sendLedgerFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendLedgerFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: SYNTHETIC_PAYOUT.txHash,
        repoId: SYNTHETIC_PAYOUT.repositoryGithubId,
        issueNumber: SYNTHETIC_PAYOUT.issueNumber,
      })
    );
  });

  // ---- (c) HAPPY PATH ----

  it('(c) resolves cleanly when recordPayout succeeds on first attempt', async () => {
    recordPayoutSpy.mockResolvedValue({
      ...SYNTHETIC_PAYOUT,
      id: 1,
      paidAt: new Date(),
    });

    await expect(recordPayoutWithRetry(SYNTHETIC_PAYOUT)).resolves.toBeUndefined();

    // Called exactly once — no retry needed
    expect(recordPayoutSpy).toHaveBeenCalledTimes(1);
    expect(sendLedgerFailureAlert).not.toHaveBeenCalled();
  });

  // ---- (d) TRANSIENT ERROR + RETRY SUCCESS (nice-to-have) ----

  it('(d) retries on transient error and resolves when second attempt succeeds', async () => {
    // First call throws a generic transient error; second call resolves
    recordPayoutSpy
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce({
        ...SYNTHETIC_PAYOUT,
        id: 2,
        paidAt: new Date(),
      });

    await expect(recordPayoutWithRetry(SYNTHETIC_PAYOUT)).resolves.toBeUndefined();

    // Should have retried once (2 total calls)
    expect(recordPayoutSpy).toHaveBeenCalledTimes(2);
    expect(sendLedgerFailureAlert).not.toHaveBeenCalled();
  });

  // ---- (e) RETRY EXHAUSTION → alert fires, does NOT re-throw ----

  it('(e) fires sendLedgerFailureAlert after all retries exhausted and does not re-throw', async () => {
    const transientErr = new Error('ECONNRESET: DB temporarily unavailable');
    recordPayoutSpy.mockRejectedValue(transientErr);

    // maxAttempts=3 means 3 total attempts
    await expect(recordPayoutWithRetry(SYNTHETIC_PAYOUT, 3)).resolves.toBeUndefined();

    expect(recordPayoutSpy).toHaveBeenCalledTimes(3);
    expect(sendLedgerFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendLedgerFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: SYNTHETIC_PAYOUT.txHash,
        repoId: SYNTHETIC_PAYOUT.repositoryGithubId,
        issueNumber: SYNTHETIC_PAYOUT.issueNumber,
      })
    );
  });
});

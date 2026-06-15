/**
 * Unit tests for autoRegistration.ts — FUND-02 atomic key promotion, idempotency,
 * flag gate, and T-05-04 crash-resume recovery.
 *
 * Pure-mock: no TEST_DATABASE_URL required. Covers:
 *   1. New user + pending row: user INSERT carries the ciphertext, pending row DELETEd, same tx
 *   2. Idempotent no-op: no pending row → INSERT with null key, no DELETE, no throw
 *   3. Flag OFF: AUTO_REGISTRATION_ENABLED false → early return, no wallet creation
 *   4. T-05-04 recovery: existing user WITH wallet but NULL key + staged pending row → resume promotion
 *   5. Existing user, no wallet (fall-through): UPDATE carries the ciphertext atomically + DELETE
 *
 * T-05-04: the user-row write and key promotion run in ONE transaction, so a crash
 * can never leave a committed user row with a NULL encrypted key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFeatureFlags, mockTxSelectResult, callOrder } = vi.hoisted(() => {
  const mockTxSelectResult: any[] = [];
  const callOrder: string[] = [];
  const mockFeatureFlags = {
    AUTO_REGISTRATION_ENABLED: true,
    AUTO_CLAIM_ENABLED: false,
    GAS_MONITORING_ENABLED: false,
    RATE_LIMIT_RETRY_ENABLED: false,
    COMMUNITY_RELAYER_ENABLED: false,
  };
  return { mockFeatureFlags, mockTxSelectResult, callOrder };
});

// --- Mock stubs for the db.transaction tx object ---
const mockTxInsertReturning = vi.fn().mockResolvedValue([{ id: 42 }]);
const mockTxInsertValues = vi.fn().mockReturnValue({ returning: mockTxInsertReturning });
const mockTxInsertFn = vi.fn().mockReturnValue({ values: mockTxInsertValues });

const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUpdateSet = vi.fn().mockReturnValue({ where: mockTxUpdateWhere });
const mockTxUpdateFn = vi.fn().mockReturnValue({ set: mockTxUpdateSet });

const mockTxDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockTxDeleteFn = vi.fn().mockReturnValue({ where: mockTxDeleteWhere });

const mockTxSelectWhereLimit = vi.fn().mockImplementation(() => Promise.resolve(mockTxSelectResult));
const mockTxSelectWhere = vi.fn().mockReturnValue({ limit: mockTxSelectWhereLimit });
const mockTxSelectFrom = vi.fn().mockReturnValue({ where: mockTxSelectWhere });
const mockTxSelectFn = vi.fn().mockReturnValue({ from: mockTxSelectFrom });

const mockTx = {
  select: mockTxSelectFn,
  insert: (table: any) => {
    callOrder.push('insert');
    return mockTxInsertFn(table);
  },
  update: (table: any) => {
    callOrder.push('update');
    return mockTxUpdateFn(table);
  },
  delete: (table: any) => {
    callOrder.push('delete');
    return mockTxDeleteFn(table);
  },
};

// --- Mock stubs for the outer db calls (Step 1 select) ---
const mockDbSelectLimit = vi.fn().mockResolvedValue([]);
const mockDbSelectWhere = vi.fn().mockReturnValue({ limit: mockDbSelectLimit });
const mockDbSelectFrom = vi.fn().mockReturnValue({ where: mockDbSelectWhere });
const mockDbSelectFn = vi.fn().mockReturnValue({ from: mockDbSelectFrom });

// --- Module mocks ---
vi.mock('../../db', () => ({
  db: {
    select: (...args: any[]) => mockDbSelectFn(...args),
    transaction: vi.fn().mockImplementation(async (callback: (tx: any) => Promise<any>) => {
      return callback(mockTx);
    }),
  },
}));

vi.mock('../../tatum', () => ({
  generateWallet: vi.fn().mockResolvedValue({
    address: '0xWALLET_ADDRESS',
    referenceId: 'REF_123',
  }),
}));

vi.mock('../../blockchain', () => ({
  blockchain: {
    registerUser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils', () => ({
  log: vi.fn(),
}));

vi.mock('../../config', () => ({
  get FEATURE_FLAGS() {
    return mockFeatureFlags;
  },
}));

// Imports must come after vi.mock declarations
import { autoRegisterContributor } from '../autoRegistration';
import { db } from '../../db';
import { generateWallet } from '../../tatum';

const PENDING_ROW = {
  id: 1,
  referenceId: 'REF_123',
  encryptedPrivateKey: 'CIPHERTEXT_PK',
  encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
  createdAt: new Date(),
  expiresAt: new Date(),
};

describe('autoRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    callOrder.length = 0;
    mockTxSelectResult.length = 0;
    mockFeatureFlags.AUTO_REGISTRATION_ENABLED = true;

    mockTxSelectWhereLimit.mockImplementation(() => Promise.resolve(mockTxSelectResult));
    mockTxSelectWhere.mockReturnValue({ limit: mockTxSelectWhereLimit });
    mockTxSelectFrom.mockReturnValue({ where: mockTxSelectWhere });
    mockTxSelectFn.mockReturnValue({ from: mockTxSelectFrom });

    mockTxInsertReturning.mockResolvedValue([{ id: 42 }]);
    mockTxInsertValues.mockReturnValue({ returning: mockTxInsertReturning });
    mockTxInsertFn.mockReturnValue({ values: mockTxInsertValues });

    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockTxUpdateSet.mockReturnValue({ where: mockTxUpdateWhere });
    mockTxUpdateFn.mockReturnValue({ set: mockTxUpdateSet });

    mockTxDeleteWhere.mockResolvedValue(undefined);
    mockTxDeleteFn.mockReturnValue({ where: mockTxDeleteWhere });

    mockTx.insert = (table: any) => { callOrder.push('insert'); return mockTxInsertFn(table); };
    mockTx.update = (table: any) => { callOrder.push('update'); return mockTxUpdateFn(table); };
    mockTx.delete = (table: any) => { callOrder.push('delete'); return mockTxDeleteFn(table); };

    mockDbSelectLimit.mockResolvedValue([]);
    mockDbSelectWhere.mockReturnValue({ limit: mockDbSelectLimit });
    mockDbSelectFrom.mockReturnValue({ where: mockDbSelectWhere });
    mockDbSelectFn.mockReturnValue({ from: mockDbSelectFrom });

    (db.transaction as any).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
      return callback(mockTx);
    });

    (generateWallet as any).mockResolvedValue({
      address: '0xWALLET_ADDRESS',
      referenceId: 'REF_123',
    });
  });

  describe('Test 1: new user + pending row — INSERT carries ciphertext, then DELETE (one tx)', () => {
    it('should INSERT the user with the ciphertext and DELETE the pending row in the same transaction', async () => {
      mockTxSelectResult.push(PENDING_ROW);

      const result = await autoRegisterContributor('testuser', '12345');

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(db.transaction).toHaveBeenCalledOnce();

      // The user INSERT (inside the tx) carries the ciphertext — not a separate UPDATE.
      expect(mockTxInsertFn).toHaveBeenCalledOnce();
      const insertValues = mockTxInsertValues.mock.calls[0][0];
      expect(insertValues).toMatchObject({
        encryptedPrivateKey: 'CIPHERTEXT_PK',
        encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
        xdcWalletAddress: '0xWALLET_ADDRESS',
        walletReferenceId: 'REF_123',
      });

      // Pending row deleted AFTER the user row is written, same tx.
      expect(mockTxDeleteFn).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(['insert', 'delete']);
    });
  });

  describe('Test 2: idempotent no-op — no pending row', () => {
    it('should INSERT with null key and NOT DELETE when pending SELECT is empty', async () => {
      const result = await autoRegisterContributor('testuser', '12345');

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(db.transaction).toHaveBeenCalledOnce();

      expect(mockTxInsertFn).toHaveBeenCalledOnce();
      const insertValues = mockTxInsertValues.mock.calls[0][0];
      expect(insertValues.encryptedPrivateKey).toBeNull();
      expect(insertValues.encryptedMnemonic).toBeNull();

      // No pending row → no DELETE.
      expect(mockTxDeleteFn).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['insert']);
    });
  });

  describe('Test 3: flag OFF — AUTO_REGISTRATION_ENABLED false', () => {
    it('should return {success:false, action:"failed"} and never call generateWallet or db', async () => {
      mockFeatureFlags.AUTO_REGISTRATION_ENABLED = false;

      const result = await autoRegisterContributor('testuser', '12345');

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(generateWallet).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockDbSelectFn).not.toHaveBeenCalled();
    });
  });

  describe('Test 4: T-05-04 recovery — existing user with wallet but NULL key', () => {
    it('should resume promotion from the staged pending row and NOT create a new wallet', async () => {
      // Existing user already has a wallet address but a NULL encrypted key (pre-fix crash),
      // with the ciphertext still staged under their walletReferenceId.
      mockDbSelectLimit.mockResolvedValue([{
        id: 7,
        xdcWalletAddress: '0xEXISTING',
        encryptedPrivateKey: null,
        walletReferenceId: 'REF_123',
      }]);
      mockTxSelectResult.push(PENDING_ROW);

      const result = await autoRegisterContributor('testuser', '12345');

      // Returns existing — no new wallet minted.
      expect(result.success).toBe(true);
      expect(result.action).toBe('existing');
      expect(generateWallet).not.toHaveBeenCalled();

      // Recovery transaction promoted the staged key then deleted the pending row.
      expect(db.transaction).toHaveBeenCalledOnce();
      const setArgs = mockTxUpdateSet.mock.calls[0][0];
      expect(setArgs).toMatchObject({
        encryptedPrivateKey: 'CIPHERTEXT_PK',
        encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
      });
      expect(callOrder).toEqual(['update', 'delete']);
    });
  });

  describe('Test 5: existing user, no wallet — UPDATE carries ciphertext atomically + DELETE', () => {
    it('should UPDATE the existing user row with the ciphertext and DELETE the pending row in one tx', async () => {
      mockDbSelectLimit.mockResolvedValue([{
        id: 9,
        xdcWalletAddress: null,
        encryptedPrivateKey: null,
        walletReferenceId: null,
      }]);
      mockTxSelectResult.push(PENDING_ROW);

      const result = await autoRegisterContributor('testuser', '12345');

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(generateWallet).toHaveBeenCalledOnce();

      // Update (not insert) for an existing user, carrying the ciphertext, then delete.
      expect(mockTxUpdateFn).toHaveBeenCalledOnce();
      const setArgs = mockTxUpdateSet.mock.calls[0][0];
      expect(setArgs).toMatchObject({
        xdcWalletAddress: '0xWALLET_ADDRESS',
        encryptedPrivateKey: 'CIPHERTEXT_PK',
        encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
      });
      expect(mockTxInsertFn).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['update', 'delete']);
    });
  });
});

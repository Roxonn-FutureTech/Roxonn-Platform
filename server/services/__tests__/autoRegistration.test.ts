/**
 * Unit tests for autoRegistration.ts — FUND-02 key promotion, idempotency, flag gate
 *
 * Pure-mock: no TEST_DATABASE_URL required. Covers:
 *   1. Promotion happy path: UPDATE(encryptedPrivateKey/encryptedMnemonic) then DELETE pending row
 *   2. Idempotent no-op: pending SELECT empty → no UPDATE, no DELETE, no throw
 *   3. Flag OFF: AUTO_REGISTRATION_ENABLED false → early return, no wallet creation
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted: declare variables that need to be available inside vi.mock factories
// (vi.mock calls are hoisted before the rest of the file, so normal let/const are
// not yet initialized when the factory runs)
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
  update: (table: any) => {
    callOrder.push('update');
    return mockTxUpdateFn(table);
  },
  delete: (table: any) => {
    callOrder.push('delete');
    return mockTxDeleteFn(table);
  },
};

// --- Mock stubs for the outer db calls (Steps 1 and 4) ---
const mockDbSelectLimit = vi.fn().mockResolvedValue([]);
const mockDbSelectWhere = vi.fn().mockReturnValue({ limit: mockDbSelectLimit });
const mockDbSelectFrom = vi.fn().mockReturnValue({ where: mockDbSelectWhere });
const mockDbSelectFn = vi.fn().mockReturnValue({ from: mockDbSelectFrom });

const mockDbInsertReturning = vi.fn().mockResolvedValue([{ id: 42 }]);
const mockDbInsertValues = vi.fn().mockReturnValue({ returning: mockDbInsertReturning });
const mockDbInsertFn = vi.fn().mockReturnValue({ values: mockDbInsertValues });

const mockDbUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockDbUpdateSet = vi.fn().mockReturnValue({ where: mockDbUpdateWhere });
const mockDbUpdateFn = vi.fn().mockReturnValue({ set: mockDbUpdateSet });

// --- Module mocks ---
// All paths are resolved from this test file's location: server/services/__tests__/

vi.mock('../../db', () => ({
  db: {
    select: (...args: any[]) => mockDbSelectFn(...args),
    insert: (...args: any[]) => mockDbInsertFn(...args),
    update: (...args: any[]) => mockDbUpdateFn(...args),
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

vi.mock('../../aws', () => ({
  storeWalletSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils', () => ({
  log: vi.fn(),
}));

vi.mock('../../config', () => ({
  // Return the hoisted object — mutations in beforeEach are visible here
  get FEATURE_FLAGS() {
    return mockFeatureFlags;
  },
}));

// Imports must come after vi.mock declarations
import { autoRegisterContributor } from '../autoRegistration';
import { db } from '../../db';
import { generateWallet } from '../../tatum';

describe('autoRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset shared mutable state
    callOrder.length = 0;
    mockTxSelectResult.length = 0;
    mockFeatureFlags.AUTO_REGISTRATION_ENABLED = true;

    // Re-wire stubs after clearAllMocks clears their implementations
    mockTxSelectWhereLimit.mockImplementation(() => Promise.resolve(mockTxSelectResult));
    mockTxSelectWhere.mockReturnValue({ limit: mockTxSelectWhereLimit });
    mockTxSelectFrom.mockReturnValue({ where: mockTxSelectWhere });
    mockTxSelectFn.mockReturnValue({ from: mockTxSelectFrom });

    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockTxUpdateSet.mockReturnValue({ where: mockTxUpdateWhere });
    mockTxUpdateFn.mockReturnValue({ set: mockTxUpdateSet });

    mockTxDeleteWhere.mockResolvedValue(undefined);
    mockTxDeleteFn.mockReturnValue({ where: mockTxDeleteWhere });

    // Re-assign tx handlers (they are closures over callOrder)
    mockTx.update = (table: any) => {
      callOrder.push('update');
      return mockTxUpdateFn(table);
    };
    mockTx.delete = (table: any) => {
      callOrder.push('delete');
      return mockTxDeleteFn(table);
    };

    // Outer db stubs
    mockDbSelectLimit.mockResolvedValue([]);
    mockDbSelectWhere.mockReturnValue({ limit: mockDbSelectLimit });
    mockDbSelectFrom.mockReturnValue({ where: mockDbSelectWhere });
    mockDbSelectFn.mockReturnValue({ from: mockDbSelectFrom });

    mockDbInsertReturning.mockResolvedValue([{ id: 42 }]);
    mockDbInsertValues.mockReturnValue({ returning: mockDbInsertReturning });
    mockDbInsertFn.mockReturnValue({ values: mockDbInsertValues });

    (db.transaction as any).mockImplementation(async (callback: (tx: any) => Promise<any>) => {
      return callback(mockTx);
    });

    (generateWallet as any).mockResolvedValue({
      address: '0xWALLET_ADDRESS',
      referenceId: 'REF_123',
    });
  });

  describe('Test 1: promotion happy path — pending row present', () => {
    it('should UPDATE users with ciphertext then DELETE pending row (UPDATE before DELETE)', async () => {
      // Arrange: pending row with sentinel ciphertext values
      const pendingRow = {
        id: 1,
        referenceId: 'REF_123',
        encryptedPrivateKey: 'CIPHERTEXT_PK',
        encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
        createdAt: new Date(),
        expiresAt: new Date(),
      };
      mockTxSelectResult.push(pendingRow);

      // Act
      const result = await autoRegisterContributor('testuser', '12345');

      // Assert: overall result is success
      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      // Assert: transaction was invoked
      expect(db.transaction).toHaveBeenCalledOnce();

      // Assert: UPDATE was called with ciphertext from the pending row
      expect(mockTxUpdateFn).toHaveBeenCalledOnce();
      expect(mockTxUpdateSet).toHaveBeenCalledOnce();
      const setArgs = mockTxUpdateSet.mock.calls[0][0];
      expect(setArgs).toMatchObject({
        encryptedPrivateKey: 'CIPHERTEXT_PK',
        encryptedMnemonic: 'CIPHERTEXT_MNEMONIC',
      });

      // Assert: DELETE was called
      expect(mockTxDeleteFn).toHaveBeenCalledOnce();

      // Assert: UPDATE happened BEFORE DELETE (order enforced)
      expect(callOrder).toEqual(['update', 'delete']);
    });
  });

  describe('Test 2: idempotent no-op — no pending row', () => {
    it('should not call UPDATE or DELETE and not throw when pending SELECT is empty', async () => {
      // Arrange: pending SELECT returns empty (mockTxSelectResult is empty by default)

      // Act
      const result = await autoRegisterContributor('testuser', '12345');

      // Assert: overall result is success (idempotent no-op does not fail)
      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      // Assert: transaction still ran
      expect(db.transaction).toHaveBeenCalledOnce();

      // Assert: NO UPDATE or DELETE calls
      expect(mockTxUpdateFn).not.toHaveBeenCalled();
      expect(mockTxDeleteFn).not.toHaveBeenCalled();
      expect(callOrder).toHaveLength(0);
    });
  });

  describe('Test 3: flag OFF — AUTO_REGISTRATION_ENABLED false', () => {
    it('should return {success:false, action:"failed"} and never call generateWallet or db', async () => {
      // Arrange: flag OFF
      mockFeatureFlags.AUTO_REGISTRATION_ENABLED = false;

      // Act
      const result = await autoRegisterContributor('testuser', '12345');

      // Assert: clean early-return shape
      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');

      // Assert: generateWallet was never invoked
      expect(generateWallet).not.toHaveBeenCalled();

      // Assert: zero db calls
      expect(db.transaction).not.toHaveBeenCalled();
      expect(mockDbSelectFn).not.toHaveBeenCalled();
      expect(mockDbInsertFn).not.toHaveBeenCalled();
      expect(mockDbUpdateFn).not.toHaveBeenCalled();
    });
  });
});

/**
 * Regression test for INFLIGHT-02 / D-04 / D-10 #1:
 * gasMonitor lazy factory must not throw when PRIVATE_KEY is empty.
 *
 * The pre-fix eager `export const gasMonitor = new GasMonitor(...)` at
 * module-evaluation time would throw `invalid private key` (ethers 6.13.5)
 * the moment the module was imported with an empty relayerPrivateKey.
 *
 * Security note (T-05-02): this test forces relayerPrivateKey to '' via a
 * vi.mock — it never logs or prints key material.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config BEFORE importing the module under test so that module evaluation
// sees relayerPrivateKey: '' and cannot throw from a remaining eager export.
vi.mock('../../config', () => ({
  config: {
    xdcRpcUrl: 'http://localhost:8545',
    relayerPrivateKey: '',
  },
}));

// We also need to mock the log utility to avoid side-effects from initialization.
vi.mock('../../utils', () => ({
  log: vi.fn(),
}));

// Lazy-import inside tests so the vi.mock hoisting applies before the module loads.
const importGasMonitor = () => import('../gasMonitor');

describe('gasMonitor lazy factory (INFLIGHT-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module registry so each test gets a fresh _gasMonitor = null.
    vi.resetModules();
  });

  it('Test 1 (no-throw on empty key): getGasMonitor() and startMonitoring() do not throw when relayerPrivateKey is empty', async () => {
    const { getGasMonitor } = await importGasMonitor();
    // CR-01 regression: pre-fix, getGasMonitor() constructed `new ethers.Wallet('')`
    // which throws synchronously; under the default-ON GAS_MONITORING flag this
    // reached startServer()'s catch → process.exit(1). The constructor now degrades
    // to an inert monitor instead of throwing. This test actually CALLS the factory
    // (the prior version only checked `typeof` and never exercised the crash path).
    let monitor: ReturnType<typeof getGasMonitor> | undefined;
    expect(() => { monitor = getGasMonitor(); }).not.toThrow();
    expect(monitor).toBeDefined();
    // startMonitoring() must be a safe no-op when no valid key is configured
    // (no interval scheduled, no throw) so boot cannot crash.
    expect(() => monitor!.startMonitoring()).not.toThrow();
  });

  it('Test 2 (caching): two calls to getGasMonitor() return the same instance', async () => {
    const { getGasMonitor } = await importGasMonitor();
    // getGasMonitor() with empty key will throw (ethers validates synchronously).
    // Wrap in try/catch: the point is that construction is attempted exactly
    // once — the second call, IF it got past the first, would return the cached
    // instance.  We verify the caching property by checking _gasMonitor identity.
    //
    // Since ethers throws on empty key, we swap the mock for this test to use
    // a valid-format (but throwaway) key so construction succeeds.
    vi.doMock('../../config', () => ({
      config: {
        xdcRpcUrl: 'http://localhost:8545',
        // Valid 32-byte private key (not a real key — all zeros for test only)
        relayerPrivateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
    }));
    vi.resetModules();

    const { getGasMonitor: getGasMonitorFresh } = await importGasMonitor();
    const instance1 = getGasMonitorFresh();
    const instance2 = getGasMonitorFresh();
    expect(instance1).toBe(instance2);
  });

  it('Test 3 (peek before construct): peekGasMonitor() returns null before any getGasMonitor() call', async () => {
    const { peekGasMonitor } = await importGasMonitor();
    // No getGasMonitor() call has been made in this fresh module instance.
    expect(peekGasMonitor()).toBeNull();
  });

  it('Test 4 (no key leak on malformed key): getGasMonitor() with a malformed key does not throw and never logs the key (T-05-18)', async () => {
    // A malformed (non-empty) key makes ethers v6 throw an error whose message
    // echoes the raw input verbatim. The constructor catch must log a static,
    // key-free line — never the ethers message — or the raw key leaks to logs.
    const MALFORMED = '0xnot-a-valid-key-deadbeef-SECRETLEAK';
    vi.doMock('../../config', () => ({
      config: { xdcRpcUrl: 'http://localhost:8545', relayerPrivateKey: MALFORMED },
    }));
    vi.resetModules();
    const utils = await import('../../utils');
    const logMock = utils.log as unknown as ReturnType<typeof vi.fn>;
    const { getGasMonitor } = await importGasMonitor();
    expect(() => getGasMonitor()).not.toThrow();
    const allLogged = logMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogged).not.toContain('SECRETLEAK');
    expect(allLogged).not.toContain(MALFORMED);
  });
});

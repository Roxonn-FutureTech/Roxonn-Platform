/*
 * ============================================================================
 * STORAGE-SAFETY HARD GATE — DualCurrencyRepoRewards (D-02 / RC-5, FIX 4)
 * ============================================================================
 *
 * THE NON-NEGOTIABLE: this gate compares the EDITED NEW factory against a
 * CONCRETE, MATERIALIZED, FROZEN ...V1 baseline (git-extracted from the pinned
 * pre-Phase-4 commit 8eefff8, top-level contract renamed ...V1) — NOT a
 * forceImport of the edited source. A forceImport on the edited source records
 * the NEW layout as the manifest baseline, making validateUpgrade a new-vs-new
 * self-compare that ALWAYS passes (Risk #5). The two-factory form below cannot
 * self-pass.
 *
 * This script exits 0 ONLY when ALL THREE hold:
 *   1. POSITIVE: validateUpgrade(V1, NEW) passes               -> SENTINEL_BASELINE_PASS
 *   2. INTEGRITY: the V1 and NEW storage layouts DIFFER on the known
 *      plan-mandated delta (V1 has 'repositoryUSDCPools', NEW has
 *      '__deprecated_repositoryUSDCPools'); if byte-identical -> BASELINE POISONED, exit 1
 *   3. NEGATIVE CONTROL: validateUpgrade(V1, _BROKEN) THROWS   -> SENTINEL_NEGCONTROL_REJECTED
 *
 * NO gate-defeating storage flags (skip-storage-check / custom-types /
 * allow-renames) are used — the @custom:oz-renamed-from annotation handles the
 * legitimate rename.
 */

"use strict";

const hre = require("hardhat");
const { ethers, upgrades } = hre;
require("dotenv").config({ path: "./server/.env" });

// DualCurrency: ReentrancyGuard init is deferred to initializeV2 (pre-existing in
// the LIVE contract, not introduced by Phase 4) -> missing-initializer-call allowed.
const UNSAFE_ALLOW = ["missing-initializer-call"];

const V1_NAME = "DualCurrencyRepoRewardsV1";
const NEW_NAME = "DualCurrencyRepoRewards";
const BROKEN_NAME = "DualCurrencyRepoRewards_BROKEN";

// Plan-mandated known delta proving old != new:
//   V1 has 'repositoryUSDCPools'; NEW renamed it to '__deprecated_repositoryUSDCPools'.
const V1_ONLY_MEMBER = "repositoryUSDCPools";
const NEW_ONLY_MEMBER = "__deprecated_repositoryUSDCPools";

/**
 * Read the solc storageLayout member label list for a given contract name by
 * scanning ALL build-info files (a contract may live in any of them).
 * Returns an array of top-level storage variable labels.
 */
function readStorageMembers(contractName) {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "contracts", "artifacts", "build-info");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const bi = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const contracts = (bi.output && bi.output.contracts) || {};
    for (const src of Object.keys(contracts)) {
      const c = contracts[src][contractName];
      if (c && c.storageLayout && Array.isArray(c.storageLayout.storage)) {
        return c.storageLayout.storage.map((s) => s.label);
      }
    }
  }
  return null;
}

async function main() {
  console.log("================================================================");
  console.log(" DualCurrencyRepoRewards — storage-safety HARD GATE (two-factory)");
  console.log("================================================================");

  // Literal factory names (two-factory form): V1 baseline vs the EDITED new source.
  const V1 = await ethers.getContractFactory('DualCurrencyRepoRewardsV1');
  const NEW = await ethers.getContractFactory('DualCurrencyRepoRewards');
  const BROKEN = await ethers.getContractFactory('DualCurrencyRepoRewards_BROKEN');

  // ----------------------------------------------------------------------
  // (1) POSITIVE: NEW must be a storage-safe upgrade of the FROZEN ...V1.
  // ----------------------------------------------------------------------
  console.log(`\n[1/3] validateUpgrade(${V1_NAME} -> ${NEW_NAME}) ...`);
  await upgrades.validateUpgrade(V1, NEW, { kind: "uups", unsafeAllow: UNSAFE_ALLOW });
  console.log("      OK — NEW is storage-compatible with the frozen V1 baseline.");
  console.log("SENTINEL_BASELINE_PASS");

  // ----------------------------------------------------------------------
  // (2) BASELINE-INTEGRITY ASSERT: prove old != new on the known delta.
  //     If byte-identical, the baseline is poisoned (e.g. someone seeded the
  //     edited source as V1) -> the positive pass is meaningless.
  // ----------------------------------------------------------------------
  console.log("\n[2/3] baseline-integrity assert (old != new) ...");
  const v1Members = readStorageMembers(V1_NAME);
  const newMembers = readStorageMembers(NEW_NAME);
  if (!v1Members || !newMembers) {
    console.error("BASELINE POISONED — could not read storage layout for V1 or NEW");
    process.exit(1);
  }
  const v1HasOld = v1Members.includes(V1_ONLY_MEMBER);
  const v1HasNew = v1Members.includes(NEW_ONLY_MEMBER);
  const newHasOld = newMembers.includes(V1_ONLY_MEMBER);
  const newHasNew = newMembers.includes(NEW_ONLY_MEMBER);
  console.log(`      V1  has '${V1_ONLY_MEMBER}': ${v1HasOld}  '${NEW_ONLY_MEMBER}': ${v1HasNew}`);
  console.log(`      NEW has '${V1_ONLY_MEMBER}': ${newHasOld}  '${NEW_ONLY_MEMBER}': ${newHasNew}`);
  const layoutsIdentical = JSON.stringify(v1Members) === JSON.stringify(newMembers);
  if (layoutsIdentical || !(v1HasOld && !v1HasNew && newHasNew && !newHasOld)) {
    console.error("BASELINE POISONED — old==new (the V1 baseline is not the pre-Phase-4 source)");
    process.exit(1);
  }
  console.log("      OK — V1 and NEW differ on the plan-mandated delta (baseline is genuine).");

  // ----------------------------------------------------------------------
  // (3) EXECUTED NEGATIVE CONTROL: a deliberately broken layout MUST throw.
  //     _BROKEN injects `uint256 _injected;` before `relayer` (slot shift).
  // ----------------------------------------------------------------------
  console.log(`\n[3/3] negative control validateUpgrade(${V1_NAME} -> ${BROKEN_NAME}) MUST throw ...`);
  let threw = false;
  try {
    await upgrades.validateUpgrade(V1, BROKEN, { kind: "uups", unsafeAllow: UNSAFE_ALLOW });
  } catch (e) {
    threw = true;
    console.log("      OK — broken layout REJECTED by validateUpgrade:");
    console.log("      " + String(e.message).split("\n")[0]);
  }
  if (!threw) {
    console.error("NEGATIVE CONTROL DID NOT THROW — the gate accepted a broken layout");
    process.exit(1);
  }
  console.log("SENTINEL_NEGCONTROL_REJECTED");

  console.log("\n=== DualCurrency storage-safety gate: GREEN (both sentinels) ===");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

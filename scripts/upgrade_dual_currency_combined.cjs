/*
 * ============================================================================
 * LIVE UPGRADE — DualCurrencyRepoRewards (Phase 4 combined impl, CONTRACT-01)
 * ============================================================================
 *
 * Modeled on the PROVEN-safe scripts/upgrade_reentrancy_guard.cjs:
 *   forceImport -> validateUpgrade HARD GATE -> capture pre-upgrade invariants
 *   -> upgradeProxy(redeployImplementation:'always', call: initializeV3)
 *   -> assert post-upgrade balances/storage byte-equal -> rollback on mismatch.
 *
 * ⚠️ The internal forceImport+validateUpgrade here is a NEW-vs-NEW self-compare
 * (forceImport records the EDITED source as baseline) and is NOT the binding
 * storage gate. The BINDING gate is scripts/validate_upgrade_dualcurrency.cjs
 * (two-factory vs the frozen ...V1 baseline + negative control). RUN THAT FIRST
 * and confirm SENTINEL_BASELINE_PASS + SENTINEL_NEGCONTROL_REJECTED before sending
 * this live tx.
 *
 * Carries NO gate-defeating storage flags (no skip-storage-check / custom-types /
 * allow-renames overrides). The @custom:oz-renamed-from annotation handles renames.
 */

"use strict";

const { ethers, upgrades } = require("hardhat");
require("dotenv").config({ path: "./server/.env" });

const UNSAFE_ALLOW = ["missing-initializer-call"];
const TEST_REPO_ID = 876024107; // known repo with live data

async function main() {
  console.log("================================================================");
  console.log(" DualCurrencyRepoRewards — LIVE combined upgrade (initializeV3)");
  console.log("================================================================");

  const [deployer] = await ethers.getSigners();
  const proxyAddress = process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS;
  if (!proxyAddress) {
    throw new Error("DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS not set in environment");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy:    ${proxyAddress}`);

  const Factory = await ethers.getContractFactory("DualCurrencyRepoRewards");

  // STEP 1: import + HARD-GATE validateUpgrade ----------------------------
  try {
    await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });
    console.log("  ✓ Proxy imported");
  } catch (_) {
    console.log("  ✓ Proxy already known to OpenZeppelin");
  }
  try {
    await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups", unsafeAllow: UNSAFE_ALLOW });
    console.log("  ✓ validateUpgrade passed (internal self-check; binding gate = validate_upgrade_dualcurrency.cjs)");
  } catch (e) {
    console.error("  ✗ validateUpgrade FAILED — aborting upgrade");
    console.error(e.message);
    process.exit(1);
  }

  // STEP 2: capture pre-upgrade invariants --------------------------------
  const balBefore = await ethers.provider.getBalance(proxyAddress);
  const current = Factory.attach(proxyAddress);
  let repoBefore = null;
  try {
    repoBefore = await current.getRepository(TEST_REPO_ID);
    console.log(`  ✓ Repo ${TEST_REPO_ID}: managers=${repoBefore[0].length} xdc=${ethers.formatEther(repoBefore[2])}`);
  } catch (e) {
    console.log(`  ⚠ Could not read repo ${TEST_REPO_ID}: ${e.message}`);
  }
  const oldImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`  Old impl: ${oldImpl}  | proxy balance: ${ethers.formatEther(balBefore)} XDC`);

  // STEP 3: upgrade + initializeV3 ----------------------------------------
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: UNSAFE_ALLOW,
    call: { fn: "initializeV3" },
  });
  await upgraded.waitForDeployment();
  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`  ✓ Upgraded. New impl: ${newImpl}`);

  // STEP 4: post-upgrade integrity check + rollback on mismatch -----------
  const balAfter = await ethers.provider.getBalance(proxyAddress);
  let mismatch = balBefore.toString() !== balAfter.toString();
  if (repoBefore) {
    const repoAfter = await upgraded.getRepository(TEST_REPO_ID);
    if (
      repoBefore[0].length !== repoAfter[0].length ||
      repoBefore[2].toString() !== repoAfter[2].toString() ||
      repoBefore[3].toString() !== repoAfter[3].toString() ||
      repoBefore[4].toString() !== repoAfter[4].toString()
    ) {
      mismatch = true;
    }
  }
  if (mismatch) {
    console.error("  ✗ INTEGRITY MISMATCH — rolling back");
    const proxyContract = new ethers.Contract(
      proxyAddress,
      ["function upgradeToAndCall(address,bytes) payable"],
      deployer
    );
    const rollbackTx = await proxyContract.upgradeToAndCall(oldImpl, "0x", { gasLimit: 500000 });
    await rollbackTx.wait();
    console.error("  ✓ Rolled back to previous implementation");
    throw new Error("Data integrity check failed — upgrade rolled back");
  }

  console.log("  ✓ Balances + critical storage byte-equal pre vs post");
  console.log("\n=== DualCurrency live upgrade COMPLETE ===");
  console.log(`  Old impl: ${oldImpl}`);
  console.log(`  New impl: ${newImpl}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

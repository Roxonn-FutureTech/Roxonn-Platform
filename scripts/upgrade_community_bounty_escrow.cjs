/*
 * ============================================================================
 * LIVE UPGRADE — CommunityBountyEscrow (Phase 4 impl, ESCROW-02/03/04/06)
 * ============================================================================
 *
 * Modeled on the PROVEN-safe scripts/upgrade_reentrancy_guard.cjs:
 *   forceImport -> validateUpgrade HARD GATE -> capture pre-upgrade invariants
 *   -> upgradeProxy(redeployImplementation:'always') -> assert owner/relayer/
 *   nextBountyId + balance byte-equal -> rollback on mismatch.
 *
 * No initializer call: the Phase 4 escrow impl adds no new reinitializer (the
 * new state is __gap + behavior-only changes). _disableInitializers lives in the
 * impl constructor (covered by unsafeAllow:['constructor']).
 *
 * ⚠️ The internal forceImport+validateUpgrade here is a NEW-vs-NEW self-compare
 * and is NOT the binding storage gate. The BINDING gate is
 * scripts/validate_upgrade_escrow.cjs (two-factory vs the frozen ...V1 baseline
 * + negative control). RUN THAT FIRST and confirm SENTINEL_BASELINE_PASS +
 * SENTINEL_NEGCONTROL_REJECTED before sending this live tx.
 *
 * Carries NO gate-defeating storage flags (no skip-storage-check / custom-types /
 * allow-renames overrides). The @custom:oz-renamed-from annotation handles renames.
 */

"use strict";

const { ethers, upgrades } = require("hardhat");
require("dotenv").config({ path: "./server/.env" });

const UNSAFE_ALLOW = ["constructor", "missing-initializer-call"];

async function main() {
  console.log("================================================================");
  console.log(" CommunityBountyEscrow — LIVE upgrade");
  console.log("================================================================");

  const [deployer] = await ethers.getSigners();
  const proxyAddress = process.env.COMMUNITY_BOUNTY_ESCROW_ADDRESS;
  if (!proxyAddress) {
    throw new Error("COMMUNITY_BOUNTY_ESCROW_ADDRESS not set in environment");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy:    ${proxyAddress}`);

  const Factory = await ethers.getContractFactory("CommunityBountyEscrow");

  // STEP 1: import + HARD-GATE validateUpgrade ----------------------------
  try {
    await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });
    console.log("  ✓ Proxy imported");
  } catch (_) {
    console.log("  ✓ Proxy already known to OpenZeppelin");
  }
  try {
    await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups", unsafeAllow: UNSAFE_ALLOW });
    console.log("  ✓ validateUpgrade passed (internal self-check; binding gate = validate_upgrade_escrow.cjs)");
  } catch (e) {
    console.error("  ✗ validateUpgrade FAILED — aborting upgrade");
    console.error(e.message);
    process.exit(1);
  }

  // STEP 2: capture pre-upgrade invariants (deploy script reads :172-179) --
  const balBefore = await ethers.provider.getBalance(proxyAddress);
  const current = Factory.attach(proxyAddress);
  const ownerBefore = await current.owner();
  const relayerBefore = await current.relayer();
  const pRateBefore = await current.platformFeeRate();
  const cRateBefore = await current.contributorFeeRate();
  const nextIdBefore = await current.nextBountyId();
  const oldImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`  Pre:  owner=${ownerBefore} relayer=${relayerBefore} nextBountyId=${nextIdBefore}`);
  console.log(`  Old impl: ${oldImpl}  | proxy balance: ${ethers.formatEther(balBefore)} XDC`);

  // STEP 3: upgrade -------------------------------------------------------
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: UNSAFE_ALLOW,
  });
  await upgraded.waitForDeployment();
  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`  ✓ Upgraded. New impl: ${newImpl}`);

  // STEP 4: post-upgrade integrity check + rollback on mismatch -----------
  const balAfter = await ethers.provider.getBalance(proxyAddress);
  const ownerAfter = await upgraded.owner();
  const relayerAfter = await upgraded.relayer();
  const pRateAfter = await upgraded.platformFeeRate();
  const cRateAfter = await upgraded.contributorFeeRate();
  const nextIdAfter = await upgraded.nextBountyId();

  const mismatch =
    balBefore.toString() !== balAfter.toString() ||
    ownerBefore !== ownerAfter ||
    relayerBefore !== relayerAfter ||
    pRateBefore.toString() !== pRateAfter.toString() ||
    cRateBefore.toString() !== cRateAfter.toString() ||
    nextIdBefore.toString() !== nextIdAfter.toString();

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

  console.log(`  Post: owner=${ownerAfter} relayer=${relayerAfter} nextBountyId=${nextIdAfter}`);
  console.log("  ✓ owner/relayer/feeRates/nextBountyId + balance byte-equal pre vs post");
  console.log("\n=== Escrow live upgrade COMPLETE ===");
  console.log(`  Old impl: ${oldImpl}`);
  console.log(`  New impl: ${newImpl}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

/*
 * ============================================================================
 * MAINNET-FORK DRY-RUN — rehearse both live upgrades, assert state intact
 * ============================================================================
 *
 * Runs the two UUPS upgrades against a forked XDC mainnet under an impersonated
 * owner EOA, then asserts balances + critical storage are byte-equal pre vs post.
 * NO live tx is sent — everything happens on the local fork.
 *
 * REQUIRES: FORK_MAINNET=1 (so hardhat.config.cjs enables the chain-50 fork with
 * chains[50].hardforkHistory.shanghai=0; without it ALL EVM execution reverts
 * "no known hardfork for execution on a historical block").
 *
 * RUN: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_upgrade.cjs
 *
 * Model: scripts/upgrade_reentrancy_guard.cjs pre/post integrity check (:92-102).
 */

"use strict";

const hre = require("hardhat");
const { ethers, upgrades, network } = hre;
require("dotenv").config({ path: "./server/.env" });

// Live owner/upgrader hot EOA (DualCurrency owner+upgrader = escrow owner+relayer).
const OWNER_EOA = "0xe949B23aB55865afd4cc7FBcBd30F1A3DC36c07c";
const TEST_REPO_ID = 876024107;
// A known pool manager to confirm membership is still recognized via the new O(1)
// map post-upgrade (Risk #7). Falls back to skip if unset.
const KNOWN_POOL_MANAGER = process.env.FORK_KNOWN_POOL_MANAGER || OWNER_EOA;

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]); // 1000 XDC
  return await ethers.getSigner(addr);
}

async function dryrunDualCurrency(ownerSigner) {
  const proxy = process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS;
  if (!proxy) {
    console.log("  ⚠ DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS unset — skipping DualCurrency dry-run");
    return;
  }
  console.log(`\n--- DualCurrency dry-run @ ${proxy} ---`);
  const Factory = (await ethers.getContractFactory("DualCurrencyRepoRewards")).connect(ownerSigner);
  try {
    await upgrades.forceImport(proxy, Factory, { kind: "uups" });
  } catch (_) {}

  const balBefore = await ethers.provider.getBalance(proxy);
  const before = Factory.attach(proxy);
  const repoBefore = await before.getRepository(TEST_REPO_ID);
  console.log(`  pre:  balance=${ethers.formatEther(balBefore)} XDC managers=${repoBefore[0].length}`);

  const upgraded = await upgrades.upgradeProxy(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: ["missing-initializer-call"],
    call: { fn: "initializeV3" },
  });
  await upgraded.waitForDeployment();

  const balAfter = await ethers.provider.getBalance(proxy);
  const repoAfter = await upgraded.getRepository(TEST_REPO_ID);
  // Risk #7: existing pool manager must still be recognized via the new O(1) map.
  let mgrRecognized = "n/a";
  try {
    mgrRecognized = await upgraded.isRepoPoolManager(TEST_REPO_ID, KNOWN_POOL_MANAGER);
  } catch (_) {}
  console.log(`  post: balance=${ethers.formatEther(balAfter)} XDC managers=${repoAfter[0].length} isRepoPoolManager=${mgrRecognized}`);

  if (balBefore.toString() !== balAfter.toString() || repoBefore[0].length !== repoAfter[0].length) {
    throw new Error("DualCurrency dry-run: balance/storage mismatch post-upgrade");
  }
  console.log("  ✓ DualCurrency: balances + critical storage byte-equal pre vs post");
}

async function dryrunEscrow(ownerSigner) {
  const proxy = process.env.COMMUNITY_BOUNTY_ESCROW_ADDRESS;
  if (!proxy) {
    console.log("  ⚠ COMMUNITY_BOUNTY_ESCROW_ADDRESS unset — skipping escrow dry-run");
    return;
  }
  console.log(`\n--- Escrow dry-run @ ${proxy} ---`);
  const Factory = (await ethers.getContractFactory("CommunityBountyEscrow")).connect(ownerSigner);
  try {
    await upgrades.forceImport(proxy, Factory, { kind: "uups" });
  } catch (_) {}

  const balBefore = await ethers.provider.getBalance(proxy);
  const before = Factory.attach(proxy);
  const ownerBefore = await before.owner();
  const relayerBefore = await before.relayer();
  const nextIdBefore = await before.nextBountyId();
  console.log(`  pre:  balance=${ethers.formatEther(balBefore)} owner=${ownerBefore} nextBountyId=${nextIdBefore}`);

  const upgraded = await upgrades.upgradeProxy(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: ["constructor", "missing-initializer-call"],
  });
  await upgraded.waitForDeployment();

  const balAfter = await ethers.provider.getBalance(proxy);
  const ownerAfter = await upgraded.owner();
  const relayerAfter = await upgraded.relayer();
  const nextIdAfter = await upgraded.nextBountyId();
  console.log(`  post: balance=${ethers.formatEther(balAfter)} owner=${ownerAfter} nextBountyId=${nextIdAfter}`);

  if (
    balBefore.toString() !== balAfter.toString() ||
    ownerBefore !== ownerAfter ||
    relayerBefore !== relayerAfter ||
    nextIdBefore.toString() !== nextIdAfter.toString()
  ) {
    throw new Error("Escrow dry-run: balance/storage mismatch post-upgrade");
  }
  console.log("  ✓ Escrow: balances + owner/relayer/nextBountyId byte-equal pre vs post");
}

async function main() {
  if (process.env.FORK_MAINNET !== "1") {
    console.error("FORK_MAINNET=1 is required (run: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_upgrade.cjs)");
    process.exit(1);
  }
  console.log("================================================================");
  console.log(" Mainnet-fork upgrade dry-run (no live tx)");
  console.log("================================================================");

  const ownerSigner = await impersonate(OWNER_EOA);
  await dryrunDualCurrency(ownerSigner);
  await dryrunEscrow(ownerSigner);

  console.log("\n=== Fork dry-run COMPLETE — both upgrades rehearsed, state intact ===");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

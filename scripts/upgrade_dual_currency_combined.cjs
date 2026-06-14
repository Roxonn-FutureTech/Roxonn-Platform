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
 *
 * RC-7 — PER-REPO MEMBERSHIP BACKFILL (REQUIRED at live time):
 *   initializeV3 ONLY backfills the GLOBAL usernameToWallet map. The PER-REPO
 *   isRepoPoolManager / isRepoContributor O(1) maps stay EMPTY unless we explicitly
 *   call backfillRepoMembership(repoId) for EVERY live repoId after the upgrade.
 *   Skipping this locks out every pool manager post-upgrade. The repositories
 *   mapping has no on-chain keyset, so repoIds are enumerated at runtime from the
 *   indexed first topic of the 4 repo events (same pattern PROVEN green in
 *   scripts/fork_dryrun_dualcurrency_membership.cjs / 04-07). We do NOT hardcode the
 *   8 known ids so the script stays correct if repos were added after the dry-run.
 *   After backfill we ASSERT exhaustive map==array equality (every kept
 *   poolManagers[]/contributors[] entry resolves TRUE) and that getUserWalletByUsername
 *   resolves for a known username; ANY failure aborts the run as NOT successful.
 *   NOTE (FIX 6): a rollback (upgradeToAndCall(oldImpl,"0x")) does NOT unwind
 *   initializeV3's reinitializer writes or the backfill — the fork dry-run is the
 *   only pre-live gate for a bad backfill; these live assertions are the last guard.
 */

"use strict";

const { ethers, upgrades } = require("hardhat");
require("dotenv").config({ path: "./server/.env" });

const UNSAFE_ALLOW = ["missing-initializer-call"];
const TEST_REPO_ID = 876024107; // known repo with live data

// Events whose INDEXED first arg is repoId — used to enumerate every live repoId
// (the `repositories` mapping has no on-chain keyset; logs are the only source).
// Ported from scripts/fork_dryrun_dualcurrency_membership.cjs (proven green, 04-07).
const REPO_EVENT_SIGS = [
  "RewardAllocated(uint256,uint256,uint256,uint8)",
  "XDCFundAddedToRepository(uint256,address,uint256)",
  "ROXNFundAddedToRepository(uint256,address,uint256)",
  "USDCFundAddedToRepository(uint256,address,uint256)",
];

// Enumerate every distinct repoId from the indexed first topic of the 4 repo events.
// Enumeration is a pure HISTORY read, so it runs against a DIRECT JsonRpcProvider on
// the live node. Uses recursive-halving on range-limit errors (XDC RPC caps getLogs at
// ~10k blocks) so it adapts to whatever the node allows. Ported verbatim-in-behavior
// from the fork dry-run.
async function enumerateRepoIds(proxy) {
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(process.env.XDC_RPC_URL);
  const head = await provider.getBlockNumber();
  const topics0 = REPO_EVENT_SIGS.map((s) => ethers.id(s));
  const ids = new Set();
  let scanned = 0;
  const from = Number(process.env.FORK_DEPLOY_BLOCK || 0);
  const BASE = Number(process.env.FORK_LOG_CHUNK || 10000);

  async function fetchRange(start, end) {
    try {
      const logs = await provider.getLogs({ address: proxy, fromBlock: start, toBlock: end, topics: [topics0] });
      for (const lg of logs) {
        if (lg.topics && lg.topics[1]) ids.add(BigInt(lg.topics[1]).toString());
      }
      scanned += logs.length;
    } catch (e) {
      const msg = (e && (e.shortMessage || e.message)) || String(e);
      if (end > start && /too large|range|limit|-32062|-32005/i.test(msg)) {
        const mid = Math.floor((start + end) / 2);
        await fetchRange(start, mid);
        await fetchRange(mid + 1, end);
      } else {
        throw new Error(`getLogs failed for range ${start}-${end}: ${msg}`);
      }
    }
  }

  for (let start = from; start <= head; start += BASE) {
    await fetchRange(start, Math.min(start + BASE - 1, head));
  }
  return { repoIds: Array.from(ids), logCount: scanned, head };
}

function repoSnapshot(repoTuple) {
  // getRepository returns: [poolManagers[], contributors[], XDC, ROXN, USDC, issues[]]
  return {
    poolManagers: repoTuple[0].map((a) => a.toLowerCase()),
    contributors: repoTuple[1].map((a) => a.toLowerCase()),
    xdc: repoTuple[2].toString(),
    roxn: repoTuple[3].toString(),
    usdc: repoTuple[4].toString(),
  };
}

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

  // STEP 2b: enumerate every live repoId + pre-upgrade snapshot of each ----
  // (needed for the RC-7 backfill loop + exhaustive post-backfill assertions)
  console.log("  Enumerating live repoIds from on-chain event logs ...");
  const { repoIds, logCount } = await enumerateRepoIds(proxyAddress);
  console.log(`  ✓ scanned ${logCount} repo-event logs -> ${repoIds.length} distinct repoId(s): ${repoIds.join(", ") || "(none)"}`);
  if (repoIds.length === 0) {
    throw new Error(
      "BLOCKER: enumerated ZERO repoIds from logs — cannot backfill per-repo membership. " +
      "Aborting BEFORE the upgrade tx (check XDC_RPC_URL / FORK_DEPLOY_BLOCK / event coverage)."
    );
  }
  const preSnap = {};
  for (const id of repoIds) {
    preSnap[id] = repoSnapshot(await current.getRepository(id));
  }
  // capture a known username (if any) to verify initializeV3 GLOBAL backfill post-upgrade.
  let knownUsername = null;
  let knownUsernameWallet = null;
  async function probeUsernames(arrGetter, structGetter) {
    for (let i = 0; i < 25 && !knownUsername; i++) {
      let addr;
      try { addr = await arrGetter(i); } catch (_) { break; } // out of range
      try {
        const s = await structGetter(addr); // (username, githubId, wallet)
        if (s[0] && s[0].length > 0) {
          knownUsername = s[0];
          knownUsernameWallet = s[2].toLowerCase();
        }
      } catch (_) {}
    }
  }
  await probeUsernames((i) => current.poolManagerAddresses(i), (a) => current.poolManagers(a));
  if (!knownUsername) await probeUsernames((i) => current.contributorAddresses(i), (a) => current.contributors(a));
  if (knownUsername) console.log(`  ✓ known username for global-backfill check: "${knownUsername}" -> ${knownUsernameWallet}`);
  else console.log("  ⚠ no enumerable username found; getUserWalletByUsername assertion will be skipped");

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

  // STEP 5: RC-7 — backfill PER-REPO membership for every live repoId + assert
  // initializeV3 only filled the GLOBAL usernameToWallet map. Without these calls
  // the per-repo isRepoPoolManager/isRepoContributor maps stay empty and every pool
  // manager is locked out. These are REAL txs (gas) when run against xinfin — expected.
  console.log(`\n  Backfilling per-repo membership for ${repoIds.length} repo(s) (RC-7) ...`);
  const arraysEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  let totalPM = 0, totalC = 0;
  for (const id of repoIds) {
    const tx = await upgraded.connect(deployer).backfillRepoMembership(id);
    await tx.wait();

    const post = repoSnapshot(await upgraded.getRepository(id));
    const pre = preSnap[id];

    // 5a. backfill must NOT mutate the kept arrays or any pool reward balance
    if (!arraysEqual(pre.poolManagers, post.poolManagers)) {
      throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} poolManagers[] changed — upgrade NOT successful`);
    }
    if (!arraysEqual(pre.contributors, post.contributors)) {
      throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} contributors[] changed — upgrade NOT successful`);
    }
    if (pre.xdc !== post.xdc) throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} poolRewards XDC changed ${pre.xdc}->${post.xdc}`);
    if (pre.roxn !== post.roxn) throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} poolRewards ROXN changed ${pre.roxn}->${post.roxn}`);
    if (pre.usdc !== post.usdc) throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} poolRewards USDC changed ${pre.usdc}->${post.usdc}`);

    // 5b. EXHAUSTIVE map==array equality — every kept entry must resolve TRUE (Risk #7)
    for (const pm of post.poolManagers) {
      const ok = await upgraded.isRepoPoolManager(id, pm);
      if (!ok) {
        throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} poolManager ${pm} NOT recognized in isRepoPoolManager after backfill (LOCKOUT) — upgrade NOT successful`);
      }
    }
    for (const c of post.contributors) {
      const ok = await upgraded.isRepoContributor(id, c);
      if (!ok) {
        throw new Error(`MEMBERSHIP BACKFILL FAILURE: repo ${id} contributor ${c} NOT recognized in isRepoContributor after backfill (LOCKOUT) — upgrade NOT successful`);
      }
    }
    totalPM += post.poolManagers.length;
    totalC += post.contributors.length;
    console.log(`    repo ${id}: ${post.poolManagers.length} PM + ${post.contributors.length} C — ALL recognized; rewards byte-equal ✓`);
  }

  // 5c. initializeV3 GLOBAL username backfill check
  if (knownUsername) {
    const resolved = (await upgraded.getUserWalletByUsername(knownUsername)).toLowerCase();
    if (resolved !== knownUsernameWallet) {
      throw new Error(
        `GLOBAL BACKFILL FAILURE: getUserWalletByUsername("${knownUsername}") = ${resolved}, ` +
        `expected ${knownUsernameWallet} (initializeV3 backfill incomplete) — upgrade NOT successful`
      );
    }
    console.log(`  ✓ getUserWalletByUsername("${knownUsername}") resolves correctly`);
  } else {
    console.log("  ⚠ getUserWalletByUsername assertion skipped (no enumerable username)");
  }

  console.log(`  ✓ RC-7 membership backfill COMPLETE — ${repoIds.length} repo(s), ${totalPM} PM + ${totalC} C, exhaustive map==array equality PASS`);

  console.log("\n=== DualCurrency live upgrade COMPLETE ===");
  console.log(`  Old impl: ${oldImpl}`);
  console.log(`  New impl: ${newImpl}`);
  console.log(`  Repos backfilled: ${repoIds.length} (${repoIds.join(", ")})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

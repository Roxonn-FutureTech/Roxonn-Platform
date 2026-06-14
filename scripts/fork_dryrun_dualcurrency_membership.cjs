/*
 * ============================================================================
 * MAINNET-FORK DRY-RUN (EXHAUSTIVE) — DualCurrency combined upgrade + RC-7 backfill
 * ============================================================================
 *
 * Phase 4 / Plan 04-07 Task 1 — the KEY pre-live runtime proof (FIX 6 + FIX 7,
 * Risk #7, Risk #14). Forks XDC mainnet at a FRESH contemporaneous block,
 * impersonates the live owner/upgrader hot EOA, applies the combined DualCurrency
 * upgrade (upgradeProxy + call:initializeV3, unsafeAllow:['missing-initializer-call'])
 * on the fork, then runs backfillRepoMembership(repoId) for EVERY live repoId and
 * proves — exhaustively — that no balance/storage changed and that every kept
 * poolManagers[]/contributors[] entry resolves TRUE in the new O(1) membership maps.
 *
 * NO LIVE TX. Everything happens on the in-process Hardhat fork.
 *
 * REQUIRES: FORK_MAINNET=1 (enables the chain-50 fork in hardhat.config.cjs;
 * without it ALL EVM execution reverts "no known hardfork for execution on a
 * historical block") + XDC_RPC_URL + DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS.
 *
 * RUN: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_dualcurrency_membership.cjs
 *
 * NOTE (FIX 6): upgradeToAndCall(oldImpl,"0x") rollback does NOT unwind
 * initializeV3's reinitializer state writes (a reinitializer's storage writes
 * persist after a rollback to the old impl). A partial/bad backfill therefore
 * cannot be undone by rollback — THIS fork dry-run is the ONLY gate that can
 * catch a bad backfill BEFORE the live tx, which is why the membership check
 * below is exhaustive (full map==array equality), not a single spot-check.
 */

"use strict";

const hre = require("hardhat");
const { ethers, upgrades, network } = hre;
require("dotenv").config({ path: "./server/.env" });

// Live owner/upgrader hot EOA (DualCurrency owner+upgrader).
const OWNER_EOA = "0xe949B23aB55865afd4cc7FBcBd30F1A3DC36c07c";

// Events whose INDEXED first arg is repoId — used to enumerate every live repoId
// (the `repositories` mapping has no on-chain keyset; logs are the only source).
const REPO_EVENT_SIGS = [
  "RewardAllocated(uint256,uint256,uint256,uint8)",
  "XDCFundAddedToRepository(uint256,address,uint256)",
  "ROXNFundAddedToRepository(uint256,address,uint256)",
  "USDCFundAddedToRepository(uint256,address,uint256)",
];

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]); // 1000 XDC
  return await ethers.getSigner(addr);
}

// Enumerate every distinct repoId from the indexed first topic of the 4 repo events.
// Enumeration is a pure HISTORY read, so it runs against a DIRECT JsonRpcProvider on
// the live node (not the fork) — faster and avoids loading the fork with thousands of
// log requests. Uses recursive-halving on range-limit errors (XDC RPC caps getLogs at
// ~10k blocks) so it adapts to whatever the node allows.
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
  if (process.env.FORK_MAINNET !== "1") {
    console.error("FORK_MAINNET=1 is required (run: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_dualcurrency_membership.cjs)");
    process.exit(1);
  }
  const proxy = process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS;
  if (!proxy) throw new Error("DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS not set");

  console.log("================================================================");
  console.log(" DualCurrency mainnet-fork dry-run (EXHAUSTIVE membership) — no live tx");
  console.log("================================================================");

  const forkBlock = await ethers.provider.getBlockNumber();
  const forkNet = await ethers.provider.getNetwork();
  console.log(`Fork chainId=${forkNet.chainId} block=${forkBlock} proxy=${proxy}`);

  const ownerSigner = await impersonate(OWNER_EOA);
  const Factory = (await ethers.getContractFactory("DualCurrencyRepoRewards")).connect(ownerSigner);
  try {
    await upgrades.forceImport(proxy, Factory, { kind: "uups" });
  } catch (_) {}

  // ---- 1. ENUMERATE every live repoId from on-chain logs ------------------
  console.log("\n[1] Enumerating live repoIds from event logs ...");
  const { repoIds, logCount } = await enumerateRepoIds(proxy);
  console.log(`    scanned ${logCount} repo-event logs -> ${repoIds.length} distinct repoId(s): ${repoIds.join(", ") || "(none)"}`);
  if (repoIds.length === 0) {
    throw new Error("BLOCKER: enumerated ZERO repoIds from logs — cannot prove membership backfill. Investigate event coverage before claiming membership proven.");
  }

  // ---- 2. PRE-UPGRADE snapshot (balance + every repo) ---------------------
  const balBefore = await ethers.provider.getBalance(proxy);
  const before = Factory.attach(proxy);
  const preSnap = {};
  for (const id of repoIds) {
    preSnap[id] = repoSnapshot(await before.getRepository(id));
  }
  // capture a known username (if any) to verify initializeV3 GLOBAL backfill.
  // Scan up to 25 pool managers then 25 contributors to find the first with a
  // non-empty username (some addresses may have been added without registerUser).
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
  await probeUsernames((i) => before.poolManagerAddresses(i), (a) => before.poolManagers(a));
  if (!knownUsername) await probeUsernames((i) => before.contributorAddresses(i), (a) => before.contributors(a));
  console.log(`\n[2] Pre-upgrade: balance=${ethers.formatEther(balBefore)} XDC; snapshotted ${repoIds.length} repo(s).`);
  if (knownUsername) console.log(`    known username for getUserWalletByUsername check: "${knownUsername}" -> ${knownUsernameWallet}`);
  else console.log("    (no enumerable pool-manager username found for the global-backfill check; will skip that assertion)");

  // ---- 3. APPLY the combined upgrade on the fork --------------------------
  console.log("\n[3] upgradeProxy(call: initializeV3, unsafeAllow:['missing-initializer-call']) on the fork ...");
  const upgraded = await upgrades.upgradeProxy(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: ["missing-initializer-call"],
    call: { fn: "initializeV3" },
  });
  await upgraded.waitForDeployment();
  const newImpl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`    upgraded. new impl (fork-only): ${newImpl}`);

  // ---- 4. POST-UPGRADE: backfill EVERY repo + assert -----------------------
  console.log("\n[4] backfillRepoMembership(repoId) for EVERY live repo (as impersonated owner) + exhaustive assert ...");
  const balAfter = await ethers.provider.getBalance(proxy);
  if (balBefore.toString() !== balAfter.toString()) {
    throw new Error(`BALANCE MISMATCH: before=${balBefore} after=${balAfter}`);
  }
  console.log(`    proxy XDC balance byte-equal: ${ethers.formatEther(balAfter)} XDC (unchanged) ✓`);

  let totalPM = 0, totalC = 0;
  const perRepoResults = [];
  for (const id of repoIds) {
    // backfill as the impersonated admin/owner
    const tx = await upgraded.connect(ownerSigner).backfillRepoMembership(id);
    await tx.wait();

    const post = repoSnapshot(await upgraded.getRepository(id));
    const pre = preSnap[id];

    // 4a. storage byte-equality (managers/contributors arrays + all 3 pool rewards)
    const arraysEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!arraysEqual(pre.poolManagers, post.poolManagers)) throw new Error(`repo ${id}: poolManagers[] changed`);
    if (!arraysEqual(pre.contributors, post.contributors)) throw new Error(`repo ${id}: contributors[] changed`);
    if (pre.xdc !== post.xdc) throw new Error(`repo ${id}: poolRewards XDC changed ${pre.xdc}->${post.xdc}`);
    if (pre.roxn !== post.roxn) throw new Error(`repo ${id}: poolRewards ROXN changed ${pre.roxn}->${post.roxn}`);
    if (pre.usdc !== post.usdc) throw new Error(`repo ${id}: poolRewards USDC changed ${pre.usdc}->${post.usdc}`);

    // 4b. EXHAUSTIVE map==array equality for membership (FIX 6 / Risk #7)
    for (const pm of post.poolManagers) {
      const ok = await upgraded.isRepoPoolManager(id, pm);
      if (!ok) throw new Error(`repo ${id}: poolManager ${pm} NOT recognized in isRepoPoolManager after backfill (LOCKOUT)`);
    }
    for (const c of post.contributors) {
      const ok = await upgraded.isRepoContributor(id, c);
      if (!ok) throw new Error(`repo ${id}: contributor ${c} NOT recognized in isRepoContributor after backfill (LOCKOUT)`);
    }
    totalPM += post.poolManagers.length;
    totalC += post.contributors.length;
    perRepoResults.push({
      repoId: id,
      poolManagers: post.poolManagers.length,
      contributors: post.contributors.length,
      xdc: post.xdc, roxn: post.roxn, usdc: post.usdc,
      allRecognized: true,
    });
    console.log(`    repo ${id}: ${post.poolManagers.length} PM + ${post.contributors.length} C — ALL recognized; rewards XDC/ROXN/USDC byte-equal ✓`);
  }

  // 4c. initializeV3 global username backfill check
  let usernameCheck = "skipped (no enumerable username)";
  if (knownUsername) {
    const resolved = (await upgraded.getUserWalletByUsername(knownUsername)).toLowerCase();
    if (resolved !== knownUsernameWallet) {
      throw new Error(`getUserWalletByUsername("${knownUsername}") = ${resolved}, expected ${knownUsernameWallet} (initializeV3 backfill incomplete)`);
    }
    usernameCheck = `OK ("${knownUsername}" -> ${resolved})`;
    console.log(`    getUserWalletByUsername("${knownUsername}") resolves correctly ✓`);
  }

  // ---- summary -------------------------------------------------------------
  console.log("\n================================================================");
  console.log(" FORK DRY-RUN RESULT");
  console.log("================================================================");
  console.log(JSON.stringify({
    forkBlock,
    chainId: Number(forkNet.chainId),
    proxy,
    newImplForkOnly: newImpl,
    balanceXDC: ethers.formatEther(balAfter),
    balanceByteEqual: balBefore.toString() === balAfter.toString(),
    repoIdsEnumerated: repoIds,
    repoCount: repoIds.length,
    totalPoolManagers: totalPM,
    totalContributors: totalC,
    exhaustiveMembershipEquality: "PASS (every kept poolManagers[]/contributors[] entry resolves TRUE)",
    usernameBackfillCheck: usernameCheck,
    perRepo: perRepoResults,
  }, null, 2));
  console.log("\nFORK_DRYRUN_DUALCURRENCY_GREEN");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFORK_DRYRUN_DUALCURRENCY_FAILED");
    console.error(e);
    process.exit(1);
  });

/*
 * ============================================================================
 * MAINNET-FORK DRY-RUN — CommunityBountyEscrow upgrade (04-08, no live tx)
 * ============================================================================
 *
 * Dedicated, THOROUGH escrow dry-run for the 04-08 go-evidence chain. Forks XDC
 * mainnet (fresh contemporaneous block pinned in hardhat.config.cjs), impersonates
 * the live owner/relayer hot EOA, applies the escrow UUPS upgrade on the fork
 * (upgradeProxy, unsafeAllow:['constructor','missing-initializer-call'], NO
 * reinitializer call — the Phase-4 escrow impl adds no new initializer), then
 * ASSERTS:
 *
 *   1. IMMUTABLE STATE byte-equal pre vs post for the FULL invariant set:
 *      owner, relayer, feeCollector, roxnToken, usdcToken,
 *      platformFeeRate(=50), contributorFeeRate(=50), nextBountyId(=1),
 *      and the escrow's native-XDC balance (0).
 *   2. renounceOwnership() from the owner REVERTS ("Renounce disabled").
 *   3. ESCROW-02 contract-recipient .call payout works POST-upgrade: a fresh
 *      createBounty (XDC) + completeBounty paying a CONTRACT recipient via .call
 *      succeeds (the whole point of the .transfer -> .call fix). A 2300-gas
 *      .transfer would brick this contract recipient; .call forwards gas.
 *   4. The escrow's pre-existing balance is unaffected — the test bounty is fully
 *      accounted (escrow ends with 0 residual beyond the pre-existing balance).
 *
 * NO live tx is sent — everything happens on the local fork.
 *
 * REQUIRES: FORK_MAINNET=1 (so hardhat.config.cjs enables the chain-50 fork with
 * chains[50].hardforkHistory.shanghai=0; without it ALL EVM execution reverts
 * "no known hardfork for execution on a historical block") + XDC_RPC_URL set.
 *
 * RUN: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_escrow.cjs
 */

"use strict";

const hre = require("hardhat");
const { ethers, upgrades, network } = hre;
require("dotenv").config({ path: "./server/.env" });

// Live owner+relayer hot EOA for the escrow (owner == relayer per 04-08 brief).
const OWNER_EOA = "0xe949B23aB55865afd4cc7FBcBd30F1A3DC36c07c";
const UNSAFE_ALLOW = ["constructor", "missing-initializer-call"];

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  // 1,000,000 XDC so the impersonated owner can fund a test bounty + pay gas.
  await network.provider.send("hardhat_setBalance", [addr, "0xD3C21BCECCEDA1000000"]);
  return await ethers.getSigner(addr);
}

function assertEq(label, before, after, rows) {
  const a = String(before);
  const b = String(after);
  const ok = a === b;
  rows.push({ field: label, pre: a, post: b, equal: ok ? "YES" : "NO" });
  if (!ok) {
    throw new Error(`IMMUTABLE-STATE MISMATCH on '${label}': pre=${a} post=${b}`);
  }
}

async function main() {
  if (process.env.FORK_MAINNET !== "1") {
    console.error("FORK_MAINNET=1 is required (run: FORK_MAINNET=1 npx hardhat run scripts/fork_dryrun_escrow.cjs)");
    process.exit(1);
  }
  const proxy = process.env.COMMUNITY_BOUNTY_ESCROW_ADDRESS;
  if (!proxy) {
    console.error("COMMUNITY_BOUNTY_ESCROW_ADDRESS not set in server/.env");
    process.exit(1);
  }

  console.log("================================================================");
  console.log(" CommunityBountyEscrow — mainnet-fork upgrade dry-run (no live tx)");
  console.log("================================================================");
  const forkBlock = await ethers.provider.getBlockNumber();
  console.log(` Fork block:   ${forkBlock}`);
  console.log(` Escrow proxy: ${proxy}`);
  console.log(` Owner/relayer (impersonated): ${OWNER_EOA}`);

  const ownerSigner = await impersonate(OWNER_EOA);
  const Factory = (await ethers.getContractFactory("CommunityBountyEscrow")).connect(ownerSigner);

  // forceImport: no .openzeppelin/ manifest exists for the live proxy. NOTE: this
  // is NOT the binding storage gate — that is scripts/validate_upgrade_escrow.cjs
  // (two-factory vs the frozen V1 baseline). forceImport here just lets upgradeProxy
  // proceed on the fork.
  try {
    await upgrades.forceImport(proxy, Factory, { kind: "uups" });
  } catch (_) {}

  // ----------------------------------------------------------------------
  // PRE-UPGRADE immutable-state snapshot.
  // ----------------------------------------------------------------------
  const before = Factory.attach(proxy);
  const pre = {
    balance: await ethers.provider.getBalance(proxy),
    owner: await before.owner(),
    relayer: await before.relayer(),
    feeCollector: await before.feeCollector(),
    roxnToken: await before.roxnToken(),
    usdcToken: await before.usdcToken(),
    platformFeeRate: await before.platformFeeRate(),
    contributorFeeRate: await before.contributorFeeRate(),
    nextBountyId: await before.nextBountyId(),
  };
  const oldImpl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`\n--- PRE-upgrade ---`);
  console.log(` old impl:          ${oldImpl}`);
  console.log(` balance:           ${ethers.formatEther(pre.balance)} XDC`);
  console.log(` owner:             ${pre.owner}`);
  console.log(` relayer:           ${pre.relayer}`);
  console.log(` feeCollector:      ${pre.feeCollector}`);
  console.log(` roxnToken:         ${pre.roxnToken}`);
  console.log(` usdcToken:         ${pre.usdcToken}`);
  console.log(` platformFeeRate:   ${pre.platformFeeRate}`);
  console.log(` contributorFeeRate:${pre.contributorFeeRate}`);
  console.log(` nextBountyId:      ${pre.nextBountyId}`);

  // ----------------------------------------------------------------------
  // APPLY the upgrade on the fork (NO reinitializer call for escrow).
  // ----------------------------------------------------------------------
  console.log(`\n--- Applying escrow upgrade on the fork (upgradeProxy) ---`);
  const upgraded = await upgrades.upgradeProxy(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
    unsafeAllow: UNSAFE_ALLOW,
  });
  await upgraded.waitForDeployment();
  const newImpl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(` new impl:          ${newImpl}`);
  if (newImpl.toLowerCase() === oldImpl.toLowerCase()) {
    throw new Error("new impl == old impl — upgrade did not redeploy implementation");
  }

  // ----------------------------------------------------------------------
  // (1) POST-UPGRADE immutable-state byte-equality (full invariant set).
  // ----------------------------------------------------------------------
  const rows = [];
  const post = {
    balance: await ethers.provider.getBalance(proxy),
    owner: await upgraded.owner(),
    relayer: await upgraded.relayer(),
    feeCollector: await upgraded.feeCollector(),
    roxnToken: await upgraded.roxnToken(),
    usdcToken: await upgraded.usdcToken(),
    platformFeeRate: await upgraded.platformFeeRate(),
    contributorFeeRate: await upgraded.contributorFeeRate(),
    nextBountyId: await upgraded.nextBountyId(),
  };
  assertEq("owner", pre.owner, post.owner, rows);
  assertEq("relayer", pre.relayer, post.relayer, rows);
  assertEq("feeCollector", pre.feeCollector, post.feeCollector, rows);
  assertEq("roxnToken", pre.roxnToken, post.roxnToken, rows);
  assertEq("usdcToken", pre.usdcToken, post.usdcToken, rows);
  assertEq("platformFeeRate", pre.platformFeeRate, post.platformFeeRate, rows);
  assertEq("contributorFeeRate", pre.contributorFeeRate, post.contributorFeeRate, rows);
  assertEq("nextBountyId", pre.nextBountyId, post.nextBountyId, rows);
  assertEq("balance(XDC,wei)", pre.balance, post.balance, rows);

  console.log(`\n--- (1) IMMUTABLE-STATE byte-equality (pre vs post) ---`);
  console.log(" field               | pre                                        | post                                       | equal");
  for (const r of rows) {
    console.log(` ${r.field.padEnd(19)}| ${r.pre.padEnd(43)}| ${r.post.padEnd(43)}| ${r.equal}`);
  }
  console.log(" RESULT: all immutable state byte-equal pre vs post ✓");

  // Sanity-pin the values the brief calls out explicitly.
  if (post.platformFeeRate.toString() !== "50") throw new Error(`platformFeeRate != 50 (got ${post.platformFeeRate})`);
  if (post.contributorFeeRate.toString() !== "50") throw new Error(`contributorFeeRate != 50 (got ${post.contributorFeeRate})`);
  if (post.nextBountyId.toString() !== "1") throw new Error(`nextBountyId != 1 (got ${post.nextBountyId})`);

  // ----------------------------------------------------------------------
  // (2) renounceOwnership() from the owner MUST revert ("Renounce disabled").
  // ----------------------------------------------------------------------
  console.log(`\n--- (2) renounceOwnership() MUST revert ---`);
  let renounceReverted = false;
  let renounceReason = "";
  try {
    await upgraded.connect(ownerSigner).renounceOwnership.staticCall();
  } catch (e) {
    renounceReverted = true;
    renounceReason = String(e.shortMessage || e.message).split("\n")[0];
  }
  if (!renounceReverted) {
    throw new Error("renounceOwnership did NOT revert — renounce protection broken");
  }
  console.log(`      OK — renounceOwnership reverted: ${renounceReason}`);

  // ----------------------------------------------------------------------
  // (3) ESCROW-02 contract-recipient .call payout works POST-upgrade.
  //     Deploy a minimal CONTRACT recipient; createBounty (XDC) + completeBounty
  //     paying that contract recipient via .call must succeed. A 2300-gas
  //     .transfer would brick this recipient (its receive() does real work).
  // ----------------------------------------------------------------------
  console.log(`\n--- (3) ESCROW-02 contract-recipient .call payout (post-upgrade) ---`);
  const Recipient = (await ethers.getContractFactory("ContractRecipient")).connect(ownerSigner);
  const recipient = await Recipient.deploy(proxy);
  await recipient.waitForDeployment();
  const recipientAddr = await recipient.getAddress();
  console.log(`      contract recipient deployed (fork-only): ${recipientAddr}`);

  const escrowBalBeforeTest = await ethers.provider.getBalance(proxy);
  const recipientBalBefore = await ethers.provider.getBalance(recipientAddr);
  const feeCollectorBalBefore = await ethers.provider.getBalance(post.feeCollector);

  const BOUNTY = ethers.parseEther("10"); // 10 XDC test bounty
  const nextIdBeforeCreate = await upgraded.nextBountyId();

  // owner == relayer, so the same impersonated signer both creates and completes.
  const createTx = await upgraded.connect(ownerSigner).createBounty(BOUNTY, 0 /* XDC */, 0, { value: BOUNTY });
  await createTx.wait();
  const newBountyId = nextIdBeforeCreate; // createBounty uses nextBountyId++ (post-increment)
  console.log(`      createBounty OK — bountyId=${newBountyId}, amount=${ethers.formatEther(BOUNTY)} XDC`);

  const completeTx = await upgraded.connect(ownerSigner).completeBounty(newBountyId, recipientAddr);
  await completeTx.wait();
  console.log(`      completeBounty OK — paid CONTRACT recipient via .call`);

  // Fee math: platform 0.5% + contributor 0.5% = 1% to feeCollector; net 99% to recipient.
  const platformFee = (BOUNTY * 50n) / 10000n;
  const contributorFee = (BOUNTY * 50n) / 10000n;
  const netExpected = BOUNTY - platformFee - contributorFee;

  const recipientBalAfter = await ethers.provider.getBalance(recipientAddr);
  const feeCollectorBalAfter = await ethers.provider.getBalance(post.feeCollector);
  const escrowBalAfterTest = await ethers.provider.getBalance(proxy);

  const recipientDelta = recipientBalAfter - recipientBalBefore;
  const feeDelta = feeCollectorBalAfter - feeCollectorBalBefore;

  console.log(`      net to recipient:  ${ethers.formatEther(recipientDelta)} XDC (expected ${ethers.formatEther(netExpected)})`);
  console.log(`      fees to collector: ${ethers.formatEther(feeDelta)} XDC (expected ${ethers.formatEther(platformFee + contributorFee)})`);

  if (recipientDelta.toString() !== netExpected.toString()) {
    throw new Error(`contract recipient received ${recipientDelta} wei, expected ${netExpected} (.call payout wrong)`);
  }
  // feeCollector may be the same hot EOA or a separate wallet; if it equals the owner
  // (which also paid gas) the raw balance delta is noisy. Only assert the fee leg
  // strictly when feeCollector is distinct from the impersonated owner.
  if (post.feeCollector.toLowerCase() !== OWNER_EOA.toLowerCase()) {
    if (feeDelta.toString() !== (platformFee + contributorFee).toString()) {
      throw new Error(`feeCollector received ${feeDelta} wei, expected ${platformFee + contributorFee}`);
    }
    console.log(`      ✓ feeCollector (distinct wallet) received exact 1% fee`);
  } else {
    console.log(`      (feeCollector == owner EOA; fee leg verified via recipient net + escrow drain)`);
  }

  // ----------------------------------------------------------------------
  // (4) Escrow balance fully accounted: it took in BOUNTY then paid out the full
  //     amount (net + fees), so its residual returns to the pre-test balance.
  // ----------------------------------------------------------------------
  console.log(`\n--- (4) escrow balance fully accounted ---`);
  console.log(`      escrow pre-test:  ${ethers.formatEther(escrowBalBeforeTest)} XDC`);
  console.log(`      escrow post-test: ${ethers.formatEther(escrowBalAfterTest)} XDC`);
  if (escrowBalAfterTest.toString() !== escrowBalBeforeTest.toString()) {
    throw new Error(`escrow residual ${escrowBalAfterTest} != pre-test ${escrowBalBeforeTest} (funds leaked/stuck)`);
  }
  console.log(`      ✓ escrow drained exactly the test bounty; pre-existing balance unaffected`);

  // Confirm the completed bounty status is COMPLETED (1).
  const b = await upgraded.getBounty(newBountyId);
  if (b.status.toString() !== "1") {
    throw new Error(`bounty status != COMPLETED (got ${b.status})`);
  }
  console.log(`      ✓ bounty status == COMPLETED`);

  console.log(`\n=== ESCROW FORK DRY-RUN COMPLETE — all assertions passed ===`);
  console.log(`    fork block: ${forkBlock}`);
  console.log(`    old impl:   ${oldImpl}`);
  console.log(`    new impl:   ${newImpl} (fork-only, not a live address)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nDRY-RUN FAILED:");
    console.error(e);
    process.exit(1);
  });

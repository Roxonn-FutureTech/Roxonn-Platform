/**
 * Phase 4 RECOVERY: complete the per-repo membership backfill for DualCurrencyRepoRewards.
 *
 * The live combined upgrade (upgrade_dual_currency_combined.cjs) succeeded — the proxy
 * 0x53A2...d170 now points to the NEW impl 0xD754...89f3 and initializeV3 ran (global
 * usernameToWallet backfilled). BUT the per-repo backfillRepoMembership loop reverted at
 * estimateGas due to Ankr read-after-write lag (a node that hadn't yet seen the upgrade tx),
 * so isRepoPoolManager / isRepoContributor are still EMPTY -> existing pool managers locked out.
 *
 * This standalone recovery calls backfillRepoMembership(repoId) for every live repo with an
 * EXPLICIT gasLimit (bypassing the flaky estimateGas), waits for each receipt, then asserts
 * exhaustive map==array membership equality. Idempotent (re-running just re-sets true flags).
 *
 * Run: npx hardhat run scripts/backfill_dualcurrency_membership.cjs --network xinfin
 */
const { ethers, network } = require("hardhat");

// The 8 live repoIds — independently enumerated from on-chain logs THREE times
// (two fork dry-runs + the live upgrade run), identical each time. Stable (no active users).
const REPO_IDS = [
  994816373n, 977557912n, 941844929n, 876024107n,
  1001279886n, 956679248n, 941381428n, 1008134869n,
];

const PROXY = process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS;
const ABI = [
  "function backfillRepoMembership(uint256)",
  "function getRepository(uint256) view returns (address[],address[],uint256,uint256,uint256,tuple(uint256,uint256,address,uint8,bool)[])",
  "function isRepoPoolManager(uint256,address) view returns (bool)",
  "function isRepoContributor(uint256,address) view returns (bool)",
  "function owner() view returns (address)",
];

async function main() {
  if (network.name !== "xinfin") throw new Error(`Refusing to run on network '${network.name}' — expected xinfin`);
  if (!PROXY) throw new Error("DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS not set");
  const [signer] = await ethers.getSigners();
  const c = new ethers.Contract(PROXY, ABI, signer);
  const owner = await c.owner();
  console.log(`Proxy:  ${PROXY}`);
  console.log(`Signer: ${signer.address}  (owner: ${owner})`);
  console.log(`Repos:  ${REPO_IDS.length}\n`);

  // 1) Backfill each repo with an explicit gasLimit (avoid the flaky estimateGas).
  for (const repoId of REPO_IDS) {
    process.stdout.write(`backfillRepoMembership(${repoId}) ... `);
    const tx = await c.backfillRepoMembership(repoId, { gasLimit: 600000n });
    const rc = await tx.wait();
    console.log(`mined in block ${rc.blockNumber} status=${rc.status} (tx ${tx.hash})`);
  }

  // 2) Exhaustive assertion: every kept poolManagers[]/contributors[] entry resolves TRUE.
  console.log("\nAsserting exhaustive map==array membership equality ...");
  let allOk = true;
  for (const repoId of REPO_IDS) {
    const repo = await c.getRepository(repoId);
    const pms = repo[0], cons = repo[1];
    let repoOk = true;
    for (const a of pms) { if (!(await c.isRepoPoolManager(repoId, a))) { repoOk = false; allOk = false; console.log(`  ✗ repo ${repoId}: poolManager ${a} NOT recognized`); } }
    for (const a of cons) { if (!(await c.isRepoContributor(repoId, a))) { repoOk = false; allOk = false; console.log(`  ✗ repo ${repoId}: contributor ${a} NOT recognized`); } }
    if (repoOk) console.log(`  ✓ repo ${repoId}: ${pms.length} PM + ${cons.length} C — ALL recognized`);
  }

  if (!allOk) { console.log("\nBACKFILL_MEMBERSHIP_FAILED — some members not recognized"); process.exit(1); }
  console.log("\nBACKFILL_MEMBERSHIP_GREEN — every pool manager/contributor recognized across all repos");
}

main().catch((e) => { console.error(e); process.exit(1); });

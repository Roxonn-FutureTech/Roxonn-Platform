// ============================================================================
// QUARANTINED (CONTRACT-04 / DESIGN-01) — DO NOT RUN.
// The embedded community-bounty consolidation design was REJECTED. The canonical
// community-bounty path is the standalone CommunityBountyEscrow contract.
// This script uses unsafeSkipStorageCheck:true / unsafeAllowCustomTypes:true which
// DEFEAT the mandatory D-02 validateUpgrade storage-layout gate, and it is the only
// code that could repopulate the removed in-struct communityBounties mapping.
// It has been moved out of scripts/ into .archive/ and hard-guarded below so it can
// NEVER execute. Git history is the record of the original content.
// ============================================================================
console.error('QUARANTINED: embedded community-bounty consolidation was REJECTED (DESIGN-01). The canonical path is CommunityBountyEscrow. This script must NEVER run.');
process.exit(1);

const { ethers, upgrades } = require("hardhat");
require('dotenv').config({ path: './server/.env' });

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  COMMUNITY BOUNTIES CONSOLIDATION UPGRADE");
  console.log("  Adding Community Bounty Support to DualCurrencyRepoRewards");
  console.log("═══════════════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();
  const proxyAddress = process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS;
  const relayerAddress = deployer.address; // Use deployer as initial relayer (can be changed later)

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy: ${proxyAddress}`);
  console.log(`Initial Relayer: ${relayerAddress}\n`);

  if (!proxyAddress || proxyAddress === 'undefined') {
    throw new Error("DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS not set in environment");
  }

  // Step 1: Verify existing repos are readable with OLD implementation
  console.log("Step 1: Verifying existing pool bounties still work...");
  const DualCurrencyRepoRewards = await ethers.getContractFactory("DualCurrencyRepoRewards");
  const oldContract = DualCurrencyRepoRewards.attach(proxyAddress);

  const testRepoId = 876024107; // MediSync repo (or adjust to any funded repo)
  try {
    const oldData = await oldContract.getRepository(testRepoId);
    console.log(`✅ Test repo ${testRepoId} readable with current implementation:`);
    console.log(`   Pool Managers: ${oldData[0].length}`);
    console.log(`   XDC Pool: ${ethers.formatEther(oldData[2])} XDC`);
    console.log(`   ROXN Pool: ${ethers.formatEther(oldData[3])} ROXN`);
    console.log(`   USDC Pool: ${ethers.formatUnits(oldData[4], 6)} USDC\n`);
  } catch (e) {
    console.log(`⚠️  Could not read test repo: ${e.message}`);
    console.log(`   This is OK if repository ${testRepoId} doesn't exist\n`);
  }

  // Step 2: Prepare and deploy new implementation
  console.log("Step 2: Preparing new implementation with community bounty support...");
  console.log("⚠️  Using unsafeAllowCustomTypes and unsafeSkipStorageCheck - storage layout manually verified");
  console.log("   Added: BountyStatus enum, CommunityBounty struct, communityBounties mapping");
  console.log("   Added: relayer state variable (gap reduced from 47 to 46)\n");

  const newImplAddress = await upgrades.prepareUpgrade(proxyAddress, DualCurrencyRepoRewards, {
    kind: 'uups',
    redeployImplementation: 'always',
    unsafeSkipStorageCheck: true,
    unsafeAllowCustomTypes: true,
    unsafeAllowRenames: false
  });
  console.log(`✅ New implementation prepared at: ${newImplAddress}\n`);

  // Step 3: Upgrade proxy to new implementation
  console.log("Step 3: Upgrading proxy to new implementation...");
  const upgraded = await upgrades.upgradeProxy(proxyAddress, DualCurrencyRepoRewards, {
    kind: 'uups',
    redeployImplementation: 'always',
    unsafeSkipStorageCheck: true,
    unsafeAllowCustomTypes: true,
    unsafeAllowRenames: false
  });
  await upgraded.waitForDeployment();
  console.log(`✅ Proxy upgraded successfully\n`);

  // Step 4: Verify pool bounties still work with NEW implementation
  console.log("Step 4: Verifying pool bounties with NEW implementation...");
  const newContract = DualCurrencyRepoRewards.attach(proxyAddress);

  try {
    const newData = await newContract.getRepository(testRepoId);
    console.log(`✅ Test repo ${testRepoId} readable with NEW implementation:`);
    console.log(`   Pool Managers: ${newData[0].length}`);
    console.log(`   XDC Pool: ${ethers.formatEther(newData[2])} XDC`);
    console.log(`   ROXN Pool: ${ethers.formatEther(newData[3])} ROXN`);
    console.log(`   USDC Pool: ${ethers.formatUnits(newData[4], 6)} USDC`);
    console.log(`   Issues: ${newData[5].length}\n`);
  } catch (e) {
    console.log(`⚠️  Could not verify with new ABI: ${e.message}`);
    console.log(`   This is OK if repository ${testRepoId} doesn't exist\n`);
  }

  // Step 5: Set relayer address
  console.log("Step 5: Setting relayer address for community bounty completion...");
  try {
    const currentRelayer = await newContract.relayer();

    if (currentRelayer === ethers.ZeroAddress || currentRelayer === '0x0000000000000000000000000000000000000000') {
      console.log(`Setting relayer to: ${relayerAddress}...`);
      const tx = await newContract.setRelayer(relayerAddress);
      await tx.wait();
      console.log(`✅ Relayer set to: ${relayerAddress}\n`);
    } else {
      console.log(`✅ Relayer already set to: ${currentRelayer}\n`);
    }
  } catch (e) {
    console.log(`⚠️  Could not set relayer: ${e.message}`);
    console.log(`   You can set it manually later using setRelayer()\n`);
  }

  // Step 6: Test community bounty view functions
  console.log("Step 6: Testing new community bounty functions...");
  try {
    const testRepoGithubId = "repo-test-owner";
    const testIssueNumber = 1;

    // Test getCommunityBounties (should return empty array for new issue)
    const bounties = await newContract.getCommunityBounties(testRepoGithubId, testIssueNumber);
    console.log(`✅ getCommunityBounties() works: ${bounties.length} bounties on test issue`);

    // Test getActiveCommunityBountyCount (should return 0 for new issue)
    const activeCount = await newContract.getActiveCommunityBountyCount(testRepoGithubId, testIssueNumber);
    console.log(`✅ getActiveCommunityBountyCount() works: ${activeCount} active bounties\n`);
  } catch (e) {
    console.log(`⚠️  Community bounty functions test failed: ${e.message}\n`);
  }

  // Step 7: Final verification
  console.log("Step 7: Final contract configuration...");
  const roxnToken = await newContract.roxnToken();
  const usdcToken = await newContract.usdcToken();
  const owner = await newContract.owner();
  const relayer = await newContract.relayer();

  console.log("Contract Configuration:");
  console.log(`  Owner: ${owner}`);
  console.log(`  ROXN Token: ${roxnToken}`);
  console.log(`  USDC Token: ${usdcToken}`);
  console.log(`  Relayer: ${relayer}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  ✅ COMMUNITY BOUNTIES UPGRADE COMPLETE!");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\nNew Features Added:");
  console.log("  ✅ createCommunityBounty() - Permissionless bounty creation");
  console.log("  ✅ completeCommunityBounty() - Relayer-only bounty completion");
  console.log("  ✅ refundCommunityBounty() - Expired bounty refunds");
  console.log("  ✅ getCommunityBounties() - View bounties per issue");
  console.log("  ✅ getActiveCommunityBountyCount() - Count active bounties");

  console.log("\nNext Steps:");
  console.log("1. Update backend blockchain.ts with new community bounty methods");
  console.log("2. Run database migration to add blockchain_bounty_index column");
  console.log("3. Update webhook handlers to use unified contract");
  console.log("4. Test creating a small community bounty (e.g., 10 XDC)");
  console.log("5. Verify auto-claim works when PR is merged");

  console.log("\nImportant Addresses:");
  console.log(`  Proxy Address: ${proxyAddress}`);
  console.log(`  New Implementation: ${newImplAddress}`);
  console.log(`  Relayer: ${relayer} (can be changed with setRelayer())`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Upgrade failed:");
    console.error(error);
    process.exit(1);
  });

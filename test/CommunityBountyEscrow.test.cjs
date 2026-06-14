/*
 * ============================================================================
 * CommunityBountyEscrow — Hardhat contract tests
 * TEST-02 / D-07: First Hardhat test suite in this repo (greenfield).
 * Covers: completeBounty happy path, duplicate, expiry, onlyRelayer, fee math.
 * ============================================================================
 *
 * FEE-RATE MISMATCH — FILE FOR PHASE 4 (D-08)
 * ============================================================================
 * CONTRACT RATE (source of truth used by ALL assertions in this file):
 *   platformFeeRate   = 50 basis points = 0.5%
 *   contributorFeeRate = 50 basis points = 0.5%
 *   total fee = 1 %    net to contributor = 99 % of bounty.amount
 *
 * BACKEND RATE (server/storage.ts → calculateBountyFees, as also mocked in
 * server/routes/__tests__/payoutMapper.test.ts line 9):
 *   clientFee      = base * 0.025  → 2.5 %
 *   contributorFee = base * 0.025  → 2.5 %
 *   total fee = 5 %    net to contributor = 97.5 % of base
 *
 * DISAGREEMENT: The backend computes ~5x higher fees than the contract charges.
 * This is a BUG. It is NOT fixed here. Route to Phase 4 contract-hardening /
 * backlog for resolution. All fee assertions in this file are derived from
 * the contract's own on-chain platformFeeRate() / contributorFeeRate() getters
 * — never from a hardcoded 2.5% or any backend constant.
 * ============================================================================
 */

"use strict";

const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Helper: Deploy a fresh CommunityBountyEscrow proxy.
 *
 * initialize(roxnToken, usdcToken, relayer, feeCollector) — this exact order
 * is critical; the initializer rejects address(0) for all four args.
 *
 * For XDC-only tests we never touch the token contracts, so we pass two
 * distinct non-zero signer addresses as placeholder token addresses.  The
 * initializer only validates "not zero address" — it does NOT call the token
 * contracts at init time.
 */
async function deployEscrow(relayerAddr, feeCollectorAddr, roxnPlaceholder, usdcPlaceholder) {
  const Factory = await ethers.getContractFactory("CommunityBountyEscrow");
  const proxy = await upgrades.deployProxy(
    Factory,
    [roxnPlaceholder, usdcPlaceholder, relayerAddr, feeCollectorAddr],
    { initializer: "initialize" }
  );
  await proxy.waitForDeployment();
  return proxy;
}

describe("CommunityBountyEscrow", function () {
  // Use explicit timeout — proxy compilation can be slow on first run.
  this.timeout(60_000);

  let escrow;
  let owner, relayer, creator, contributor, feeCollector, other, tokenPlaceholder;

  // Bounty amount: 1 XDC (in wei)
  const BOUNTY_AMOUNT = ethers.parseEther("1");
  // CurrencyType.XDC = 0
  const XDC = 0;
  // No expiry constant
  const NO_EXPIRY = 0n;

  beforeEach(async function () {
    [owner, relayer, creator, contributor, feeCollector, other, tokenPlaceholder] =
      await ethers.getSigners();

    // Deploy proxy.  roxnToken and usdcToken must be non-zero; use two
    // distinct signer addresses as placeholders (XDC tests never call them).
    escrow = await deployEscrow(
      relayer.address,
      feeCollector.address,
      other.address,           // roxnToken placeholder (non-zero)
      tokenPlaceholder.address // usdcToken placeholder (non-zero)
    );
  });

  // ============================================================================
  // Helper: create an ACTIVE XDC bounty with optional expiresAt.
  // Returns the bountyId (always 1 for the first bounty after a fresh deploy).
  // ============================================================================
  async function createActiveBounty(expiresAt) {
    const tx = await escrow
      .connect(creator)
      .createBounty(BOUNTY_AMOUNT, XDC, expiresAt, { value: BOUNTY_AMOUNT });

    // Parse BountyCreated event to get the bountyId.
    const receipt = await tx.wait();
    const iface = escrow.interface;
    let bountyId;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "BountyCreated") {
          bountyId = parsed.args.bountyId;
          break;
        }
      } catch (_) {
        // not this contract's event — skip
      }
    }
    if (bountyId === undefined) {
      throw new Error("BountyCreated event not found");
    }
    return bountyId;
  }

  // ============================================================================
  // CASE 1 — HAPPY PATH
  // ============================================================================
  describe("completeBounty — happy path", function () {
    it("pays contributor the net amount and feeCollector the total fee", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      // Read fee rates from the contract (D-08: source of truth = on-chain getters).
      const pRate = await escrow.platformFeeRate();
      const cRate = await escrow.contributorFeeRate();

      const expectedPlatformFee = (BOUNTY_AMOUNT * pRate) / 10000n;
      const expectedContributorFee = (BOUNTY_AMOUNT * cRate) / 10000n;
      const expectedNet = BOUNTY_AMOUNT - expectedPlatformFee - expectedContributorFee;

      // Assert ETH balance changes.
      await expect(
        escrow.connect(relayer).completeBounty(bountyId, contributor.address)
      ).to.changeEtherBalances(
        [contributor, feeCollector],
        [expectedNet, expectedPlatformFee + expectedContributorFee]
      );
    });

    it("emits BountyCompleted with correct args", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      const pRate = await escrow.platformFeeRate();
      const cRate = await escrow.contributorFeeRate();
      const expectedPlatformFee = (BOUNTY_AMOUNT * pRate) / 10000n;
      const expectedContributorFee = (BOUNTY_AMOUNT * cRate) / 10000n;
      const expectedNet = BOUNTY_AMOUNT - expectedPlatformFee - expectedContributorFee;

      await expect(
        escrow.connect(relayer).completeBounty(bountyId, contributor.address)
      )
        .to.emit(escrow, "BountyCompleted")
        .withArgs(
          bountyId,
          contributor.address,
          BOUNTY_AMOUNT,
          expectedPlatformFee,
          expectedContributorFee,
          expectedNet
        );
    });
  });

  // ============================================================================
  // CASE 2 — DUPLICATE (second completeBounty on already-completed bounty)
  // ============================================================================
  describe("completeBounty — duplicate", function () {
    it("reverts with 'Bounty not active' on a second completion", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      // First completion — should succeed.
      await escrow.connect(relayer).completeBounty(bountyId, contributor.address);

      // Second completion — must revert because status is now COMPLETED.
      await expect(
        escrow.connect(relayer).completeBounty(bountyId, contributor.address)
      ).to.be.revertedWith("Bounty not active");
    });
  });

  // ============================================================================
  // CASE 3 — EXPIRY
  // ============================================================================
  describe("completeBounty — expiry", function () {
    it("reverts with 'Bounty expired' when block.timestamp > expiresAt", async function () {
      const now = BigInt(await time.latest());
      const expiresAt = now + 3600n; // expires 1 hour in the future

      const bountyId = await createActiveBounty(expiresAt);

      // Advance time past expiry.
      await time.increaseTo(Number(expiresAt) + 1);

      await expect(
        escrow.connect(relayer).completeBounty(bountyId, contributor.address)
      ).to.be.revertedWith("Bounty expired");
    });

    it("succeeds before expiry", async function () {
      const now = BigInt(await time.latest());
      const expiresAt = now + 3600n;

      const bountyId = await createActiveBounty(expiresAt);

      // Still within expiry window — should not revert.
      await expect(
        escrow.connect(relayer).completeBounty(bountyId, contributor.address)
      ).to.not.be.reverted;
    });
  });

  // ============================================================================
  // CASE 4 — ONLYRELAYER AUTHORIZATION
  // ============================================================================
  describe("completeBounty — onlyRelayer", function () {
    it("reverts with 'Only relayer can call' when caller is not the relayer", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      // creator is NOT the relayer — must revert with exact modifier message.
      await expect(
        escrow.connect(creator).completeBounty(bountyId, contributor.address)
      ).to.be.revertedWith("Only relayer can call");
    });

    it("reverts for owner (not relayer) as well", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      await expect(
        escrow.connect(owner).completeBounty(bountyId, contributor.address)
      ).to.be.revertedWith("Only relayer can call");
    });
  });

  // ============================================================================
  // CASE 5 — FEE MATH (D-08)
  //
  // Source of truth: the contract's on-chain platformFeeRate() and
  // contributorFeeRate() getters.  NO hardcoded 2.5% or 0.025 anywhere.
  // The backend's calculateBountyFees (5% total) DISAGREES with the contract
  // (1% total) — that discrepancy is documented above and routed to Phase 4.
  // ============================================================================
  describe("completeBounty — fee math (D-08)", function () {
    it("platformFee + contributorFee + netAmount === bounty.amount (integer invariant)", async function () {
      const bountyId = await createActiveBounty(NO_EXPIRY);

      // Read on-chain fee rates — the contract is the source of truth.
      const pRate = await escrow.platformFeeRate();   // 50 bps = 0.5%
      const cRate = await escrow.contributorFeeRate(); // 50 bps = 0.5%

      const expectedPlatformFee    = (BOUNTY_AMOUNT * pRate)  / 10000n;
      const expectedContributorFee = (BOUNTY_AMOUNT * cRate)  / 10000n;
      const expectedNet            = BOUNTY_AMOUNT - expectedPlatformFee - expectedContributorFee;

      // The sum must equal the full bounty amount (no rounding leakage).
      expect(expectedPlatformFee + expectedContributorFee + expectedNet).to.equal(BOUNTY_AMOUNT);

      // Emit and capture event args to verify contract uses the same math.
      const tx = await escrow.connect(relayer).completeBounty(bountyId, contributor.address);
      const receipt = await tx.wait();

      const iface = escrow.interface;
      let eventArgs;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === "BountyCompleted") {
            eventArgs = parsed.args;
            break;
          }
        } catch (_) { /* skip */ }
      }
      expect(eventArgs, "BountyCompleted event not found").to.not.be.undefined;

      expect(eventArgs.platformFee).to.equal(expectedPlatformFee);
      expect(eventArgs.contributorFee).to.equal(expectedContributorFee);
      expect(eventArgs.netAmount).to.equal(expectedNet);
      expect(eventArgs.amount).to.equal(BOUNTY_AMOUNT);
    });

    it("fee rates are 50bps each (0.5% + 0.5% = 1% total) per contract state", async function () {
      // Verify the actual on-chain rates match the documented contract constants.
      const pRate = await escrow.platformFeeRate();
      const cRate = await escrow.contributorFeeRate();
      expect(pRate).to.equal(50n);
      expect(cRate).to.equal(50n);
    });
  });
});

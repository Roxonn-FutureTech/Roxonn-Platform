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

  // ============================================================================
  // CASE 6 — CONTRACT/MULTISIG RECIPIENT (ESCROW-02)
  //
  // Proves the escrow's .call payouts/refunds reach a CONTRACT recipient. A
  // .transfer (2300 gas) would brick a contract whose receive() does any work
  // (here it does SSTORE + emit). Tests BOTH completeBounty and refundBounty.
  // ============================================================================
  describe("contract/multisig recipient (.call vs .transfer) — ESCROW-02", function () {
    it("completeBounty pays a contract recipient via .call", async function () {
      const Recipient = await ethers.getContractFactory("ContractRecipient");
      const recipient = await Recipient.deploy(await escrow.getAddress());
      await recipient.waitForDeployment();
      const recipientAddr = await recipient.getAddress();

      const bountyId = await createActiveBounty(NO_EXPIRY);

      const pRate = await escrow.platformFeeRate();
      const cRate = await escrow.contributorFeeRate();
      const expectedNet =
        BOUNTY_AMOUNT -
        (BOUNTY_AMOUNT * pRate) / 10000n -
        (BOUNTY_AMOUNT * cRate) / 10000n;

      // Must NOT revert and the contract recipient must actually receive funds.
      await expect(
        escrow.connect(relayer).completeBounty(bountyId, recipientAddr)
      ).to.changeEtherBalance(recipient, expectedNet);

      expect(await recipient.total()).to.equal(expectedNet);
    });

    it("refundBounty refunds a CONTRACT creator via .call after expiry", async function () {
      // A contract is the creator: it creates + funds the bounty, then reclaims
      // after expiry. .transfer would brick its working receive(); .call succeeds.
      const Recipient = await ethers.getContractFactory("ContractRecipient");
      const creatorContract = await Recipient.deploy(await escrow.getAddress());
      await creatorContract.waitForDeployment();
      const creatorAddr = await creatorContract.getAddress();

      // Fund the creator-contract so it can pay the bounty value into escrow.
      await creatorContract.fund({ value: BOUNTY_AMOUNT });

      const now = BigInt(await time.latest());
      const expiresAt = now + 3600n;

      // Contract creates + funds the bounty (becomes the on-chain creator).
      const createTx = await creatorContract.createXdcBounty(BOUNTY_AMOUNT, expiresAt);
      await createTx.wait();
      const bountyId = 1n; // first bounty on a fresh escrow

      // Advance past expiry, then the contract reclaims its funds via .call refund.
      await time.increaseTo(Number(expiresAt) + 1);

      await expect(
        creatorContract.doRefund(bountyId)
      ).to.changeEtherBalance(creatorContract, BOUNTY_AMOUNT);

      const bounty = await escrow.getBounty(bountyId);
      expect(bounty.status).to.equal(2); // REFUNDED
    });
  });

  // ============================================================================
  // CASE 7 — REENTRANCY ATTACKER REVERTS (ESCROW-02)
  //
  // A contract recipient/creator that re-enters completeBounty/refundBounty from
  // receive() must be rejected by CEI (status set before transfer) + nonReentrant.
  // ============================================================================
  describe("reentrancy attacker revert — ESCROW-02", function () {
    it("completeBounty reverts when the recipient re-enters", async function () {
      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      const bountyId = await createActiveBounty(NO_EXPIRY);
      // re-enter completeBounty on the SAME bounty
      await attacker.setTarget(bountyId, true);

      // The re-entrant completeBounty call hits nonReentrant -> reverts; the outer
      // payout require(okContributor) then fails -> whole tx reverts.
      await expect(
        escrow.connect(relayer).completeBounty(bountyId, attackerAddr)
      ).to.be.reverted;

      // Bounty must remain claimable (status not stuck COMPLETED with funds gone).
      const bounty = await escrow.getBounty(bountyId);
      expect(bounty.status).to.equal(0); // ACTIVE
    });

    it("refundBounty reverts when the creator contract re-enters", async function () {
      // Attacker is the CREATOR: it funds a bounty then re-enters refundBounty
      // from its receive() when the refund .call lands.
      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await escrow.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Fund the attacker so it can create + fund the bounty.
      await attacker.fund({ value: BOUNTY_AMOUNT * 2n });

      const now = BigInt(await time.latest());
      const expiresAt = now + 3600n;

      // Attacker creates + funds the bounty (becomes the creator).
      const createTx = await attacker.createXdcBounty(BOUNTY_AMOUNT, expiresAt);
      await createTx.wait();
      const bountyId = 1n;

      // Arm re-entry of refundBounty, advance past expiry.
      await attacker.setTarget(bountyId, false); // false => re-enter refundBounty
      await time.increaseTo(Number(expiresAt) + 1);

      // The refund .call triggers attacker.receive() -> re-entrant refundBounty
      // hits nonReentrant -> reverts; outer require(okRefund) fails -> whole tx reverts.
      await expect(attacker.doRefund(bountyId)).to.be.reverted;

      // Funds must NOT have left the escrow; bounty stays ACTIVE.
      const bounty = await escrow.getBounty(bountyId);
      expect(bounty.status).to.equal(0); // ACTIVE
    });
  });

  // ============================================================================
  // CASE 8 — FEE-ON-TRANSFER ERC20: stored amount == received (ESCROW-06)
  // ============================================================================
  describe("fee-on-transfer ERC20 stored==received — ESCROW-06", function () {
    const ROXN = 1; // CurrencyType.ROXN

    it("createBounty stores the tokens ACTUALLY received, not the requested amount", async function () {
      // Deploy a 10% fee-on-transfer token; owner mints the full supply.
      const FOT = await ethers.getContractFactory("FeeOnTransferToken");
      const fot = await FOT.deploy(1000n); // 10% fee
      await fot.waitForDeployment();
      const fotAddr = await fot.getAddress();

      // Re-deploy escrow with the FOT as the ROXN token so currency=ROXN routes to it.
      const escrowFot = await deployEscrow(
        relayer.address,
        feeCollector.address,
        fotAddr,                 // roxnToken = fee-on-transfer token
        tokenPlaceholder.address // usdcToken placeholder
      );
      const escrowFotAddr = await escrowFot.getAddress();

      const requested = ethers.parseEther("100");
      const fee = (requested * 1000n) / 10000n; // 10%
      const expectedReceived = requested - fee;

      // Give creator generously more than `requested` (FOT burns a fee on each
      // transfer, so over-fund), then approve EXACTLY the requested amount.
      await fot.transfer(creator.address, requested * 3n);
      await fot.connect(creator).approve(escrowFotAddr, requested);

      const tx = await escrowFot
        .connect(creator)
        .createBounty(requested, ROXN, NO_EXPIRY);
      const receipt = await tx.wait();

      // Parse BountyCreated -> stored amount must equal RECEIVED (requested - fee).
      const iface = escrowFot.interface;
      let createdAmount;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === "BountyCreated") {
            createdAmount = parsed.args.amount;
            break;
          }
        } catch (_) { /* skip */ }
      }
      expect(createdAmount, "BountyCreated not found").to.not.be.undefined;
      expect(createdAmount).to.equal(expectedReceived);

      // And the stored bounty struct reflects the received amount.
      const bounty = await escrowFot.getBounty(1);
      expect(bounty.amount).to.equal(expectedReceived);
    });
  });

  // ============================================================================
  // CASE 9 — renounceOwnership reverts (CONTRACT-05)
  // ============================================================================
  describe("renounceOwnership disabled — CONTRACT-05", function () {
    it("reverts with 'Renounce disabled' for the owner", async function () {
      await expect(escrow.connect(owner).renounceOwnership()).to.be.revertedWith(
        "Renounce disabled"
      );
    });
  });

  // ============================================================================
  // CASE 10 — bare implementation initialize() reverts (ESCROW-03)
  // ============================================================================
  describe("bare-impl initialize() reverts (_disableInitializers) — ESCROW-03", function () {
    it("calling initialize() directly on a freshly-deployed impl reverts", async function () {
      const Impl = await ethers.getContractFactory("CommunityBountyEscrow");
      const impl = await Impl.deploy(); // bare implementation (constructor disables init)
      await impl.waitForDeployment();

      await expect(
        impl.initialize(
          other.address,
          tokenPlaceholder.address,
          relayer.address,
          feeCollector.address
        )
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  // ============================================================================
  // CASE 11 — STORAGE-SAFETY HARNESS (RC-6 / FIX 4)
  //
  // Exercises validateUpgrade against the MATERIALIZED frozen V1 baseline (NOT a
  // same-name self-compare) + an executed negative control. While the gate-only
  // contracts/baseline/ sources exist (Task 1), these run with real factories;
  // after Task 3 deletes them, the suite skips gracefully.
  // ============================================================================
  describe("validateUpgrade storage-safety harness — RC-6 / FIX 4", function () {
    async function baselinePresent() {
      try {
        await ethers.getContractFactory("CommunityBountyEscrowV1");
        await ethers.getContractFactory("CommunityBountyEscrow_BROKEN");
        return true;
      } catch (_) {
        return false;
      }
    }

    it("PASSES validateUpgrade(CommunityBountyEscrowV1 -> CommunityBountyEscrow)", async function () {
      if (!(await baselinePresent())) {
        this.skip(); // baselines deleted post-gate (Task 3)
        return;
      }
      const V1 = await ethers.getContractFactory("CommunityBountyEscrowV1");
      const NEW = await ethers.getContractFactory("CommunityBountyEscrow");
      await expect(
        upgrades.validateUpgrade(V1, NEW, {
          kind: "uups",
          unsafeAllow: ["constructor", "missing-initializer-call"],
        })
      ).to.not.be.rejected;
    });

    it("NEGATIVE CONTROL: validateUpgrade(CommunityBountyEscrowV1 -> CommunityBountyEscrow_BROKEN) THROWS", async function () {
      if (!(await baselinePresent())) {
        this.skip();
        return;
      }
      const V1 = await ethers.getContractFactory("CommunityBountyEscrowV1");
      const BROKEN = await ethers.getContractFactory("CommunityBountyEscrow_BROKEN");
      await expect(
        upgrades.validateUpgrade(V1, BROKEN, {
          kind: "uups",
          unsafeAllow: ["constructor", "missing-initializer-call"],
        })
      ).to.be.rejected;
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ContributionCertificate", function () {
    let certificate;
    let owner;
    let otherAccount;

    beforeEach(async function () {
        [owner, otherAccount] = await ethers.getSigners();
        const ContributionCertificate = await ethers.getContractFactory("ContributionCertificate");
        certificate = await ContributionCertificate.deploy(owner.address);
        await certificate.waitForDeployment();
    });

    it("Should allow owner to mint certificates", async function () {
        const uri = "ipfs://test-metadata";
        await certificate.mintCertificate(otherAccount.address, uri);

        expect(await certificate.ownerOf(0)).to.equal(otherAccount.address);
        expect(await certificate.tokenURI(0)).to.equal(uri);
    });

    it("Should be soulbound (prevents transfer)", async function () {
        const uri = "ipfs://test-metadata";
        await certificate.mintCertificate(otherAccount.address, uri);

        // Other account tries to transfer to owner
        await expect(
            certificate.connect(otherAccount).transferFrom(otherAccount.address, owner.address, 0)
        ).to.be.revertedWith("ContributionCertificate: Soulbound token - transfer not allowed");
    });

    it("Should revert when non-owner tries to mint", async function () {
        const uri = "ipfs://test-metadata-fake";
        await expect(
            certificate.connect(otherAccount).mintCertificate(otherAccount.address, uri)
        ).to.be.reverted; // Reverted with Ownable error
    });

    it("Should increment token IDs correctly", async function () {
        await certificate.mintCertificate(otherAccount.address, "uri1");
        await certificate.mintCertificate(otherAccount.address, "uri2");
        expect(await certificate.ownerOf(0)).to.equal(otherAccount.address);
        expect(await certificate.ownerOf(1)).to.equal(otherAccount.address);
    });
});

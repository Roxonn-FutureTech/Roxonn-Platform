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
});

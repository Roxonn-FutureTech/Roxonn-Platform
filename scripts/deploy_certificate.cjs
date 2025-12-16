const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying ContributionCertificate with account:", deployer.address);

    // Deploying the contract
    const ContributionCertificate = await hre.ethers.getContractFactory("ContributionCertificate");
    const cert = await ContributionCertificate.deploy(deployer.address);

    console.log("Waiting for deployment transaction...");
    await cert.waitForDeployment();

    const address = await cert.getAddress();
    console.log(`ContributionCertificate deployed to: ${address}`);

    // Optional: Verify contract if on a live network (skipped for testnet/local loop here usually)
    console.log("To verify execute: npx hardhat verify --network <network> " + address + " " + deployer.address);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

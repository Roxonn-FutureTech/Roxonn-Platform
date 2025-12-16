const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying ContributionCertificate with account:", deployer.address);

    // Get chain ID to determine gas price
    const network = await hre.ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    let gasPrice;
    if (chainId === 50) {
        // XDC Mainnet
        gasPrice = hre.ethers.parseUnits("25", "gwei");
    } else if (chainId === 51) {
        // XDC Apothem Testnet
        gasPrice = hre.ethers.parseUnits("25", "gwei");
    }

    // Deploying the contract
    const ContributionCertificate = await hre.ethers.getContractFactory("ContributionCertificate");
    const cert = await ContributionCertificate.deploy(deployer.address, gasPrice ? { gasPrice } : {});

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

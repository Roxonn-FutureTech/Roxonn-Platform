require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config({ path: './server/.env' }); // Keeps your existing .env path

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    // XDC mainnet fork (chain 50) for upgrade dry-run rehearsals.
    // Gated behind FORK_MAINNET=1 so the default `npx hardhat test` does NOT fork
    // (stays offline/deterministic). The per-chain hardforkHistory is MANDATORY:
    // without chains[50].hardforkHistory.shanghai=0, ALL EVM execution on the fork
    // (even a view call or the upgrade tx) reverts "no known hardfork for execution
    // on a historical block". XDC mainnet is post-Shanghai (EIP-1559 confirmed).
    hardhat: {
      chainId: 50,
      forking: {
        url: process.env.XDC_RPC_URL,
        blockNumber: 103780000,
        enabled: process.env.FORK_MAINNET === '1',
      },
      chains: {
        50: { hardforkHistory: { shanghai: 0 } },
      },
    },
    xdcTestnet: { // Keeping your existing testnet config
      url: process.env.XDC_RPC_URL_TESTNET || "https://rpc.apothem.network", // Using the primary Apothem RPC endpoint
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 51
    },
    // Using 'xinfin' as the name for mainnet as per your example,
    // and assuming XDC_RPC_URL from your .env is for mainnet.
    // If you have a specific MAINNET_PRIVATE_KEY, ensure it's set in .env
    xinfin: {
      url: process.env.XDC_RPC_URL || "https://rpc.xinfin.network",
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : (process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []),
      chainId: 50,
      gasPrice: 25000000000 // 25 gwei
    }
  },
  etherscan: {
    apiKey: {
      // Get your own API key from XDCScan
      xinfin: process.env.XDCSCAN_API_KEY || "",
      xdcTestnet: process.env.XDCSCAN_API_KEY || ""
    },
    customChains: [
      {
        network: "xdcTestnet", // Keep your existing testnet custom chain
        chainId: 51,
        urls: {
          apiURL: "https://api-testnet.xdcscan.com/api", // Using xdcscan for testnet too
          browserURL: "https://testnet.xdcscan.com/"
        }
      },
      {
        network: "xinfin", // This must match the network name above
        chainId: 50,
        urls: {
          apiURL: "https://api.xdcscan.com/api", // XDCScan mainnet API
          browserURL: "https://xdcscan.com/"
        }
      }
    ]
  },
  sourcify: { // Adding sourcify config as per Hardhat's recommendation
    enabled: false // You can set this to true if you want to try Sourcify
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./contracts/artifacts"
  }
};

# Roxonn Platform

### Earn Crypto for Open-Source Contributions

[![Live on XDC Mainnet](https://img.shields.io/badge/XDC-Mainnet-blue?style=for-the-badge&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA)](https://xdc.org)
[![GitHub Issues](https://img.shields.io/github/issues/Roxonn-FutureTech/Roxonn-Platform?style=for-the-badge)](https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

**[Launch App](https://app.roxonn.com)** | **[View Project Board](https://github.com/orgs/Roxonn-FutureTech/projects/17)** | **[Contributing Guide](CONTRIBUTING.md)**

---

## What is Roxonn?

Roxonn is a **decentralized platform that automatically pays developers in cryptocurrency** when their GitHub pull requests get merged. No invoices, no payment processors, no waiting - just code and compensation working in harmony.

### For Developers
- Browse repositories funded with crypto bounties
- Submit quality pull requests
- **Get paid automatically** when your PR is merged
- Supports **XDC, ROXN tokens, and USDC**

### For Project Maintainers (Pool Managers)
- Fund your repository with cryptocurrency
- Attract quality contributors instantly
- **Automatic reward distribution** via smart contracts
- Support for **public and private repositories**

---

## Why Roxonn?

| Problem | Roxonn Solution |
|---------|-----------------|
| Developers contribute for free | Automatic crypto payments on PR merge |
| Projects struggle to find contributors | Funded repos attract talent instantly |
| Payment processing is complex | Smart contracts handle everything |
| International payments are slow/expensive | XDC blockchain: sub-penny fees, 2-sec transactions |

---

## Quick Start

**Start Contributing:**
1. Visit [app.roxonn.com](https://app.roxonn.com)
2. Connect your GitHub account
3. Browse funded repositories
4. Submit PRs and earn crypto!

**Fund Your Repository:**
1. Register your repo on Roxonn
2. Fund with XDC, ROXN, or USDC
3. Watch contributors discover your project

---

## Technical Overview

## Architecture Overview

```mermaid
graph TB
    subgraph Frontend
        React[React Application]
        Web3[Web3 Integration]
        UI[UI Components]
    end

    subgraph Backend
        Express[Express Server]
        BlockchainService[Blockchain Service]
        AuthService[Auth Service]
        WalletService[Wallet Service]
        StorageService[Storage Service]
        PromotionService[Promotional Bounties Service]
    end

    subgraph Blockchain
        ROXNToken[ROXN Token Contract]
        RepoRewards[RepoRewards Contract]
        DualCurrencyRewards[Dual Currency Rewards Contract]
        CustomForwarder[Custom Forwarder]
    end

    subgraph External
        GitHub[GitHub OAuth]
        XDCNetwork[XDC Network]
        TatumAPI[Tatum API]
    end

    React --> Express
    Express --> BlockchainService
    Express --> AuthService
    Express --> WalletService
    Express --> StorageService
    Express --> PromotionService
    BlockchainService --> ROXNToken
    BlockchainService --> RepoRewards
    BlockchainService --> DualCurrencyRewards
    BlockchainService --> CustomForwarder
    WalletService --> TatumAPI
    AuthService --> GitHub
    ROXNToken --> XDCNetwork
    RepoRewards --> XDCNetwork
    DualCurrencyRewards --> XDCNetwork
    CustomForwarder --> XDCNetwork
```

## Implementation Details

### 1. Smart Contract Architecture
- **ROXNToken Contract**: ERC20/XRC20 token with role-based access control
  - Features pausable, burnable functionality
  - Implements maximum supply cap of 1 billion tokens
- **RepoRewards Contract**: Manages repository rewards and contribution tracking
  - Pool Managers: Can allocate rewards and manage repositories
  - Contributors: Can receive rewards for contributions
  - Uses a gas-efficient design with optimized storage
- **DualCurrencyRepoRewards Contract**: Advanced reward system supporting XDC, ROXN, and USDC currencies
  - Multi-currency support (XDC, ROXN, USDC)
  - Pool, Per-Submission, and Tiered reward models
  - Max submissions and expiration date support
  - Status management (DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED)
- **CustomForwarder Contract**: Meta-transaction implementation
  - Enables gas-less transactions for better user experience
  - Implements EIP-712 signature verification

### 2. Promotional Bounties Feature
- **Create Bounties**: Pool managers can create promotional bounties with custom reward amounts
- **Multi-Channel Support**: Support for Twitter/X, LinkedIn, YouTube, Blog, Discord, Reddit, and other promotional channels
- **Flexible Reward Types**: Choose between per-submission, pool, or tiered reward distribution
- **Submission Management**: Contributors can submit proof links for promotional activities
- **Review System**: Pool managers can review and approve/reject submissions
- **Multi-Currency Rewards**: Supports XDC, ROXN, and USDC as reward currencies
- **Max Submissions & Expiration**: Control the number of allowed submissions and set expiration dates
- **Status Tracking**: Full lifecycle management (DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED)

### 3. User Registration Flow
1. User authenticates via GitHub OAuth
2. System generates XDC wallet using Tatum API
3. Relayer wallet registers user on blockchain
4. User wallet details stored securely in database

### 4. Transaction Management
- **Relayer Wallet**:
  - Handles user registration transactions
  - Manages gas fees for onboarding
  - Uses dynamic gas pricing with network monitoring
- **User Wallet**:
  - Manages personal transactions (allocating funds, etc.)
  - Requires user signature for operations
  - Full control over funds and rewards

### 5. Security Features
- Secure wallet generation and storage
- Protected API endpoints
- Relayer wallet with limited permissions
- Transaction signing validation
- Gas price management for network stability
- AWS KMS integration for key management
- Server-side URL validation for all user-submitted links
- Rate limiting and CSRF protection

## Extended Functionality

The platform includes detailed specifications for:

1. **Token System**: Comprehensive ROXN token implementation ([details](docs/TOKEN_SPECIFICATION.md))
2. **Staking Mechanisms**: Multi-tiered staking with governance benefits ([details](docs/STAKING_IMPLEMENTATION.md))
3. **Governance Framework**: On-chain governance with proposal system ([details](docs/GOVERNANCE_SPECIFICATION.md))
4. **Anti-Gaming Protection**: Mechanisms to prevent reward system abuse ([details](docs/ANTI_GAMING_SYSTEM.md))
5. **Contract Upgradeability**: UUPS proxy pattern implementation ([details](docs/ROXN_CONTRACT_IMPLEMENTATION.md))
6. **Migration Strategy**: Token and system migration guidelines ([details](docs/MIGRATION_GUIDE.md))

## Technology Stack
- Frontend: React, TypeScript, Web3.js, Tailwind CSS
- Backend: Express, TypeScript, PostgreSQL, Drizzle ORM
- Blockchain: XDC Network (Apothem Testnet)
- Smart Contracts: Solidity, OpenZeppelin
- Wallet Management: Tatum API, AWS KMS
- Deployment: Docker, Nginx

## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables (see `.env.example`)
4. Run the development server: `npm run dev`

### Development Environment
```
# Backend
npm run dev:server

# Frontend
npm run dev:client

# Smart Contracts
npx hardhat compile
npx hardhat test
```

## Contributing
Contributions are welcome! Please read our contributing guidelines for details.

## License
This project is licensed under the MIT License.

## Partner Integration APIs

### User Registration Verification

This API allows partner platforms (like Rewards Bunny) to verify if a user has successfully registered on Roxonn.

**Endpoint:** `GET /api/partners/verify-registration`

**Query Parameters:**
- `apiKey` (required): Your partner API key
- `username` OR `githubId` (at least one required): Identifies the user to verify
  - `username`: The user's GitHub username
  - `githubId`: The user's GitHub ID

**Responses:**

- **Success (200):**
  ```json
  {
    "success": true,
    "verified": true,
    "message": "User is registered",
    "timestamp": "2023-06-08T12:34:56.789Z",
    "user": {
      "username": "johndoe",
      "githubId": "12345678",
      "registrationDate": "2023-06-01T10:20:30.456Z",
      "hasWallet": true
    }
  }
  ```

- **User exists but not fully registered (200):**
  ```json
  {
    "success": true,
    "verified": false,
    "message": "User exists but has not completed registration",
    "timestamp": "2023-06-08T12:34:56.789Z",
    "user": null
  }
  ```

- **User not found (404):**
  ```json
  {
    "success": false,
    "verified": false,
    "message": "User not found",
    "timestamp": "2023-06-08T12:34:56.789Z"
  }
  ```

- **Unauthorized (401):**
  ```json
  {
    "success": false,
    "error": "Unauthorized - Invalid or missing API key"
  }
  ```

- **Bad request (400):**
  ```json
  {
    "success": false,
    "error": "At least one user identifier (username or githubId) is required"
  }
  ```

**Integration Example:**

```javascript
// Sample Node.js code to verify a user
const axios = require('axios');

async function verifyUserRegistration(username) {
  try {
    const response = await axios.get('https://api.roxonn.com/api/partners/verify-registration', {
      params: {
        username: username,
        apiKey: 'your_partner_api_key'
      }
    });

    if (response.data.verified) {
      console.log('User has successfully registered on Roxonn!');
      return true;
    } else {
      console.log('User exists but has not completed registration');
      return false;
    }
  } catch (error) {
    console.error('Error verifying user:', error.response?.data || error.message);
    return false;
  }
}
```

### Security Considerations

- The partner API key should be kept confidential and never exposed in client-side code
- All requests should be made server-to-server
- We recommend implementing rate limiting on your side to prevent abuse
- For security and privacy reasons, only minimal user information is returned

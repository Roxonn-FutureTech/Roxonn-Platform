# 🚀 The Roxonn Developer's Flight Manual
**From Zero to Your First On-Chain Bounty in 15 Minutes.**

Welcome to the Roxonn FutureTech ecosystem. This guide is designed to get you up and running with the full-stack platform, from the TypeScript backend to the XDC smart contracts.

---

## 🏗️ 1. Architecture Overview
Before diving into the code, understand the flow:
- **Backend (Express + Drizzle ORM)**: Manages the business logic, GitHub OAuth, and database state.
- **Blockchain (XDC Network)**: Handles the `DualCurrencyRepoRewards` contract for USDC, ROXN, and XDC payouts.
- **Security (AWS KMS + Tatum)**: Ensures developer private keys are encrypted and managed securely.
- **AI Layer**: Integrated Azure OpenAI models for automated scoping and development assistance.

---

## 🛠️ 2. Local Environment Setup

### Prerequisites
- **Node.js 20+** (Recommended)
- **PostgreSQL** instance (Local or Neon.tech)
- **XDC Testnet Wallet** (Apothem Network)

### Step-by-Step Installation
1. **Clone the Repo**:
   ```bash
   git clone https://github.com/Roxonn-FutureTech/Roxonn-Platform.git
   cd Roxonn-Platform
   ```
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Database Initialization**:
   Roxonn uses Drizzle ORM. Push the schema to your local DB:
   ```bash
   npm run db:push
   ```
4. **Launch the Engines**:
   Run both the Vite frontend and Express backend simultaneously:
   ```bash
   npm run dev
   ```

---

## 🔑 3. Configuration (The .env Checklist)
Create `server/.env` from the example file, then fill in the values:
```bash
cp server/.env.example server/.env
```

The server calls `validateConfig()` on startup and **will throw if any required variable is missing**. Here is the full list:

| Variable | Purpose |
| :--- | :--- |
| `DATABASE_URL` | Your PostgreSQL connection string. |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID (Developer Settings). |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret. |
| `SESSION_SECRET` | Random string for Express session security. |
| `XDC_RPC_URL` | Use `https://erpc.apothem.network` for testnet. |
| `DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS` | The main rewards proxy address (or `REPO_REWARDS_CONTRACT_ADDRESS`). |
| `FORWARDER_CONTRACT_ADDRESS` | Meta-transaction forwarder contract address. |
| `PRIVATE_KEY` | Relayer wallet private key (for on-chain transactions). |
| `ENCRYPTION_KEY` | Key used to encrypt sensitive data at rest. |
| `BASE_URL` | Backend URL, e.g. `http://localhost:5000`. |
| `FRONTEND_URL` | Frontend URL, e.g. `http://localhost:5173`. |
| `GITHUB_APP_ID` | GitHub App ID (from GitHub App settings). |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM format). |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub App webhook secret. |
| `GITHUB_APP_NAME` | GitHub App name (slug). |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI API endpoint URL. |
| `AZURE_OPENAI_KEY` | Azure OpenAI API key. |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Azure OpenAI deployment/model name. |

> **Tip:** For a quick start, copy all values from `server/.env.example` and only change the secrets and DB URL. See `server/config.ts` for the full validation logic.

---

## 🎯 4. The "First Bounty" Workflow
To test the core loop of the platform:

1. **Login**: Use the "Login with GitHub" button on the local dashboard.
2. **Register a Repo**: Go to `/my-repos` and link a test repository.
3. **Fund a Bounty**: 
   - Ensure your wallet has test XDC/USDC.
   - Use the `POST /api/blockchain/repository/:repoId/fund` endpoint or the UI button.
4. **Verify On-Chain**: Check the `DualCurrencyRepoRewards.sol` contract state to see your funded pool.

---

## 🧪 5. Useful Commands for Devs
- **Type Checking**: `npm run check`
- **Unit Testing**: `npm test`
- **Smart Contract Compile**: `npx hardhat compile`
- **Deploy to Testnet**: `npx hardhat run scripts/deploy_dual_currency_rewards.cjs --network xdcTestnet`

---

## 🆘 Troubleshooting
- **DB Issues?** Run `npm run db:push` again to sync schema changes.
- **500 Errors?** Check if your `DATABASE_URL` is accessible.
- **Web3 Failures?** Ensure your RPC URL is active and your wallet has enough gas for transactions.

---
**Happy Coding!** Let's build the future of decentralized collaboration together.
*For more details, check `CLAUDE.md` and `/docs`.*

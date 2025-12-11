# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Roxonn is a decentralized platform that integrates GitHub contributions with XDC blockchain rewards. It manages:
- GitHub OAuth authentication and repository registration
- Multi-currency reward distribution (XDC, ROXN token, USDC)
- Wallet management via Tatum API
- AI-powered development assistance with multiple model providers
- Course subscriptions with USDC payments
- Proof-of-compute node management

## Critical Development Commands

### Local Development
```bash
# Install dependencies
npm install

# Run full-stack development server
npm run dev

# Run backend server only (uses tsx)
npm run dev:server

# Build for production
npm run build

# Start production server
npm run start

# Type checking
npm run check
```

### Database Operations
```bash
# Push schema changes to database
npm run db:push

# Migrate secrets to AWS Parameter Store (if using)
npm run migrate-secrets
```

### Smart Contract Operations
```bash
# Compile contracts
npx hardhat compile

# Deploy to XDC testnet (Apothem)
npx hardhat run scripts/deploy_dual_currency_rewards.cjs --network xdcTestnet

# Deploy to XDC mainnet
npx hardhat run scripts/deploy_dual_currency_rewards.cjs --network xinfin

# Verify contract on XDCScan
npx hardhat verify --network xinfin <CONTRACT_ADDRESS>
```

### Testing
```bash
# Run tests (when implemented)
npm test

# Run reward feature tests (placeholder - tests not yet implemented)
npm run test:reward
```

## Private Repository Support

The platform supports private GitHub repositories using **GitHub App installation tokens** for access validation:

- **Pool Managers**: Can register and fund private repositories with GitHub App installed
- **Contributors**: Automatically see private repos they have GitHub access to (no OAuth upgrade needed)
- **Access Validation**: Real-time collaborator checks using GitHub App tokens (privacy-preserving)
- **No Token Storage**: Contributors' private tokens are NOT stored or requested

Implementation details in `/docs/FEATURES/PRIVATE_REPOS.md`

## Architecture Details

### Core Directory Structure
```
/server           - Express backend server
  index.ts        - Server entry point with middleware setup
  routes.ts       - Thin wrapper that delegates to modular routes
  blockchain.ts   - XDC blockchain interaction service
  walletService.ts- Wallet management & Tatum integration
  auth.ts         - GitHub OAuth & JWT authentication
  db.ts           - PostgreSQL with Drizzle ORM
  config.ts       - Configuration management (env vars + AWS SSM)
  /services       - Business logic services
  /routes         - Modular route handlers (see below)

/client          - React frontend
  /src/pages     - Application pages
  /src/components- UI components (shadcn/ui based)
  /src/hooks     - Custom React hooks
  /src/lib       - Utilities and configurations

/contracts       - Solidity smart contracts
  DualCurrencyRepoRewards.sol - Main unified rewards contract (XDC/ROXN/USDC)
  ROXNToken.sol               - ROXN ERC20/XRC20 token
  CustomForwarder.sol         - Meta-transaction forwarder
  ProofOfCompute.sol          - Compute node management
  (Legacy: RepoRewards.sol, RoxnRewards.sol, USDCRepoRewards.sol - NOT IN USE)

/shared          - Shared types and schema
  schema.ts      - Database schema & TypeScript types

/migrations      - Database migrations
  0013_add_subscriptions.sql - Latest: subscription tables
```

### Modular Routes Structure

Routes are organized in `server/routes/` with each file handling a specific domain:

```
/server/routes
  index.ts              - registerModularRoutes() - registers all route modules
  authRoutes.ts         - /api/auth/* - Authentication endpoints
  blockchainRoutes.ts   - /api/blockchain/* - Blockchain operations
  walletRoutes.ts       - /api/wallet/* - Wallet operations
  subscriptionRoutes.ts - /api/subscription/* - Subscription management
  repositoryRoutes.ts   - /api/* - Repository management
  adminRoutes.ts        - /api/admin/* - Admin operations
  nodeRoutes.ts         - /api/node/* - Compute node endpoints
  webhookRoutes.ts      - /webhook/* - GitHub App & payment webhooks
  aiRoutes.ts           - /api/vscode/* - AI completions
  miscRoutes.ts         - /health, /api/courses/*, /api/zoho/* - Misc endpoints
  referralRoutes.ts     - /api/referral/* - Referral system
  promotionalBounties.ts- /api/promotional/* - Promotional bounties
  multiCurrencyWallet.ts- /api/wallet/* - Multi-currency features
  aiScopingAgent.ts     - /api/ai-scoping/* - AI scoping agent
```

### Active Smart Contracts

The system uses UUPS proxy pattern for upgradeability. Current active contracts:

1. **DualCurrencyRepoRewards** (Main Contract)
   - Handles XDC, ROXN, and USDC rewards in one unified contract
   - Proxy + Implementation pattern
   - Env vars: `DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS` (proxy)

2. **ROXNToken**
   - ERC20/XRC20 token implementation
   - 1 billion max supply
   - Env var: `ROXN_TOKEN_ADDRESS`

3. **CustomForwarder**
   - Meta-transactions for gasless operations
   - Env var: `FORWARDER_CONTRACT_ADDRESS`

4. **ProofOfCompute**
   - Manages compute nodes for AI operations
   - Env var: `PROOF_OF_COMPUTE_CONTRACT_ADDRESS`

5. **USDC Token** (External)
   - Standard USDC deployment on XDC
   - Env var: `USDC_XDC_ADDRESS`

### Database Schema (PostgreSQL)

Main tables:
- `users` - GitHub users with single XDC wallet address
- `registered_repositories` - GitHub repos registered on platform
- `onramp_transactions` - Fiat-to-crypto transactions
- `subscriptions` - Course subscriptions (yearly USDC)
- `subscription_events` - Subscription audit log
- `course_assignments` - User course assignments

Key user fields:
- `xdc_wallet_address` - Single wallet per user
- `wallet_reference_id` - Tatum wallet reference
- `encrypted_private_key` - Encrypted with AWS KMS
- `prompt_balance` - AI usage credits

### Authentication & Security

- **GitHub OAuth**: Primary authentication method
- **JWT tokens**: API authentication (30-day expiry for VSCode)
- **Session management**: express-session with PostgreSQL store
- **Wallet encryption**: AWS KMS for private key encryption
- **Rate limiting**: On sensitive endpoints
- **CORS & Helmet**: Security middleware configured

### AI Model Integration

Multiple Azure OpenAI deployments configured:
- GPT-4 variants (gpt-4.1)
- DeepSeek-R1
- O3-mini, O4-mini
- Grok-3, Grok-3-mini
- Ministral-3B

Each model has separate endpoint, key, and deployment name configuration.

### Key API Routes

**Authentication**
- `POST /api/auth/github` - GitHub OAuth flow
- `GET /api/auth/user` - Current user info

**Repository Management**
- `POST /api/repositories/register` - Register GitHub repo (public/private)
- `GET /api/repositories/registered` - User's registered repos
- `GET /api/repositories/accessible` - Repos accessible to user (GitHub App collaborator check)
- `GET /api/repositories/public` - All public repos with funding
- `GET /api/blockchain/repository/:repoId` - Blockchain repo data

**Wallet Operations**
- `GET /api/wallet/info` - Wallet details
- `GET /api/wallet/limits` - Transfer limits
- `POST /api/wallet/export-request` - Request wallet export (requires OTP)
- `GET /api/wallet/buy-xdc-url` - Onramp.money integration

**Blockchain Operations**
- `POST /api/blockchain/repository/:repoId/fund` - Fund repository
- `POST /api/blockchain/approve-roxn` - Approve ROXN spending
- `POST /api/blockchain/fund-roxn/:repoId` - Fund with ROXN
- `POST /api/blockchain/fund-usdc/:repoId` - Fund with USDC

**AI & Compute**
- `POST /api/vscode/ai/chat/completions` - VSCode AI completions
- `POST /api/ai-scoping-agent/*` - AI project scoping
- `POST /api/exo-node/heartbeat` - Compute node heartbeat

**Subscriptions**
- `POST /api/subscription/merchant/init` - Initialize subscription
- `GET /api/subscription/status` - Check subscription status
- `POST /webhook/onramp-money` - Payment webhook

**GitHub App Webhooks**
- `POST /webhook/github/app` - GitHub App webhook handler

### Environment Configuration

Configuration sources (in order):
1. AWS Parameter Store (if `USE_PARAMETER_STORE=true`)
2. `server/.env` file (fallback)

Critical environment variables:
```bash
# Database
DATABASE_URL               # PostgreSQL connection string

# Blockchain
XDC_RPC_URL                # XDC network RPC
DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS  # Main rewards contract
ROXN_TOKEN_ADDRESS         # ROXN token contract
FORWARDER_CONTRACT_ADDRESS # Meta-tx forwarder
USDC_XDC_ADDRESS          # USDC token on XDC
PRIVATE_KEY               # Relayer wallet private key

# GitHub
GITHUB_CLIENT_ID/SECRET   # OAuth credentials
GITHUB_APP_ID            # GitHub App ID
GITHUB_APP_PRIVATE_KEY   # App private key
GITHUB_APP_WEBHOOK_SECRET # Webhook verification

# Security
JWT_SECRET              # JWT signing
SESSION_SECRET          # Session encryption
ENCRYPTION_KEY          # Wallet encryption
WALLET_KMS_KEY_ID       # AWS KMS key

# External Services
TATUM_API_KEY          # Wallet provider
AZURE_OPENAI_KEY       # AI models
AZURE_STORAGE_KEY      # Video storage
ONRAMP_MONEY_API_KEY   # Payment provider

# Platform Settings
FEE_COLLECTOR_ADDRESS   # Platform fee recipient wallet address
PLATFORM_FEE_RATE      # Default 50 (0.5% from pool funding)
CONTRIBUTOR_FEE_RATE   # Default 50 (0.5% from contributor payout)
```

### Deployment Notes

1. **Smart Contracts**: Use proxy pattern - always deploy implementation then upgrade proxy
2. **Database**: Run migrations before deploying new features
3. **Environment**: Mainnet uses XDC chain ID 50, Testnet uses 51
4. **Gas Settings**: Mainnet deploys use 25 gwei gas price
5. **Security**: All wallet keys encrypted before storage

### Common Development Tasks

**Adding New API Endpoint**
1. Identify the appropriate route module in `server/routes/` (e.g., walletRoutes.ts for wallet endpoints)
2. Add route handler to that module with proper middleware (requireAuth, csrfProtection)
3. Add business logic in appropriate service file
4. Update TypeScript types in `shared/schema.ts` if needed
5. Note: Route paths are relative to the module's mount point (e.g., `/send` in walletRoutes.ts becomes `/api/wallet/send`)

**Modifying Smart Contracts**
1. Update contract in `/contracts` (avoid legacy files)
2. Compile: `npx hardhat compile`
3. Deploy to testnet first
4. Use upgrade scripts for proxy contracts
5. Update contract address in environment

**Database Changes**
1. Modify schema in `/shared/schema.ts`
2. Create migration in `/migrations`
3. Run `npm run db:push`
4. Test queries in relevant services

**Testing**
- Route tests in `server/routes/__tests__/` using Vitest
- Run tests with `npm test`
- Contract tests would use Hardhat

### Important Warnings

1. **Modular Routes**: All API routes are in `server/routes/*.ts` - do NOT add routes to the old monolithic pattern
2. **Legacy Contracts**: RepoRewards.sol, RoxnRewards.sol, USDCRepoRewards.sol are deprecated
3. **Multiple Deployments**: Many scripts in `/scripts` are for rollbacks/migrations
4. **Test Coverage**: Test files exist in `server/routes/__tests__/` using Vitest
5. **Rate Limits**: Be aware of rate limiting on auth endpoints
6. **Unused Code**: OAuth upgrade endpoints in `auth.ts` and upgrade banner in `my-repositories.tsx` are unused (GitHub App approach is used instead)
7. **Route Mount Points**: When adding endpoints, remember the route path is relative to the mount point defined in `routes/index.ts`
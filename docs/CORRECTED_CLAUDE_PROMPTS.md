# Corrected Claude Code Prompts for Roxonn Platform

> **IMPORTANT**: This document contains corrected versions of AI-generated prompts that were created without seeing the actual codebase. The original prompts contained many incorrect assumptions about authentication, user roles, database schema, and architecture.

---

## Key Corrections Summary

| Original Assumption | Actual Reality |
|---------------------|----------------|
| Email/password authentication | **GitHub OAuth only** - No email/password auth exists |
| "developer" vs "client" profile types | **"contributor" vs "poolmanager"** roles in single users table |
| Separate developer_profiles/client_profiles tables | **Single `users` table** with `role` field |
| Multi-chain wallet support | **Single XDC wallet per user** only |
| Single bounty system | **4 separate bounty systems**: Pool, Community, Promotional, Bounty Requests |
| Generic smart contract | **DualCurrencyRepoRewards.sol** (pools) + **CommunityBountyEscrow.sol** (community) |
| Users can change profile type | **Role is set during onboarding**, changes require admin intervention |
| Profile type in JWT | **Role from database** - verified on each request |

---

## Master Preamble (Use Before Every Prompt)

```
You are operating in PRECISION MODE for Roxonn Platform development.

CRITICAL CONTEXT - ROXONN ARCHITECTURE:
- Authentication: GitHub OAuth ONLY (passport-github2). No email/password.
- User Roles: "contributor" OR "poolmanager" (in users.role field)
- Wallet: Single XDC wallet per user (auto-generated via Tatum, encrypted with AWS KMS)
- Currencies: XDC (native), ROXN (ERC20), USDC (ERC20) - all on XDC network only
- Smart Contracts:
  * DualCurrencyRepoRewards.sol - Pool-based bounties for registered repos
  * CommunityBountyEscrow.sol - Permissionless bounties on any public repo
  * ROXNToken.sol - Platform token
  * CustomForwarder.sol - Meta-transactions

CRITICAL RULES:
- Take your time. There is no rush.
- Think through every edge case before writing code.
- Security is non-negotiable. Every input must be validated, every output sanitized.
- Write tests BEFORE or alongside implementation.
- If you're unsure about something, stop and ask for clarification.
- Never use placeholder code, TODO comments, or "implement later" shortcuts.
- Every function needs error handling.
- Every user input needs validation.
- Every database query needs parameterization.
- Every API endpoint needs authentication checks.

EXISTING PATTERNS TO FOLLOW:
- Routes are modular: server/routes/*.ts (registered via registerModularRoutes)
- Schema in shared/schema.ts with Drizzle ORM
- Validation with Zod schemas
- CSRF protection via generateCsrfToken/csrfProtection middleware
- Rate limiting on sensitive endpoints
- requireAuth middleware for session auth, requireVSCodeAuth for JWT auth

Quality checklist for every file:
□ Input validation on all parameters (use Zod schemas)
□ Proper error handling with meaningful messages
□ No hardcoded secrets or credentials
□ SQL injection prevention (Drizzle ORM handles this)
□ XSS prevention (output encoding)
□ CSRF protection where applicable
□ Rate limiting considerations
□ Logging for debugging without exposing sensitive data
```

---

## PHASE 0: Role-Based System Enhancement (NOT "Dual Profile")

> **CORRECTION**: Roxonn already HAS a role system (`contributor` vs `poolmanager`). These prompts should ENHANCE the existing system, not create a new one.

### Prompt 0A: Audit Existing Role Enforcement

```
PRECISION MODE ENABLED - Audit existing authorization.

TASK: Audit and document the current role-based access control in Roxonn.

CONTEXT - EXISTING SYSTEM:
- users.role field: "contributor" | "poolmanager" (defined in shared/schema.ts:18)
- Role set during GitHub OAuth onboarding
- requireAuth middleware in server/auth.ts checks authentication
- No dedicated role-checking middleware currently exists

AUDIT INSTRUCTIONS:

1. READ and DOCUMENT current authorization:
   - Which endpoints check user.role before allowing actions?
   - Which endpoints are missing role checks?
   - How is role assigned during onboarding?

2. CREATE an audit report listing:

   POOLMANAGER-ONLY ACTIONS (should require role === "poolmanager"):
   □ POST /api/repositories/register - Register repository
   □ POST /api/blockchain/repository/:repoId/fund - Fund pool with XDC
   □ POST /api/blockchain/fund-roxn/:repoId - Fund pool with ROXN
   □ POST /api/blockchain/fund-usdc/:repoId - Fund pool with USDC
   □ POST /api/blockchain/allocate-bounty/:repoId/:issueId - Allocate bounty
   □ POST /api/blockchain/distribute-bounty/:repoId/:issueId - Distribute bounty
   □ POST /api/promotional/bounties - Create promotional bounty
   □ PATCH /api/promotional/bounties/:id/status - Update bounty status

   CONTRIBUTOR-ONLY ACTIONS (should require role === "contributor"):
   □ POST /api/community-bounties/:id/claim - Claim community bounty
   □ POST /api/promotional/submissions - Submit to promotional bounty

   SHARED ACTIONS (any authenticated user):
   □ GET /api/repositories/* - View repositories
   □ GET /api/blockchain/* - View blockchain data
   □ POST /api/community-bounties - Create community bounty (anyone can create)
   □ POST /api/community-bounties/:id/pay - Pay for community bounty

3. VERIFY smart contract alignment:
   - DualCurrencyRepoRewards.sol: Who can call fundRepository, allocateBounty, distributeBounty?
   - CommunityBountyEscrow.sol: Who can call createBounty, claimBounty, completeBounty?

DELIVERABLES:
- Audit report markdown file
- List of endpoints needing role middleware
- Recommended middleware implementation approach

DO NOT write any fix code until the audit is complete and approved.
```

### Prompt 0B: Create Role Authorization Middleware

```
PRECISION MODE ENABLED - Middleware implementation.

TASK: Create role-checking middleware and apply to appropriate routes.

EXISTING AUTH PATTERN (server/auth.ts):
```typescript
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!req.user.githubAccessToken) {
    return res.status(401).json({ error: "GitHub token not available" });
  }
  next();
};
```

NEW MIDDLEWARE TO CREATE:

1. requirePoolManager middleware:
```typescript
export const requirePoolManager = (req: Request, res: Response, next: NextFunction) => {
  // Must be used AFTER requireAuth
  if (req.user?.role !== 'poolmanager') {
    return res.status(403).json({
      error: 'ACCESS_DENIED',
      message: 'This action requires a pool manager account',
      code: 'ROLE_MISMATCH',
      requiredRole: 'poolmanager',
      userRole: req.user?.role || null
    });
  }
  next();
};
```

2. requireContributor middleware:
```typescript
export const requireContributor = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'contributor') {
    return res.status(403).json({
      error: 'ACCESS_DENIED',
      message: 'This action requires a contributor account',
      code: 'ROLE_MISMATCH',
      requiredRole: 'contributor',
      userRole: req.user?.role || null
    });
  }
  next();
};
```

3. requireOwnership middleware (for resource-specific checks):
```typescript
export const requireRepoOwner = async (req: Request, res: Response, next: NextFunction) => {
  const repoId = parseInt(req.params.repoId);
  const repo = await db.select().from(registeredRepositories)
    .where(eq(registeredRepositories.id, repoId))
    .limit(1);

  if (!repo[0] || repo[0].userId !== req.user?.id) {
    return res.status(403).json({
      error: 'ACCESS_DENIED',
      message: 'You can only manage your own repositories'
    });
  }
  req.repository = repo[0]; // Attach for downstream use
  next();
};
```

APPLY TO ROUTES:

In server/routes/blockchainRoutes.ts:
```typescript
// Before (current):
router.post('/repository/:repoId/fund', requireAuth, csrfProtection, fundRepository);

// After (with role check):
router.post('/repository/:repoId/fund', requireAuth, requirePoolManager, requireRepoOwner, csrfProtection, fundRepository);
```

SECURITY REQUIREMENTS:
□ Middleware order: requireAuth → requireRole → requireOwnership → csrfProtection → handler
□ Log all role denials (potential attack indicator)
□ Return consistent error format
□ Never expose internal error details

DELIVERABLES:
- Middleware functions in server/auth.ts
- Updated routes in server/routes/*.ts
- Unit tests for each middleware
- Integration tests for protected routes
```

### Prompt 0C: Role-Specific Dashboard Data

```
PRECISION MODE ENABLED - Dashboard enhancements.

TASK: Ensure dashboard API returns role-appropriate data.

CURRENT STATE:
- No dedicated dashboard endpoints exist
- Data scattered across multiple endpoints
- Frontend manually assembles dashboard view

IMPLEMENTATION:

1. GET /api/dashboard (authenticated, returns data based on role)

For POOLMANAGER role:
```typescript
{
  role: "poolmanager",
  stats: {
    totalPoolFunds: { xdc: string, roxn: string, usdc: string },
    activeBounties: number,
    pendingSubmissions: number,
    totalDistributed: { xdc: string, roxn: string, usdc: string }
  },
  repositories: [
    {
      id: number,
      githubRepoFullName: string,
      poolBalance: { xdc: string, roxn: string, usdc: string },
      activeBountyCount: number,
      pendingSubmissions: number
    }
  ],
  recentActivity: [
    { type: "bounty_created" | "submission_received" | "payout_sent", ... }
  ]
}
```

For CONTRIBUTOR role:
```typescript
{
  role: "contributor",
  stats: {
    totalEarned: { xdc: string, roxn: string, usdc: string },
    bountiesCompleted: number,
    pendingClaims: number,
    successRate: number // percentage
  },
  activeClaims: [
    {
      bountyId: number,
      repoName: string,
      issueNumber: number,
      amount: string,
      currency: string,
      claimedAt: Date,
      status: string
    }
  ],
  earnings: [
    { date: Date, amount: string, currency: string, repoName: string }
  ],
  availableBounties: [...] // Suggested bounties
}
```

DATA ISOLATION REQUIREMENTS:
□ Poolmanagers see ONLY their own repositories and bounties
□ Contributors see ONLY their own claims and earnings
□ Never leak financial data from other users
□ Aggregate stats are per-user, not platform-wide (unless public leaderboard)

LOCATION:
- Create server/routes/dashboardRoutes.ts
- Register in server/routes/index.ts

DELIVERABLES:
- Dashboard route module
- Role-specific data aggregation queries
- Frontend dashboard components (separate for each role)
- Tests for data isolation
```

---

## PHASE 1: Fix Bounty Creation Issues

> **CORRECTION**: The original prompts assumed a single bounty system. Roxonn has MULTIPLE bounty systems. Clarify which one needs fixing.

### Prompt 1A: Diagnose Payment Method Error

```
PRECISION MODE ENABLED - Take your time, ensure zero errors.

TASK: Diagnose and fix "payment method failed" error in bounty creation.

CRITICAL CONTEXT - ROXONN HAS 4 BOUNTY SYSTEMS:

1. POOL BOUNTIES (DualCurrencyRepoRewards.sol):
   - Poolmanager funds repository pool first
   - Then allocates bounty to specific issue
   - Routes: /api/blockchain/repository/:repoId/fund, /api/blockchain/allocate-bounty/:repoId/:issueId

2. COMMUNITY BOUNTIES (CommunityBountyEscrow.sol):
   - Anyone creates bounty on ANY public GitHub repo
   - Two-step: Create (DB) → Pay (blockchain escrow)
   - Routes: /api/community-bounties, /api/community-bounties/:id/pay
   - Table: communityBounties (shared/schema.ts:628-698)

3. PROMOTIONAL BOUNTIES (no blockchain):
   - On registered repos only
   - Rewards for social media promotion
   - Routes: /api/promotional/bounties
   - Table: promotionalBounties (shared/schema.ts:530-548)

4. BOUNTY REQUESTS (GitHub comments):
   - Via GitHub issue comment "/roxonn bounty"
   - Processed by webhook
   - Table: bountyRequests (shared/schema.ts:605-621)

FIRST: Determine which bounty system has the error.

INSTRUCTIONS:

1. ASK THE USER: "Which bounty creation flow is failing?"
   - Pool bounty (funding registered repository)?
   - Community bounty (anyone creating on any repo)?
   - Promotional bounty?

2. Once identified, READ the relevant files:

   For Pool Bounties:
   - server/routes/blockchainRoutes.ts (fund endpoints)
   - server/blockchain.ts (smart contract interaction)
   - contracts/DualCurrencyRepoRewards.sol

   For Community Bounties:
   - server/routes/communityBounties.ts
   - contracts/CommunityBountyEscrow.sol

3. Create diagnostic report:
   - Frontend component involved
   - API endpoint called
   - Smart contract function invoked
   - Transaction flow: wallet connection → approval → transaction
   - Where exactly does "payment method failed" appear?

4. Check common issues:
   □ Wallet not connected (wagmi/ethers state)
   □ Insufficient balance for amount + gas
   □ Token approval not done before transfer (ROXN/USDC)
   □ Wrong contract address in environment
   □ RPC endpoint down or rate limited
   □ Gas estimation failing
   □ Smart contract revert with reason

DO NOT propose fixes until you've identified the EXACT failure point.
```

### Prompt 1B: Fix Community Bounty Payment Flow

```
PRECISION MODE ENABLED - Security-first implementation.

TASK: Fix community bounty payment flow (if this is the failing system).

COMMUNITY BOUNTY FLOW:

Step 1: Create bounty (DB only)
POST /api/community-bounties
→ Creates record with status: "pending_payment"
→ Calculates fees: baseBountyAmount + clientFee (2.5%) + contributorFee (2.5%)
→ Returns bountyId

Step 2: Pay bounty (blockchain escrow)
POST /api/community-bounties/:id/pay
→ User calls CommunityBountyEscrow.createBounty() on-chain
→ Deposits: totalPaidByClient = baseBountyAmount + clientFee + contributorFee
→ Updates DB: status → "funded", escrowTxHash, blockchainBountyId

SMART CONTRACT (CommunityBountyEscrow.sol):
```solidity
function createBounty(
    string calldata repoOwner,
    string calldata repoName,
    uint256 issueNumber,
    CurrencyType currency,  // 0=XDC, 1=ROXN, 2=USDC
    uint256 amount,
    uint256 expiryDays
) external payable returns (uint256 bountyId)
```

COMMON ISSUES TO CHECK:

1. Token Approval (for ROXN/USDC):
   - User must approve CommunityBountyEscrow to spend tokens BEFORE createBounty
   - Check if frontend prompts for approval first

2. Amount Calculation:
   - Frontend must calculate totalPaidByClient including fees
   - Match exactly: baseBountyAmount * 1.05 (5% total fees)

3. Gas Estimation:
   - XDC network uses different gas parameters
   - Ensure gasPrice is set appropriately for XDC

4. Transaction Parameters:
   - For XDC payments: value = amount (in wei)
   - For token payments: value = 0, tokens transferred via contract

SECURITY REQUIREMENTS:
□ Verify bounty exists and is in "pending_payment" status before pay
□ Verify caller is the bounty creator
□ Validate amount matches database record
□ Handle transaction timeout (user closes browser)
□ Handle wallet disconnection mid-flow
□ Rate limit: Max 20 payments per 15 minutes per user

DELIVERABLES:
- Root cause analysis
- Fixed frontend payment component
- Fixed backend pay endpoint
- Tests for each error scenario
- Transaction retry logic with exponential backoff
```

---

## PHASE 2: Profile Enhancement (NOT New Profile System)

> **CORRECTION**: Roxonn already has user profiles via the `users` table. These prompts should ENHANCE existing profiles, not create new ones.

### Prompt 2A: Enhance Existing User Profile

```
PRECISION MODE ENABLED - Work with existing schema.

TASK: Enhance the existing user profile system.

CURRENT USER SCHEMA (shared/schema.ts:5-42):
```typescript
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  githubId: text("github_id").notNull().unique(),
  username: text("username").notNull().unique(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  location: text("location"),
  website: text("website"),
  githubUsername: text("github_username").notNull(),
  role: text("role", { enum: ["contributor", "poolmanager"] }),
  xdcWalletAddress: text("xdc_wallet_address"),
  isProfileComplete: boolean("is_profile_complete").default(false),
  // ... wallet fields, referral fields, timestamps
});
```

PROPOSED ENHANCEMENTS (add to existing users table):

Option A: Add columns to users table:
```typescript
// Add to users table
displayName: text("display_name"),  // Separate from GitHub name
skills: jsonb("skills").default([]),  // ["solidity", "react", "node"]
githubVerified: boolean("github_verified").default(true), // Always true (OAuth)
profileVisibility: text("profile_visibility", { enum: ["public", "private"] }).default("public"),
```

Option B: Create computed stats view (don't store, calculate):
```sql
CREATE VIEW user_profile_stats AS
SELECT
  u.id,
  u.username,
  COUNT(DISTINCT p.id) as bounties_completed,
  COALESCE(SUM(p.amount), 0) as total_earned,
  -- Calculate from payouts table
FROM users u
LEFT JOIN payouts p ON p.recipient_user_id = u.id
GROUP BY u.id;
```

PROFILE API ENHANCEMENTS:

1. GET /api/profile/:username (public profile)
```typescript
{
  username: string,
  displayName: string | null,
  avatarUrl: string | null,
  bio: string | null,
  githubUsername: string,
  role: "contributor" | "poolmanager",
  memberSince: Date,
  stats: {
    bountiesCompleted: number,
    totalEarned: { xdc: string, roxn: string, usdc: string },
    successRate: number,
    // Only show for contributor role
  },
  repositories: [...], // Only show for poolmanager role
  badges: [...] // Achievement badges
}
```

2. PATCH /api/profile (update own profile)
- Already exists in miscRoutes.ts
- Uses updateProfileSchema from shared/schema.ts

SECURITY REQUIREMENTS:
□ Public profiles: Hide email, wallet address (or truncate: 0x123...abc)
□ Bio sanitization: Strip HTML, limit 500 chars
□ Rate limit profile views: 100/minute per IP
□ Rate limit profile updates: 10/hour per user

DO NOT create new profile tables. Enhance existing schema.
```

### Prompt 2B: Achievement Badges System

```
PRECISION MODE ENABLED - New feature with existing data.

TASK: Implement achievement badges calculated from existing data.

BADGE DEFINITIONS (calculate, don't store separately):

```typescript
interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  checkEligibility: (userId: number) => Promise<boolean>;
}

const BADGES: Badge[] = [
  {
    id: "first_bounty",
    name: "First Blood",
    description: "Completed first bounty",
    icon: "trophy",
    checkEligibility: async (userId) => {
      const count = await db.select({ count: sql`count(*)` })
        .from(payouts)
        .where(eq(payouts.recipientUserId, userId));
      return count[0].count >= 1;
    }
  },
  {
    id: "five_bounties",
    name: "Getting Started",
    description: "Completed 5 bounties",
    checkEligibility: async (userId) => {
      // Similar query, count >= 5
    }
  },
  {
    id: "whale",
    name: "Whale",
    description: "Earned over 10,000 USDC equivalent",
    checkEligibility: async (userId) => {
      // Sum all payouts, convert to USDC equivalent
    }
  },
  {
    id: "pool_creator",
    name: "Pool Creator",
    description: "Created first funded repository pool",
    checkEligibility: async (userId) => {
      // Check registeredRepositories with pool funds
    }
  },
  // Add more badges...
];
```

IMPLEMENTATION APPROACH:
- Calculate badges on-demand when fetching profile
- Cache results briefly (5 minutes)
- No separate badges table needed

API ENDPOINT:
GET /api/profile/:username/badges
→ Returns array of earned badge IDs

FRONTEND:
- Badge icons as SVG or icon font
- Tooltip with badge description
- Display on profile page

DELIVERABLES:
- Badge definitions in server/services/badges.ts
- Profile API enhancement to include badges
- Frontend badge display components
- Tests for each badge eligibility check
```

---

## PHASE 3: Collaborative Bounties (Team Submissions)

> **CORRECTION**: This feature doesn't exist yet. The prompts need adjustment for Roxonn's actual contract architecture.

### Prompt 3A: Team Submission Design

```
PRECISION MODE ENABLED - New feature design.

TASK: Design team submission feature for existing bounty systems.

CONTEXT - WHICH BOUNTY SYSTEMS SUPPORT TEAMS?

1. Pool Bounties (DualCurrencyRepoRewards.sol):
   - Current: Single contributor per issue
   - Would need contract upgrade for team splits
   - Higher complexity, requires proxy upgrade

2. Community Bounties (CommunityBountyEscrow.sol):
   - Current: Single claimant per bounty
   - Easier to modify (separate contract)
   - Recommended starting point

DECISION NEEDED: Which system gets team support first?
Recommendation: Community bounties (simpler, lower risk)

PROPOSED DATA MODEL:

Option A: Database-only teams (simpler):
- Team formed off-chain
- Single wallet submits claim
- Manual split by team lead
- No smart contract changes

Option B: On-chain team splits (proper):
- Team registered on-chain
- Smart contract splits payout automatically
- More complex but trustless

For Option B, new contract additions:
```solidity
struct TeamSubmission {
    address[] members;          // 2-5 members
    uint256[] splitBasisPoints; // Must sum to 10000 (100%)
    address submitter;          // Who submitted
    bool approved;
}

mapping(uint256 => TeamSubmission) public bountyTeams;

function submitAsTeam(
    uint256 bountyId,
    address[] calldata members,
    uint256[] calldata splits
) external;

function completeBountyWithTeamSplit(uint256 bountyId) external onlyRelayer;
```

DATABASE ADDITIONS (shared/schema.ts):
```typescript
export const bountyTeams = pgTable("bounty_teams", {
  id: serial("id").primaryKey(),
  communityBountyId: integer("community_bounty_id")
    .references(() => communityBounties.id, { onDelete: 'cascade' }),
  teamName: text("team_name"),
  members: jsonb("members").notNull(), // [{ userId, walletAddress, splitPercentage }]
  submittedBy: integer("submitted_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});
```

SECURITY CONSIDERATIONS:
□ All team members must be registered platform users
□ Split percentages must sum to exactly 100
□ Prevent team changes after submission
□ Handle case where member wallet is contract (could revert)
□ Minimum split: 5% per member (prevent dust attacks)
□ Maximum team size: 5 members

DELIVERABLES:
- Detailed design document
- Database migration
- Smart contract changes (if Option B)
- API endpoint design
- Frontend wireframes

Get approval on approach BEFORE implementation.
```

---

## PHASE 4: Comments System

> **CORRECTION**: The original prompt is mostly correct but needs Roxonn-specific integration.

### Prompt 4A: Bounty Comments Implementation

```
PRECISION MODE ENABLED - User-generated content security.

TASK: Implement public comments on community bounties.

SCOPE:
- Comments on community bounties only (not pool bounties - those have GitHub issues)
- Public visibility (anyone can read)
- Only authenticated users can post
- Basic threading (one level deep)
- NO private messaging

DATABASE SCHEMA:
```typescript
export const bountyComments = pgTable("bounty_comments", {
  id: serial("id").primaryKey(),
  communityBountyId: integer("community_bounty_id")
    .notNull()
    .references(() => communityBounties.id, { onDelete: 'cascade' }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  parentCommentId: integer("parent_comment_id")
    .references(() => bountyComments.id, { onDelete: 'cascade' }),
  content: text("content").notNull(), // Max 2000 chars
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at"),
  deletedAt: timestamp("deleted_at"), // Soft delete
});
```

API ENDPOINTS:

1. GET /api/community-bounties/:id/comments
   - Public endpoint
   - Returns comments with author info (username, avatarUrl)
   - Includes replies nested under parent

2. POST /api/community-bounties/:id/comments
   - Authenticated (requireAuth)
   - CSRF protected
   - Rate limited: 10 comments/hour per user

3. PATCH /api/community-bounties/:id/comments/:commentId
   - Authenticated, author only
   - Only within 15 minutes of creation

4. DELETE /api/community-bounties/:id/comments/:commentId
   - Authenticated, author OR bounty creator
   - Soft delete (shows "[deleted]")

SECURITY REQUIREMENTS (CRITICAL FOR UGC):

1. XSS Prevention:
   - Strip ALL HTML: content.replace(/<[^>]*>/g, '')
   - Escape on output in frontend
   - No markdown rendering initially

2. Content Validation:
   □ Max 2000 characters
   □ No raw URLs (or validate against safelist)
   □ No email addresses (regex strip)
   □ Profanity filter (optional)

3. Rate Limiting:
   □ 10 comments/hour per user
   □ 100 reads/minute per IP
   □ CAPTCHA after 5 rapid comments

4. Spam Prevention:
   □ Require verified GitHub account (already have via OAuth)
   □ Duplicate detection (same content within 5 minutes)
   □ Report button with auto-hide at 3 reports

DELIVERABLES:
- Database migration
- Route module: server/routes/commentRoutes.ts
- Zod validation schemas
- Frontend comment components
- Moderation tools (for bounty creators)
- Full test suite
```

---

## Final Quality Checklist (Use After Each Phase)

```
PRECISION MODE - VERIFICATION PHASE

Before marking Phase [X] complete, verify:

ROXONN-SPECIFIC CHECKS:
□ GitHub OAuth still works (didn't break auth flow)
□ Wallet generation still works for new users
□ Existing bounty flows unaffected
□ Smart contract interactions tested on Apothem testnet
□ CSRF tokens validated on all POST/PATCH/DELETE
□ requireAuth middleware on all protected routes

SECURITY AUDIT:
□ Run: npm run check (TypeScript type checking)
□ Check for hardcoded secrets (grep -r "0x" --include="*.ts")
□ Verify all environment variables documented
□ Test all endpoints with invalid/malicious input
□ Verify authentication on all protected routes
□ Check XSS prevention (all user content escaped)

CODE QUALITY:
□ All functions have error handling
□ All async operations have try/catch
□ No console.log in production code (use log() from utils)
□ No TODO comments left unresolved
□ Types defined in shared/schema.ts

TESTING:
□ Unit tests pass: npm test
□ Test files in server/routes/__tests__/
□ Edge cases tested
□ Role-based access tested

DEPLOYMENT:
□ Database migrations tested: npm run db:push
□ Environment variables documented
□ Tested on XDC Apothem testnet before mainnet
□ Gas costs estimated for new contract calls

Report any issues found. Do not proceed to next phase until all checks pass.
```

---

## Updated Phase Priority

| Phase | Feature | Priority | Notes |
|-------|---------|----------|-------|
| 0A | Audit existing role enforcement | CRITICAL | Foundation for all other work |
| 0B | Create role middleware | CRITICAL | Apply to all routes |
| 0C | Role-specific dashboard | HIGH | Better UX |
| 1A | Diagnose bounty error | HIGH | Depends on which system is broken |
| 1B | Fix bounty creation | HIGH | After diagnosis |
| 2A | Enhance profiles | MEDIUM | Uses existing table |
| 2B | Achievement badges | MEDIUM | Calculated, not stored |
| 3A | Team submissions design | MEDIUM | New feature, needs design approval |
| 4A | Comments system | LOW | Nice to have |

---

## Key Files Reference

```
Authentication:
- server/auth.ts (requireAuth, requireVSCodeAuth, passport setup)

Database Schema:
- shared/schema.ts (ALL tables and types)

Routes:
- server/routes/index.ts (route registration)
- server/routes/blockchainRoutes.ts (pool bounties)
- server/routes/communityBounties.ts (community bounties)
- server/routes/promotionalBounties.ts (promotional bounties)

Smart Contracts:
- contracts/DualCurrencyRepoRewards.sol (pool system)
- contracts/CommunityBountyEscrow.sol (community system)
- contracts/ROXNToken.sol (token)

Frontend:
- client/src/pages/ (page components)
- client/src/components/ (shared components)
```

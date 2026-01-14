# Roxonn GitHub Bot - Command Reference

**Last Updated:** 2025-01-14
**Version:** 1.1.0

> **Quick Links:**
> [Pool Bounties](#pool-bounties) | [Community Bounties](#community-bounties) | [Status Commands](#status-commands) | [Troubleshooting](#troubleshooting)

---

## Overview

The Roxonn GitHub Bot (`@roxonn`) automates bounty creation, claiming, and payouts directly from GitHub issues and pull requests. There are **two types of bounties**:

1. **Pool Bounties** - Funded by repository pool managers from pre-funded pools (requires repo registration)
2. **Community Bounties** - Funded by any user on any public repository (permissionless, no registration required)

### Authentication & Permissions

| Action | Authentication Required | Special Permissions |
|--------|------------------------|---------------------|
| Create pool bounty | ✅ Yes (pool manager) | Must be registered pool manager |
| Create community bounty | ✅ Yes (any GitHub user) | None - permissionless |
| Claim bounty | ✅ Yes (PR author) | Must have merged PR that closes issue |
| Check status | ❌ No | Public information |
| Request bounty | ❌ No | Creates request for pool managers to review |

---

## Command Syntax Reference

All commands can be invoked with either `/` or `@roxonn` prefix:

| Command | Slash Syntax | Mention Syntax | Type |
|---------|--------------|----------------|------|
| Pool bounty | `/bounty pool <amount> <currency>` | `@roxonn bounty pool <amount> <currency>` | Pool |
| Community bounty | `/bounty <amount> <currency>` | `@roxonn bounty <amount> <currency>` | Community |
| Claim | `/claim #<PR number>` | N/A | Both |
| Status | N/A | `@roxonn status` | Both |
| Request | `/bounty` | `@roxonn bounty` | Pool |

---

## Pool Bounties

Pool bounties are funded from a **repository's pre-funded bounty pool**, managed by designated pool managers. Requires repository registration on Roxonn platform.

### Command: `/bounty pool <amount> <currency>`

Allocates a bounty from the repository's pool to the current issue.

#### Syntax
```
/bounty pool <amount> <currency>
```

#### Parameters
- `<amount>` - Bounty amount (decimal, 0.00000001 - 1000000)
- `<currency>` - One of: `XDC`, `ROXN`, `USDC`

#### Examples
```
/bounty pool 100 USDC
```
Creates a 100 USDC pool bounty on the current issue.

```
@roxonn bounty pool 50 XDC
```
Creates a 50 XDC pool bounty using mention syntax.

```
/bounty pool 250.50 ROXN
```
Creates a 250.50 ROXN pool bounty with decimal amount.

#### Preconditions
✅ **Required:**
- Repository must be registered on Roxonn platform
- Commenter must be a **pool manager** for this repository
- Pool must have sufficient balance for `<amount>` + gas fees
- Issue must NOT already have a pool bounty allocated

❌ **Not Allowed:**
- Non-pool managers cannot allocate from pool
- Cannot allocate to issues in unregistered repositories
- Cannot exceed available pool balance

#### Success Response
```markdown
✅ Bounty Allocated: 100 USDC

Pool Manager: @username
Issue: #123 - Fix authentication bug
Allocated: 100 USDC

The bounty will be paid out automatically when this issue is closed with a merged PR.
```

#### Failure Responses

**1. Not a Pool Manager**
```markdown
❌ Error: Unauthorized

Only pool managers can allocate bounties from the repository pool.
Current pool managers: @alice, @bob

To create a personal bounty, use: /bounty 100 USDC (without "pool")
```

**2. Insufficient Pool Balance**
```markdown
❌ Error: Insufficient Pool Balance

Requested: 100 USDC
Available: 45.30 USDC

Please fund the pool or allocate a smaller amount.
Fund pool at: https://roxonn.com/pools/owner/repo
```

**3. Bounty Already Exists**
```markdown
❌ Error: Bounty Already Exists

This issue already has a pool bounty allocated: 50 USDC
Allocated by: @alice on Dec 27, 2025

To increase the bounty, contact a pool manager.
```

**4. Repository Not Registered**
```markdown
❌ Error: Repository Not Registered

This repository is not registered on Roxonn platform.

Register your repository: https://roxonn.com/register
Or create a community bounty: /bounty 100 USDC
```

#### State Changes
- ✅ Bounty created on blockchain (immediately funded from pool)
- ✅ Issue labeled with "bounty" tag (if bot has permissions)
- ✅ Pool balance decreases by `<amount>`
- ✅ Transaction recorded in audit log

#### Blockchain Interaction
- **Contract:** `DualCurrencyRepoRewards.sol`
- **Function:** `allocateIssueReward(repoId, issueNumber, amount, currency)`
- **Gas:** Paid by pool manager's designated wallet
- **Confirmation:** Transaction hash logged and posted in comment

---

## Community Bounties

Community bounties are **permissionless** bounties that any user can create on any public GitHub repository without requiring repository registration or pool manager approval.

### Command: `/bounty <amount> <currency>`

Creates a community-funded bounty on the current issue. This is a **two-step process**:
1. **Create** bounty (this command) → Status: `pending_payment`
2. **Pay** bounty (via provided link) → Status: `funded`

#### Syntax
```
/bounty <amount> <currency>
```

⚠️ **Note:** Omitting `pool` keyword creates a **community bounty** (new default behavior)

#### Parameters
- `<amount>` - Bounty amount (decimal, 0.00000001 - 1000000)
- `<currency>` - One of: `XDC`, `ROXN`, `USDC`

#### Examples
```
/bounty 100 USDC
```
Creates a 100 USDC community bounty (pending payment).

```
@roxonn bounty 50 XDC
```
Creates a 50 XDC community bounty using mention syntax.

```
/bounty 1000.25 ROXN
```
Creates a 1000.25 ROXN community bounty.

#### Preconditions
✅ **Required:**
- Commenter must have GitHub account linked to Roxonn platform
- Repository must be **public** (private repos not supported yet)
- Issue must NOT already have an active community bounty

❌ **Not Allowed:**
- Cannot create duplicate bounty on same issue (unless previous was refunded/expired)
- Cannot create bounty on private repositories
- Anonymous users cannot create bounties (must be logged in)

#### Success Response
```markdown
### 💰 Community Bounty Created: 100 USDC

**Issue:** #456 - Implement dark mode
**Amount:** 100 USDC
**Created by:** @creator
**Expires:** Jan 28, 2026 (30 days)

⚠️ **Payment Required:** This bounty is pending payment. Complete payment to activate.

**Pay via:**
🔗 Crypto: https://roxonn.com/bounties/789/pay
💳 Fiat: https://roxonn.com/bounties/789/pay/onramp

**How it works:**
1. You pay 100 USDC to escrow smart contract
2. Bounty status becomes "funded" and visible to contributors
3. When PR is merged closing this issue, contributor can claim
4. Our relayer auto-verifies PR merge and pays out bounty

**Fees:** 1% total (0.5% platform + 0.5% contributor support fund)
**Payout:** 99 USDC to contributor, 1 USDC fees
```

#### Failure Responses

**1. Duplicate Bounty**
```markdown
❌ Error: Bounty Already Exists

This issue already has an active community bounty:
- Amount: 50 USDC
- Status: funded
- Created by: @alice

You cannot create a duplicate bounty on the same issue.
```

**2. Private Repository**
```markdown
❌ Error: Private Repository

Community bounties are only supported on public repositories.

For private repos:
- Register your repository on Roxonn
- Create a pool bounty: /bounty pool 100 USDC
```

**3. Not Authenticated**
```markdown
❌ Error: Authentication Required

Please link your GitHub account to Roxonn platform to create bounties.

Sign up: https://roxonn.com/signup
Link account: https://roxonn.com/settings/github
```

#### State Changes After Payment
After the creator completes payment via the provided link:
- ✅ Bounty status: `pending_payment` → `funded`
- ✅ Funds locked in escrow smart contract
- ✅ Bounty visible in community bounty explorer
- ✅ Issue becomes claimable

#### Blockchain Interaction
- **Contract:** `CommunityBountyEscrow.sol`
- **Function:** `createBounty(issueId, amount, currency, expiry)`
- **Gas:** Paid by bounty creator
- **Escrow:** Funds locked until claim or expiry
- **Refund:** Creator can refund after expiry if unclaimed

#### Expiry & Refunds
- **Default Expiry:** 30 days from creation (configurable)
- **Refund Eligible:** After expiry date, if status is still `funded` (not claimed)
- **Refund Process:** Creator calls `/refund` command or uses web UI
- **No Fees on Refund:** Full amount returned (100% refund)

---

## Claiming Bounties

Both pool and community bounties are claimed the same way: by submitting the PR number that closed the issue.

### Command: `/claim #<PR number>`

Claims a bounty by providing the pull request number that resolved the issue.

#### Syntax
```
/claim #<PR number>
```

or

```
/claim <PR number>
```

(# is optional)

#### Parameters
- `<PR number>` - The pull request number (integer, no leading zeros)

#### Examples
```
/claim #42
```
Claims bounty using PR #42.

```
/claim 123
```
Claims bounty using PR #123 (# optional).

#### Preconditions
✅ **Required:**
- Issue must have an active bounty (pool or community)
- Bounty status must be `funded`
- Commenter must be the **author of the PR**
- PR must be **merged** (verified by relayer before payout)
- PR must **close this issue** (via "fixes #X", "closes #X", etc.)
- Claimer must have XDC wallet linked to Roxonn account

❌ **Not Allowed:**
- Cannot claim if not PR author
- Cannot claim unmerged PRs (will fail verification)
- Cannot claim if bounty already claimed by someone else
- Cannot claim if PR doesn't close the issue

#### Success Response (Pool Bounty)
```markdown
✅ Bounty Claimed!

**PR:** #42 - Fix authentication bug
**Contributor:** @contributor
**Bounty:** 100 USDC

Your claim has been recorded. The bounty will be distributed automatically once this issue is closed.

Wallet: xdc1234...5678
Estimated payout: 100 USDC (pool bounties have no fees)
```

#### Success Response (Community Bounty)
```markdown
✅ Bounty Claimed!

**PR:** #42 - Implement dark mode
**Contributor:** @contributor
**Bounty:** 100 USDC
**Status:** Verification pending

**Next Steps:**
1. Our relayer service will verify your PR is merged (runs every 30 seconds)
2. Once verified, payout will be executed automatically
3. You'll receive funds at: xdc1234...5678

**Estimated Payout:**
- Bounty: 100 USDC
- Platform fee (0.5%): 0.50 USDC
- Contributor fund (0.5%): 0.50 USDC
- **Net payout:** 99 USDC

**Verification Criteria:**
✅ PR is merged
✅ PR closes this issue (#456)
✅ GitHub timeline confirms merge

Track payout: https://roxonn.com/bounties/789
```

#### Failure Responses

**1. No Bounty on Issue**
```markdown
❌ Error: No Bounty Found

This issue does not have an active bounty.

Create a bounty: /bounty 100 USDC
```

**2. Already Claimed**
```markdown
❌ Error: Bounty Already Claimed

This bounty was already claimed by @alice via PR #40.

Status: Completed
Payout: Sent on Dec 27, 2025
TX: https://explorer.xdc.network/tx/0x123...
```

**3. Not PR Author**
```markdown
❌ Error: Unauthorized

Only the author of PR #42 can claim this bounty.

PR Author: @bob
Your account: @alice

If you contributed to this PR, ask @bob to claim and split the reward.
```

**4. No Wallet Linked**
```markdown
❌ Error: Wallet Not Configured

Please set up your XDC wallet to receive bounty payouts.

Setup wallet: https://roxonn.com/settings/wallet

1. Connect XDC wallet (via XDCPay or private key)
2. Return here and re-run: /claim #42
```

**5. Bounty Not Funded**
```markdown
❌ Error: Bounty Not Funded

This bounty is still pending payment from creator @alice.

Status: pending_payment
Created: Dec 27, 2025
Payment link: https://roxonn.com/bounties/789/pay

Please wait for creator to complete payment, or create your own bounty.
```

#### State Changes
- ✅ Bounty status: `funded` → `claimed`
- ✅ Claimer recorded: `@username` + `wallet address`
- ✅ PR number recorded: `#42`
- ✅ Timestamp recorded: `claimed_at`

#### Automated Payout Process (Community Bounties)
After claim, the relayer service (runs every 30 seconds) will:
1. ✅ Verify PR is merged via GitHub API
2. ✅ Verify PR closes the issue (via PR body: "fixes #X")
3. ✅ Verify GitHub timeline shows merge event
4. ✅ Call smart contract `completeBounty(bountyId, contributor)`
5. ✅ Update bounty status: `claimed` → `completed`
6. ✅ Store payout transaction hash

**Estimated Time:** 30-60 seconds after PR merge
**Manual Retry:** Contact support if payout doesn't occur within 5 minutes

---

## Status Commands

### Command: `@roxonn status`

Displays the current bounty status for the issue.

#### Syntax
```
@roxonn status
```

⚠️ **Note:** This command ONLY works with `@roxonn` mention, not `/status`

#### Examples
```
@roxonn status
```

#### Preconditions
- None (public command, no authentication required)

#### Success Response (Pool Bounty)
```markdown
### 📊 Bounty Status

**Type:** Pool Bounty
**Amount:** 100 USDC
**Status:** 🟢 Active
**Allocated by:** @alice
**Allocated on:** Dec 27, 2025

**Pool Balance:** 450 USDC remaining

The bounty will be paid out automatically when this issue is closed with a merged PR.
```

#### Success Response (Community Bounty - Pending)
```markdown
### 📊 Bounty Status

**Type:** Community Bounty
**Amount:** 100 USDC
**Status:** ⏳ Pending Payment
**Created by:** @bob
**Created on:** Dec 27, 2025
**Expires:** Jan 28, 2026

This bounty is awaiting payment from the creator.

Payment link: https://roxonn.com/bounties/789/pay
```

#### Success Response (Community Bounty - Funded)
```markdown
### 📊 Bounty Status

**Type:** Community Bounty
**Amount:** 100 USDC
**Status:** 🟢 Funded
**Created by:** @bob
**Funded on:** Dec 27, 2025
**Expires:** Jan 28, 2026

**Smart Contract:** https://explorer.xdc.network/address/0xABC...
**Escrow TX:** https://explorer.xdc.network/tx/0x123...

✅ This bounty is claimable! Submit a PR that closes this issue and run:
`/claim #<your-PR-number>`

**Estimated Payout:**
- Bounty: 100 USDC
- Fees (1%): 1 USDC
- **Your payout:** 99 USDC
```

#### Success Response (Claimed)
```markdown
### 📊 Bounty Status

**Type:** Community Bounty
**Amount:** 100 USDC
**Status:** 🔵 Claimed
**Claimed by:** @charlie
**PR:** #42
**Claimed on:** Dec 28, 2025

**Verification Status:** ⏳ Pending

The relayer service is verifying the PR merge. Payout will occur automatically within 1-2 minutes.
```

#### Success Response (Completed)
```markdown
### 📊 Bounty Status

**Type:** Community Bounty
**Amount:** 100 USDC
**Status:** ✅ Completed
**Paid to:** @charlie (xdc1234...5678)
**Payout:** 99 USDC
**Paid on:** Dec 28, 2025

**Payout TX:** https://explorer.xdc.network/tx/0x789...

Bounty successfully distributed! 🎉
```

#### No Bounty Response
```markdown
### 📊 Bounty Status

**Status:** ❌ No Bounty

This issue does not have an active bounty.

**Create a bounty:**
- Pool bounty (pool managers): `/bounty pool 100 USDC`
- Community bounty (anyone): `/bounty 100 USDC`
- Request bounty: `/bounty`
```

---

## Bounty Request (Pool Only)

### Command: `/bounty`

Requests that a pool manager allocate a bounty to this issue (for registered repositories only).

#### Syntax
```
/bounty
```

or

```
@roxonn bounty
```

(No amount/currency provided)

#### Examples
```
/bounty
```
Creates a bounty request.

```
@roxonn bounty
```
Creates a bounty request via mention.

#### Preconditions
✅ **Required:**
- Repository must be registered on Roxonn platform
- Issue must NOT already have a bounty

❌ **Not Allowed:**
- Cannot request if bounty already exists
- Cannot request on unregistered repositories

#### Success Response
```markdown
✅ Bounty Request Submitted

@alice, @bob - Please review this bounty request.

**Requested by:** @contributor
**Issue:** #789 - Add API documentation

Pool managers can allocate using:
`/bounty pool <amount> <currency>`

Example: `/bounty pool 100 USDC`
```

#### Failure Response (Already Has Bounty)
```markdown
❌ Error: Bounty Already Exists

This issue already has a bounty: 50 USDC

Request unnecessary - contributors can start work on this issue.
```

#### State Changes
- ✅ Request recorded in `bounty_requests` table
- ✅ Pool managers notified (if webhook configured)
- ❌ NO bounty created (requires pool manager approval)

#### Rate Limiting
- **Limit:** 1 request per user per issue per minute
- **Prevents:** Spam requests

---

## Edge Cases & Error Scenarios

### Invalid Amount Format
```
/bounty 100.123456789 USDC
```
**Error:** Amount has too many decimals (max 8 decimals allowed)

```
/bounty -50 XDC
```
**Error:** Amount must be positive

```
/bounty 0 ROXN
```
**Error:** Amount must be greater than 0

```
/bounty 999999999 USDC
```
**Error:** Amount exceeds maximum (1,000,000)

### Invalid Currency
```
/bounty 100 BTC
```
**Error:** Unsupported currency. Supported: XDC, ROXN, USDC

```
/bounty 100 usdc
```
**Error:** Currency must be uppercase: USDC (not usdc)

### Malformed Commands
```
/bounty pool
```
**Error:** Missing amount and currency. Usage: /bounty pool <amount> <currency>

```
/claim
```
**Error:** Missing PR number. Usage: /claim #<PR number>

```
/bounty 100
```
**Error:** Missing currency. Usage: /bounty <amount> <currency>

### Network/Blockchain Errors
```
/bounty pool 100 USDC
```
**Blockchain Error:** Transaction failed - insufficient gas. Please try again.

```
/bounty 100 XDC
```
**Payment Error:** Payment gateway timeout. Your bounty was created but not funded. Complete payment at: [link]

### Permission Errors
```
/bounty pool 100 USDC
```
**Posted by non-pool-manager:**
❌ Only pool managers can allocate from the pool. Current pool managers: @alice, @bob

```
/claim #42
```
**Posted by non-PR-author:**
❌ Only the author of PR #42 can claim this bounty. PR author: @bob

---

## Troubleshooting

### "Command not recognized"
- ✅ Check spelling: `/bounty` not `/bountie`
- ✅ Use lowercase: `/bounty` not `/BOUNTY`
- ✅ Ensure no typos: `/claim #42` not `/cliam #42`

### "Bounty not showing up"
- ⏳ Pool bounties are created instantly (blockchain confirmation takes 10-30 seconds)
- ⏳ Community bounties require payment first (status `pending_payment` until paid)
- ⏳ Refresh issue page or check blockchain explorer

### "Payment link not working"
- 🔄 Try alternative payment method (crypto vs fiat)
- 🔄 Check wallet connection (XDCPay, MetaMask)
- 🔄 Verify sufficient balance + gas fees
- 📧 Contact support: support@roxonn.com

### "Claim not processing"
- ⏳ Wait 1-2 minutes for relayer service (runs every 30 seconds)
- ✅ Verify PR is actually merged (not just approved)
- ✅ Verify PR body contains "fixes #X" or "closes #X"
- ✅ Check bounty status: `@roxonn status`

### "Payout failed"
- ❌ Check relayer logs for verification errors
- ❌ Verify wallet address is correct
- ❌ Ensure PR meets all verification criteria
- 📧 Contact support with bounty ID

---

## Command Summary Table

| Command | Type | Auth Required | Permission | Creates What | Immediate Action |
|---------|------|---------------|------------|--------------|------------------|
| `/bounty pool <amount> <currency>` | Pool | Yes | Pool manager | Funded bounty | ✅ Blockchain TX |
| `/bounty <amount> <currency>` | Community | Yes | Any user | Pending bounty | ❌ Awaits payment |
| `/claim #<PR>` | Both | Yes | PR author | Claim record | ⏳ Awaits verification |
| `@roxonn status` | Both | No | Public | N/A | ℹ️ Info only |
| `/bounty` | Pool | No | Public | Request | ❌ No bounty |

---

## Frequently Asked Questions

**Q: What's the difference between pool and community bounties?**
A: Pool bounties are funded from a repository's pre-funded pool (instant, requires registration). Community bounties are funded individually by any user (requires payment step, no registration).

**Q: Can I create a bounty on a private repository?**
A: Only pool bounties support private repositories (requires registration). Community bounties are public repositories only.

**Q: What are the fees?**
A:
- Pool bounties: 0% fees (fully paid from pool)
- Community bounties: 1% total (0.5% platform + 0.5% contributor support fund)

**Q: How long until payout after PR merge?**
A:
- Pool bounties: Automatic when issue closes (requires pool manager present)
- Community bounties: 30-60 seconds (relayer service verification)

**Q: Can I cancel a bounty?**
A:
- Pool bounties: Contact pool manager to deallocate
- Community bounties: Refund available after expiry date (if unclaimed)

**Q: What if my PR doesn't have "fixes #X" in the body?**
A: The relayer requires this keyword to verify the PR closes the issue. Edit your PR description to include "fixes #123" or "closes #123".

**Q: Can multiple people claim the same bounty?**
A: No - first successful claim wins. Status changes to `claimed` immediately, preventing duplicates.

**Q: What happens if I don't pay a community bounty?**
A: Bounty remains in `pending_payment` status indefinitely. It won't be visible to contributors and can't be claimed. You can pay anytime via the payment link.

---

## API Endpoints (For Advanced Users)

All bot commands also have equivalent REST API endpoints:

- `POST /api/community-bounties` - Create community bounty
- `POST /api/community-bounties/:id/pay` - Pay for bounty
- `POST /api/community-bounties/:id/claim` - Claim bounty
- `GET /api/community-bounties` - List bounties
- `GET /api/community-bounties/:id` - Get single bounty
- `GET /api/community-bounties/leaderboard` - Top contributors

See API documentation: https://roxonn.com/docs/api

---

## Support

- **Documentation:** https://roxonn.com/docs
- **Discord:** https://discord.gg/roxonn
- **Email:** support@roxonn.com
- **GitHub Issues:** https://github.com/roxonn/platform/issues

---

**Version History:**
- v1.0.0 (2025-12-28): Initial command reference documentation

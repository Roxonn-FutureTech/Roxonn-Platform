# Bounty Fix

**Reward:** $100.00
**Issue:** https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues/96
**Repo:** https://github.com/Roxonn-FutureTech/Roxonn-Platform

---

## Issue

Implement GitHub Bot with Auto-Comment on Issues and Auto-Payout on PR Merge

## Summary
Build a GitHub App bot (similar to Algora.io) that automatically comments on issues with bounty instructions and auto-pays contributors when their PRs are merged.

## Problem
- Users need clear instructions on how to participate in bounties
- Manual payout process is slow and error-prone
- No visibility into who is working on what

## Solution Implemented

### 1. GitHub App Integration
- Created Roxonn Contribution Rewards GitHub App
- Webhook handlers for GitHub events
- Secure signature verification with `@octokit/webhooks`
- Installation token management per repository

### 2. Auto-Comment on Issue Opened
When a new issue is created in a repo with the bot installed:
- Bot posts welcome comment with bounty instructions
- Explains `/bounty <amount> <currency>` command
- Explains `/attempt` command for developers
- Shows "Who's Working on This?" tracker table
- Includes FAQ and submission requirements

### 3. Command Handling
- `/bounty <amount> <currency>` - Creates bounty with payment links
- `/attempt` - Records developer intent, updates tracker
- `@roxonn status` - Shows current bounty status

### 4. Auto-Payout on PR Merge
When a PR with `fixes #<issue>` is merged:
- Bot detects linked issues
- Verifies funded bounty exists
- Checks contributor has wallet connected
- Posts payout confirmation comment
- Triggers blockchain payout within 60 seconds

### 5. Attempt Tracking
- Real-time updates to "Who's Working on This?" table
- Shows developer username, start time, status
- Prevents duplicate work

## Files Created/Modified
- `server/github.ts` - Core bot logic
  - `handleIssueOpened()` - Welcome comment
  - `generateWelcomeComment()` - Comment template
  - `handleBountyCommand()` - Bounty creation
  - `handleAttemptCommand()` - Attempt tracking
  - `handlePullRequestMergedForAutoPayout()` - Auto-pay
- `server/routes/webhookRoutes.ts` - Webhook routing
- `server/config.ts` - GitHub App configuration

## Webhook Events Handled
| Event | Handler | Action |
|-------|---------|--------|
| `issues.opened` | `handleIssueOpened` | Post welcome comment |
| `issue_comment.created` | Command parser | Process /bounty, /attempt |
| `pull_request.closed` (merged) | `handlePullRequestMergedForAutoPayout` | Auto-pay |

## Security Features
- HMAC-SHA256 webhook signature verification
- Idempotency via `x-github-delivery` header
- SSRF protection on GitHub API calls
- Rate limiting (1 command/min/user/issue)

## Testing
- [x] Bot posts welcome comment on new issues
- [x] `/bounty 100 USDC` creates bounty with payment links
- [x] `/attempt` records intent and updates tracker
- [x] PR merge triggers auto-payout
- [x] Webhook signatures validated correctly


---

## Process

### 1. Orient yourself first
Before touching any code:
- Read the README and any relevant docs
- Run: find . -type f | grep -v node_modules | grep -v .git | grep -v dist | head -60
- Grep for the key terms from the issue title to find the relevant files
- Read the files around the bug — understand what's currently happening

### 2. Find and read the tests
- Look for test files near the relevant code (*.test.ts, *.spec.js, __tests__, etc.)
- Read them — they tell you what behavior is expected
- Understand what a passing fix looks like before writing a line

### 3. Implement the fix
- Make the MINIMAL change that fixes the issue — nothing more
- Do not refactor, rename, reorganize, or clean up unrelated code
- Do not add dependencies unless the issue explicitly requires it
- Do not modify config files (package.json, tsconfig.json, etc.) unless that IS the fix
- One logical change, one commit

### 4. Verify
- Run the test suite: check package.json scripts for "test", "lint", "typecheck"
  Common commands: npm test, yarn test, pnpm test, pytest, go test ./..., cargo test
- If TypeScript is present: npx tsc --noEmit
- Fix any test failures your change caused — if a test was wrong before, update it

### 5. Commit and document
- git add -A
- git commit -m "fix: Implement GitHub Bot with Auto-Comment on Issues and Auto-Payout on PR M"
- Write AGENT_SUMMARY.md with:
  - Root cause: what was wrong and why
  - Fix: what you changed and the reasoning
  - Verification: how to confirm it works
  - Concerns: anything a reviewer should know

---

## Stop conditions

If ANY of these are true, write "UNCERTAIN: [reason]" at the top of AGENT_SUMMARY.md, make NO code changes, and stop:
- The fix requires changing more than ~5 files
- You cannot determine what the correct behavior should be
- The issue requires a database migration, API key, or external service
- You find 3+ open PRs already attempting this fix (high competition)
- The repo is not in a language/framework you can reason about confidently

A clean UNCERTAIN is better than a bad PR.

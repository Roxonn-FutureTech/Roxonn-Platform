# Bounty Objective: Implement GitHub Bot with Auto-Comment on Issues and Auto-Payout on PR Merge
Target: Roxonn-FutureTech/Roxonn-Platform Issue #96
URL: https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues/96

## Issue Description
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


## Instructions for Kuro (Autonomous Solver):
1. Use skills: `systematic-debugging` and `code-review-and-quality`.
2. Inspect the repository structure, locate relevant files, and understand the bug/feature.
3. Apply the minimal, robust fix or implementation.
4. Run any existing test suites or linters in the workspace.
5. Ensure the fix adheres to the project's existing code style.
6. When done, output a summary of files modified and verification results.

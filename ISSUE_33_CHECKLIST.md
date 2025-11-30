# Issue #33 Implementation Checklist: `/bounty` Bot Commands

## Database Schema
- [ ] Add `bountyRequests` table to `shared/schema.ts`
- [ ] Add Zod validation schema for bounty requests
- [ ] Export types for bounty requests

## Command Parser
- [ ] Create `parseBountyCommand` function in `server/github.ts`
- [ ] Support `/bounty <amount> <currency>` syntax
- [ ] Support `/bounty` (request only) syntax
- [ ] Support `@roxonn bounty <amount> <currency>` syntax
- [ ] Support `@roxonn bounty` (request only) syntax
- [ ] Validate currencies (XDC, ROXN, USDC)
- [ ] Validate amount format

## Webhook Handler
- [ ] Add `issue_comment` event handling in `server/routes.ts`
- [ ] Verify webhook signature
- [ ] Parse comment body for commands
- [ ] Route to `handleBountyCommand` function
- [ ] Return appropriate responses

## Bounty Command Handler
- [ ] Create `handleBountyCommand` function
- [ ] Verify repository is registered
- [ ] Check if commenter is pool manager
- [ ] Handle pool manager allocation flow
- [ ] Handle contributor request flow
- [ ] Add rate limiting (1 command per issue per minute)
- [ ] Validate amount and currency
- [ ] Check pool balance for allocations

## Bot Comments
- [ ] Create `postGitHubComment` helper function
- [ ] Template for successful allocation
- [ ] Template for bounty request created
- [ ] Template for error messages
- [ ] Template for invalid command syntax
- [ ] Template for insufficient funds
- [ ] Template for not authorized

## Blockchain Integration
- [ ] Reuse `allocateIssueBounty` for allocations
- [ ] Handle blockchain errors gracefully
- [ ] Update pool balance after allocation

## Storage Methods
- [ ] Add `createBountyRequest` method
- [ ] Add `getBountyRequest` method
- [ ] Add `updateBountyRequest` method
- [ ] Add `getBountyRequestsByIssue` method

## Security & Validation
- [ ] Webhook signature verification
- [ ] Pool manager verification
- [ ] Amount validation (positive, reasonable limits)
- [ ] Rate limiting implementation
- [ ] Input sanitization for bot responses
- [ ] Error handling for all edge cases

## Testing Checklist
- [ ] Pool manager can allocate bounty via `/bounty 10 XDC`
- [ ] Contributor can request bounty via `/bounty`
- [ ] Alternative syntax `@roxonn bounty` works
- [ ] Invalid commands show helpful error
- [ ] Rate limiting prevents spam
- [ ] Insufficient funds handled correctly
- [ ] Unregistered repos handled correctly
- [ ] Non-pool managers can't allocate


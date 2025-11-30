# Promotional Bounties Implementation

## Overview

This implementation addresses [GitHub Issue #5](https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues/5) - "Feature Request & Discussion: Enable Pool Managers to Create Promotional Bounties for Their Projects".

## Implementation Alignment with Issue #5

### ✅ MVP Requirements Met

Per the issue specification, the MVP scope includes:

1. **✅ Promotional Bounty Type**
   - New "PROMOTIONAL" bounty type created
   - Associated with registered repositories (as specified: "associated with their registered repository")

2. **✅ Required Input Fields**
   - ✅ Promotional task description (`description` field)
   - ✅ Required channel(s) (`promotionalChannels` - array of channels)
   - ✅ Specific deliverable expected (`requiredDeliverable` field)
   - ✅ ROXN bounty amount (`rewardAmount` field)

3. **✅ Submission Mechanism**
   - Simple submission mechanism for contributors to provide links/proof
   - Multiple proof links supported (`proofLinks` array)
   - Optional description field

4. **✅ Manual Review System**
   - Manual review and approval of submissions by Pool Manager
   - Review notes support
   - Status tracking (PENDING, APPROVED, REJECTED)

### Key Design Decisions

1. **Repository Association**: 
   - Bounties are linked to `registeredRepositories` table (not a separate projects table)
   - This aligns with the issue requirement: "associated with their registered repository"
   - Pool Managers use their existing registered repositories

2. **Many-to-One Bounties**:
   - Implemented with optional `maxSubmissions` limit
   - Supports unlimited submissions by default
   - Pool Managers can set limits if needed

3. **Proof of Work**:
   - Multiple proof links per submission (stored as JSONB array)
   - Manual review by Pool Managers
   - Future: Can be extended with automated verification

4. **Reward Types**:
   - PER_SUBMISSION: Fixed reward per approved submission
   - POOL: Shared reward pool (future: distribution logic)
   - TIERED: Tiered rewards (future: impact-based tiers)

## API Endpoints

### Repositories
- `GET /api/promotional/repositories` - Get user's registered repositories

### Bounties
- `GET /api/promotional/bounties` - Get all bounties (with filters: type, status, repoId, channel)
- `GET /api/promotional/bounties/promotional` - Get promotional bounties specifically
- `GET /api/promotional/bounties/:id` - Get bounty by ID
- `POST /api/promotional/bounties` - Create bounty (Pool Manager only)
- `PATCH /api/promotional/bounties/:id/status` - Update bounty status

### Submissions
- `GET /api/promotional/submissions` - Get all submissions (with filters)
- `GET /api/promotional/submissions/:id` - Get submission by ID
- `POST /api/promotional/submissions` - Create submission (Contributors)
- `PATCH /api/promotional/submissions/:id/review` - Review submission (Pool Manager only)

## Database Schema

### Tables Added

1. **promotional_bounties**
   - Links to `registeredRepositories` (not a separate projects table)
   - Supports multiple promotional channels (JSONB array)
   - Reward configuration (amount, type, pool settings)
   - Status management (DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED)

2. **promotional_submissions**
   - Links to bounties and contributors
   - Proof links stored as JSONB array
   - Review tracking with notes

## Differences from Standalone Implementation

The standalone implementation in `Agent_Bug` used:
- Separate `projects` table
- SQLite database
- Prisma ORM

The Roxonn Platform integration uses:
- `registeredRepositories` table (existing)
- PostgreSQL database
- Drizzle ORM
- Integration with existing authentication system

## Testing Checklist

- [ ] Pool Manager can create promotional bounties for their registered repositories
- [ ] Contributors can browse and filter promotional bounties
- [ ] Contributors can submit proof links
- [ ] Pool Managers can review and approve/reject submissions
- [ ] Bounties are properly associated with registered repositories
- [ ] All required fields from issue #5 are present and validated

## Future Enhancements (Not in MVP)

As mentioned in issue #5, these are future considerations:
- Automated proof verification
- Campaign management with multiple related bounties
- Analytics and reporting
- Impact-based reward tiers
- Social media API integration
- Smart contract integration for on-chain rewards


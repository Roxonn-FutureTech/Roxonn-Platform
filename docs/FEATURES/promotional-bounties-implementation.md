# Promotional Bounties Implementation

This adds support for promotional bounties as described in [GitHub Issue #5](https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues/5).

## MVP Requirements

1. **Promotional Bounty Type**
   - New "PROMOTIONAL" bounty type
   - Linked to registered repositories

2. **Required Input Fields**
   - Task description
   - Promotional channels (array)
   - Required deliverable
   - ROXN reward amount

3. **Submission System**
   - Contributors can submit proof links
   - Multiple links per submission
   - Optional description

4. **Review System**
   - Pool managers review and approve/reject
   - Review notes
   - Status: PENDING, APPROVED, REJECTED

### Design Notes

1. **Repository Association**: 
   - Bounties link to `registeredRepositories` table
   - Pool managers use their existing repos

2. **Many-to-One Bounties**:
   - Optional `maxSubmissions` limit
   - Unlimited by default

3. **Proof of Work**:
   - Multiple proof links per submission
   - Manual review by pool managers
   - Could add automated verification later

4. **Reward Types**:
   - PER_SUBMISSION: Fixed per submission
   - POOL: Shared pool (distribution logic TBD)
   - TIERED: Impact-based tiers (TBD)

## API Endpoints

### Repositories

### Bounties
- `GET /api/promotional/bounties` - List bounties (filters: type, status, repoId, channel)
- `GET /api/promotional/bounties/promotional` - Promotional bounties only
- `GET /api/promotional/bounties/:id` - Get bounty details
- `POST /api/promotional/bounties` - Create bounty (pool managers)
- `PATCH /api/promotional/bounties/:id/status` - Update status

### Submissions
- `GET /api/promotional/submissions` - List submissions (filters available)
- `GET /api/promotional/submissions/:id` - Get submission details
- `POST /api/promotional/submissions` - Submit proof (contributors)
- `PATCH /api/promotional/submissions/:id/review` - Review submission (pool managers)

## Database Schema

1. **promotional_bounties**
   - Links to `registeredRepositories`
   - Promotional channels (JSONB array)
   - Reward config (amount, type, pool)
   - Status: DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED

2. **promotional_submissions**
   - Links to bounties and contributors
   - Proof links (JSONB array)
   - Review notes and status

## Differences from Standalone Version

Standalone (`Agent_Bug`):
- Separate projects table
- SQLite
- Prisma

Roxonn Platform:
- Uses existing `registeredRepositories`
- PostgreSQL
- Drizzle ORM
- Integrated with existing auth

## Testing

- [ ] Pool managers can create bounties for their repos
- [ ] Contributors can browse/filter bounties
- [ ] Contributors can submit proof
- [ ] Pool managers can review submissions
- [ ] Bounties linked to registered repos correctly
- [ ] All required fields validated

## Future Work

- Automated proof verification
- Campaign management
- Analytics
- Impact-based tiers
- Social media API integration
- On-chain rewards


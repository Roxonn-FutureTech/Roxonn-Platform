# Promotional Bounties Implementation Checklist

## User Story 1: Pool Manager Features

### ✅ Bounty Creation
- [x] Pool Manager can create promotional bounties for their registered repositories
- [x] Bounties are associated with registered repositories (not separate projects)
- [x] Promotional task description field
- [x] Required channel(s) selection (Twitter, LinkedIn, Facebook, Instagram, YouTube, Blog, Forum, Other)
- [x] Specific deliverable expected field
- [x] ROXN bounty amount field
- [x] Reward type selection (PER_SUBMISSION, POOL, TIERED)
- [x] Optional max submissions limit
- [x] Optional total reward pool
- [x] Optional expiration date
- [x] Status management (DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED)

### ✅ Bounty Management
- [x] Pool Manager can view all their bounties
- [x] Pool Manager can update bounty status
- [x] Pool Manager can see submissions for their bounties

### ✅ Review System
- [x] Pool Manager can review submissions
- [x] Pool Manager can approve submissions
- [x] Pool Manager can reject submissions
- [x] Pool Manager can add review notes
- [x] Review happens directly on Roxonn platform

## User Story 2: Contributor Features

### ✅ Discovery
- [x] Contributors can browse all promotional bounties
- [x] Contributors can filter by status (ACTIVE, etc.)
- [x] Contributors can filter by promotional channel
- [x] Contributors can filter by repository
- [x] Contributors can view bounty details

### ✅ Participation
- [x] Contributors can submit proof/links
- [x] Multiple proof links per submission
- [x] Optional description/context
- [x] Submission status tracking (PENDING, APPROVED, REJECTED)
- [x] Contributors can view their submissions
- [x] Contributors can see review notes

## Technical Requirements

### ✅ Backend API
- [x] GET /api/promotional/repositories - Get user's repos
- [x] GET /api/promotional/bounties - List bounties with filters
- [x] GET /api/promotional/bounties/promotional - Promotional only
- [x] GET /api/promotional/bounties/:id - Get bounty details
- [x] POST /api/promotional/bounties - Create bounty (pool managers)
- [x] PATCH /api/promotional/bounties/:id/status - Update status
- [x] GET /api/promotional/submissions - List submissions
- [x] GET /api/promotional/submissions/:id - Get submission details
- [x] POST /api/promotional/submissions - Submit proof
- [x] PATCH /api/promotional/submissions/:id/review - Review submission

### ✅ Database Schema
- [x] promotional_bounties table exists
- [x] Linked to registeredRepositories (repoId)
- [x] promotionalChannels stored as JSONB array
- [x] requiredDeliverable field
- [x] rewardAmount field
- [x] rewardType field
- [x] maxSubmissions field (optional)
- [x] totalRewardPool field (optional)
- [x] promotional_submissions table exists
- [x] proofLinks stored as JSONB array
- [x] Review fields (reviewedAt, reviewedBy, reviewNotes)

### ✅ Validation
- [x] Input validation with Zod schemas
- [x] Promotional channels required for PROMOTIONAL type
- [x] Required deliverable validation
- [x] Proof links must be valid URLs
- [x] Authorization checks (pool managers only for creation/review)

### ✅ Many-to-One Support
- [x] Multiple submissions allowed per bounty
- [x] Optional max submissions limit enforced
- [x] Pool-based reward type supported
- [x] Per-submission reward type supported

## MVP Scope Verification

- [x] Promotional bounty type exists
- [x] Associated with registered repository
- [x] Task description field
- [x] Required channel(s) field
- [x] Specific deliverable field
- [x] ROXN bounty amount field
- [x] Submission mechanism with links/proof
- [x] Manual review on platform
- [x] Pool Manager approval/rejection

## Implementation Status: ✅ COMPLETE

All MVP requirements from GitHub Issue #5 have been implemented and verified.


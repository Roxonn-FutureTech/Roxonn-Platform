# Promotional Bounties Feature

## Overview

The Promotional Bounties feature extends the Roxonn platform to allow Pool Managers to create marketing and promotional bounties for their projects. Contributors can discover and participate in these bounties to earn ROXN rewards for their marketing efforts.

## User Stories

### As a Pool Manager
- I want to define and fund bounties for marketing and promotional tasks related to my project on Roxonn
- I can leverage the Roxonn community (including "RoxStars") to increase my project's visibility and adoption

### As a Contributor/Ambassador
- I want to discover and participate in promotional bounties for various projects
- I can earn rewards for my marketing and advocacy efforts

## Features

### Pool Manager Features
- Create and manage projects
- Create promotional bounties with customizable channels (Twitter, LinkedIn, YouTube, Blog, etc.)
- Define required deliverables and reward structures
- Review and approve/reject submissions
- Manage bounty status (Draft, Active, Paused, Completed)

### Contributor Features
- Browse and discover promotional bounties
- Filter by status, channel, and project
- Submit proof of promotional work (links to social media posts, blog articles, etc.)
- Track submission status and reviews
- Earn ROXN rewards for approved submissions

## API Endpoints


### Bounties
- `GET /api/promotional/bounties` - Get all bounties (with filters)
- `GET /api/promotional/bounties/promotional` - Get promotional bounties
- `GET /api/promotional/bounties/:id` - Get bounty by ID
- `POST /api/promotional/bounties` - Create bounty (Pool Manager only)
- `PATCH /api/promotional/bounties/:id/status` - Update bounty status

### Submissions
- `GET /api/promotional/submissions` - Get all submissions (with filters)
- `GET /api/promotional/submissions/:id` - Get submission by ID
- `POST /api/promotional/submissions` - Create submission (Contributors)
- `PATCH /api/promotional/submissions/:id/review` - Review submission (Pool Manager only)

## Database Schema

### Tables
- `promotional_submissions` - Submissions with proof links and review status

## Implementation Details

- Uses Drizzle ORM with PostgreSQL
- JSONB fields for arrays (promotional channels, proof links)
- Role-based access control (Pool Manager, Contributor, Admin)
- Integration with existing Roxonn authentication system

## Future Enhancements

- Automated proof verification
- Campaign management with multiple related bounties
- Analytics and reporting for Pool Managers
- Impact-based reward tiers
- Integration with social media APIs for verification
- Smart contract integration for on-chain reward distribution


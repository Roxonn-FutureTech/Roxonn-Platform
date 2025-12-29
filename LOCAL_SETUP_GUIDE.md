# Local Development Setup Guide

This guide helps you set up the Roxonn Platform for local development and testing.

## Prerequisites

You need to install:
1. **PostgreSQL** - Database
2. **Node.js** - Already installed ✅

## Step 1: Install PostgreSQL

### Windows:
Download and install from: https://www.postgresql.org/download/windows/

**During installation:**
- Set password for `postgres` user (remember this!)
- Default port: `5432`
- Install pgAdmin 4 (GUI tool)

**After installation:**
```bash
# Test PostgreSQL is running
psql --version
```

## Step 2: Create Database

Open pgAdmin or use command line:

```sql
-- Create database
CREATE DATABASE roxonn_dev;

-- Create user (optional, or use postgres user)
CREATE USER roxonn WITH PASSWORD 'roxonn123';
GRANT ALL PRIVILEGES ON DATABASE roxonn_dev TO roxonn;
```

## Step 3: Configure Environment Variables

The `.env` file is already created at `server/.env`. Update these REQUIRED fields:

```bash
# Update this line with your PostgreSQL credentials
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/roxonn_dev

# Generate secrets (use any random 32+ character strings)
JWT_SECRET=local-dev-jwt-secret-min-32-characters-long
SESSION_SECRET=local-dev-session-secret-min-32-characters
ENCRYPTION_KEY=local-dev-encryption-key-32-char

# For local testing, you can use dummy values
PRIVATE_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

### For GitHub OAuth (REQUIRED for login):

1. Go to: https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - **Application name:** Roxonn Local Dev
   - **Homepage URL:** http://localhost:5000
   - **Callback URL:** http://localhost:5000/api/auth/github/callback
4. Get your `Client ID` and `Client Secret`
5. Update in `.env`:
   ```
   GITHUB_CLIENT_ID=your_actual_client_id
   GITHUB_CLIENT_SECRET=your_actual_client_secret
   ```

## Step 4: Run Database Migrations

```bash
# Install PostgreSQL client tools if needed
npm install -g postgres

# Run migrations
psql postgresql://postgres:YOUR_PASSWORD@localhost:5432/roxonn_dev -f migrations/0001_initial.sql
# ... run all migrations in order
```

**OR** use the database migration script:
```bash
npm run migrate
```

## Step 5: Start Development Server

```bash
npm run dev
```

Then open: http://localhost:5000

## Troubleshooting

### "DATABASE_URL is not defined"
- Check that `server/.env` exists
- Verify DATABASE_URL is set correctly
- Make sure PostgreSQL is running

### "Connection refused"
- PostgreSQL might not be running
- Check port 5432 is not blocked
- Verify credentials in DATABASE_URL

### "GitHub OAuth failed"
- Make sure you created the OAuth app
- Verify callback URL matches exactly
- Check GITHUB_CLIENT_ID and SECRET are correct

## Quick Test (Without Full Setup)

If you just want to test the code without database:

1. Comment out database checks in `server/db.ts`
2. Use mock data for testing
3. Deploy to production for real testing

## Production Deployment

When ready to deploy fixes:

```bash
# Switch back to production branch
git checkout phase-2-security-implementation

# Merge your local fixes
git merge local-development-setup

# Push to upstream
git push upstream phase-2-security-implementation
```

Then have the person with production access:
1. Merge the PR
2. Deploy to production
3. Run migrations on production database

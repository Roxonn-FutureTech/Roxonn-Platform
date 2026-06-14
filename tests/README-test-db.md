# Test Database Provisioning Runbook

This runbook documents the **one-time** operator steps required to provision the
dedicated `roxonn_test` Postgres database used by Vitest integration tests.

> **CRITICAL:** These steps target the `roxonn_test` database ONLY.
> NEVER run these commands against the production `DATABASE_URL`.
> The prod database holds real encrypted wallet keys, user accounts, and payout history.

---

## Why a Separate Database?

Integration tests (e.g., `server/__tests__/payoutIntegration.test.ts`) truncate tables
between runs to ensure a clean state. Truncating the production database would destroy
real data. The `tests/setup.ts` vitest setupFile enforces this isolation:

- If `TEST_DATABASE_URL` is **unset** — setupFile is a no-op; mocked/unit tests run normally.
- If `TEST_DATABASE_URL` points to any DB **other than** `roxonn_test` — setupFile throws a SAFETY error and refuses to run.
- Only when `TEST_DATABASE_URL` names exactly `roxonn_test` does the test runner proceed.

---

## Prerequisites

- PostgreSQL 14+ running locally (the existing server Postgres instance is fine).
- The `psql` and `createdb` CLI tools available.
- `drizzle-kit` available via `npx drizzle-kit` (already a dev dependency).
- The `shared/schema.ts` schema source of truth (Drizzle).

---

## One-Time Setup Steps

### Step 1 — Create the roxonn_test database

```bash
createdb roxonn_test
# OR equivalently:
psql -c "CREATE DATABASE roxonn_test;"
```

If you need to specify a user or host:

```bash
createdb -U postgres roxonn_test
# OR:
psql -U postgres -c "CREATE DATABASE roxonn_test;"
```

### Step 2 — Export TEST_DATABASE_URL

Replace `USER`, `PASS`, and `HOST` with the local Postgres credentials:

```bash
export TEST_DATABASE_URL="postgres://USER:PASS@localhost:5432/roxonn_test"
```

For a local Postgres instance without a password (peer auth):

```bash
export TEST_DATABASE_URL="postgres://postgres@localhost:5432/roxonn_test"
```

### Step 3 — Apply the schema to roxonn_test

Use `drizzle-kit push` to create all tables in `roxonn_test` from `shared/schema.ts`.
Point it at the test database by temporarily setting `DATABASE_URL`:

```bash
DATABASE_URL=$TEST_DATABASE_URL npx drizzle-kit push
```

This is the **only permitted `drizzle-kit push`** in this phase (D-02). It targets
`roxonn_test`, never the production `DATABASE_URL`.

> **Note on constraint names:** `drizzle-kit push` creates Drizzle's default constraint
> name `payouts_tx_hash_unique` (not the hand-SQL name `uq_payouts_tx_hash` from
> migration 0026). This is expected and acceptable — the `onConflictDoNothing` used
> in integration tests targets the column, not the constraint name.

---

## Running Integration Tests

After setup, run integration tests with `TEST_DATABASE_URL` in the environment:

```bash
TEST_DATABASE_URL="postgres://USER:PASS@localhost:5432/roxonn_test" npx vitest run server/__tests__/payoutIntegration.test.ts
```

Or to run the full test suite (mocked unit tests + integration tests together):

```bash
TEST_DATABASE_URL="postgres://USER:PASS@localhost:5432/roxonn_test" npm test
```

---

## Resetting the Schema

If the schema changes (e.g., after a new migration), re-apply it to `roxonn_test`:

```bash
# Drop and recreate the test database (all data lost — this is fine, it's test data)
dropdb roxonn_test && createdb roxonn_test

# Re-apply the schema
DATABASE_URL=$TEST_DATABASE_URL npx drizzle-kit push
```

---

## Safety Reminder

**NEVER run `DATABASE_URL=$PRODUCTION_URL npx drizzle-kit push` on prod.**
**NEVER set `TEST_DATABASE_URL` to point at the production database.**

The `tests/setup.ts` guard will refuse to run if `TEST_DATABASE_URL` names anything
other than `roxonn_test`, but defence-in-depth starts with operator discipline.

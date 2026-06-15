# Community Bounty Feature Enable Runbook

**Version:** 1.0
**Phase:** Phase 5 (in-flight-feature-gate-pre-deploy)
**Last updated:** 2026-06-15

---

## Status Banner

> **FEATURE IS DISABLED — DO NOT EXECUTE THIS RUNBOOK IN PHASE 5**
>
> The community-bounty feature (fund-mover, auto-claim, auto-registration) is **DISABLED by
> design at the end of Phase 5** (D-01 posture). All feature flags default OFF. The DB
> kill-switch `platform_flags.community_relayer_enabled` is seeded FALSE.
>
> This runbook documents the **deliberate, post-milestone enable path** for a future operator.
> It is **NOT to be executed** until all prerequisites below are COMPLETE and explicitly
> signed off. No flag is flipped as part of Phase 5.

---

## Prerequisites

Both of the following requirements must be **COMPLETE** (not just Pending) before any flag
is enabled. Check `.planning/REQUIREMENTS.md` for current status.

### FUND-05 — Historical Payout Reconciliation (currently: Pending)

Reconcile and backfill all historical payouts from on-chain contract events. This ensures
the `payouts` ledger is complete and no contributor was double-paid before the relayer
begins issuing new payouts.

**Gate:** The `reconcile-payouts.ts` script must have been run with `--apply` against prod,
the dry-run report reviewed, and the payout ledger confirmed consistent with on-chain state.

**Why this gates enable:** The community-bounty relayer (`processClaimedBounties`) writes
to the `payouts` table using `onConflictDoNothing` on `txHash`. An incomplete historical
ledger means future duplicate-pay detection is unreliable.

### SEC-03 — Relayer Log Hygiene (currently: Pending)

The community-bounty relayer (`server/communityBountyRelayer.ts`) must stop logging full
bounty objects and error stack traces. Logs must emit `error.message` plus sanitized scalar
fields only — no signer/transaction context leakage.

**Why this gates enable:** Once the relayer is enabled it issues on-chain transactions.
Leaking signer context or full error objects in logs violates ASVS V7 and creates an
information-disclosure risk (T-05-13).

---

## Exact Toggle Order

Enable flags **in this exact order**. Each flag is independently toggleable and defaults
**OFF** unless noted. Do NOT enable `FEATURE_AUTO_CLAIM` or `FEATURE_AUTO_REGISTRATION`
before the relayer is confirmed running.

### Step 1 — Enable the relayer env flag

Set the environment variable (in `server/.env` or your deployment secret store):

```bash
FEATURE_COMMUNITY_RELAYER_ENABLED=true
```

Then rebuild and restart:

```bash
npm run build
pm2 restart roxonn-platform
```

**Verify (Step 1):** Check pm2 logs immediately after restart:

```bash
pm2 logs roxonn-platform --lines 50
```

Expected: `Community bounty relayer started` log line visible. No startup errors.
The relayer starts its 5-minute polling interval (`startCommunityBountyRelayer(intervalMs=300000)`).

### Step 2 — Enable the DB kill-switch

The relayer has a **double-gate**: even with the env flag on, `processClaimedBounties` checks
`platform_flags.community_relayer_enabled` via `storage.getRelayerEnabled()` (fail-safe: returns
`false` on DB error or missing row). Enable the DB row:

```sql
UPDATE platform_flags
SET value = TRUE, updated_at = NOW()
WHERE key = 'community_relayer_enabled';
```

**Verify (Step 2):**

```bash
pm2 logs roxonn-platform --lines 30 | grep -i "relayer"
```

Expected: No `relayer DISABLED` log lines within the 5-minute polling cycle. The relayer
will begin querying `community_bounties` for `status = 'claimed'` rows.

### Step 3 — Enable auto-claim (optional, gated on relayer running)

Auto-claim causes merged PRs on funded community bounties to be marked `'claimed'` (status
transition only — no funds move at this point). The relayer in Step 1+2 is what executes
payouts.

```bash
FEATURE_AUTO_CLAIM=true
```

Rebuild and restart after setting the env var:

```bash
npm run build
pm2 restart roxonn-platform
```

**Verify (Step 3):** Trigger a test PR merge on a funded community-bounty repo. Confirm
in the database that the bounty row transitions to `status = 'claimed'` and
`claimed_by_user_id` is set.

### Step 4 — Enable auto-registration (optional)

Auto-registration automatically creates an XDC wallet for new contributors who don't have
one, during PR-merge processing.

```bash
FEATURE_AUTO_REGISTRATION=true
```

Rebuild and restart:

```bash
npm run build
pm2 restart roxonn-platform
```

**Verify (Step 4):** Confirm in logs that `autoRegisterContributor` runs for a contributor
without a wallet, and that `pending_wallets` count returns to 0 after promotion (run
`tsx scripts/count-wallet-orphans.ts`).

### Note on FEATURE_GAS_MONITORING

`FEATURE_GAS_MONITORING` defaults **ON** (`process.env.FEATURE_GAS_MONITORING !== 'false'`).
No action needed — it is already running in production at Phase 5 end (gasMonitor lazy-init
ensures no startup crash when `PRIVATE_KEY` is unset).

---

## Inert-Window Behavior

During the period when auto-claim was **disabled** (Phase 5 D-01 posture), any PRs that
merged on funded community-bounty issues were **NOT** marked `'claimed'`. The bounties remain
in `'funded'` status.

**Important consequence:** There is **NO webhook replay** after enable. Bounties whose
trigger PR merged while auto-claim was disabled will stay `'funded'` indefinitely until
a new qualifying event (another PR merge on the same issue) re-triggers the claim path.

**Action required after enable:** Identify any `'funded'` community bounties with
`claimed_pr_number IS NULL` but a corresponding closed PR. These may need a manual
status update or a re-trigger event. Check:

```sql
SELECT id, github_issue_number, github_repo_owner, github_repo_name, status, amount
FROM community_bounties
WHERE status = 'funded'
ORDER BY created_at;
```

---

## Post-Enable Verification

After completing Steps 1–4 above, run this verification checklist:

### Health Check

```bash
curl -s https://roxonn.com/health | jq .
```

Expected: `200 OK`, no error fields.

### Relayer Active Confirmation

```bash
pm2 logs roxonn-platform --lines 100 | grep -i "relayer\|community"
```

Expected log patterns (within 5 minutes of restart):
- `Community bounty relayer started`
- `processClaimedBounties: running cycle` (or similar relayer cycle log)
- No `relayer DISABLED` lines

### DB Kill-Switch Confirmed

```sql
SELECT key, value, updated_at FROM platform_flags WHERE key = 'community_relayer_enabled';
```

Expected: `value = true`.

### Smoke Test (claimed bounty picked up)

1. Identify a bounty with `status = 'claimed'` in the database.
2. Wait for the next relayer cycle (up to 5 minutes).
3. Confirm the bounty transitions to `status = 'paid'` and a `payouts` row exists with
   the matching `community_bounty_id`.

### Orphan Count Baseline

```bash
# Do NOT run against prod without review — read-only, safe to run
tsx scripts/count-wallet-orphans.ts
```

Expected: 0 true orphans, 0 expired rows after enabling auto-registration.

---

## Rollback

The double-gate design means rollback requires **no redeploy**:

### Immediate Kill (DB flag, no restart needed)

```sql
UPDATE platform_flags
SET value = FALSE, updated_at = NOW()
WHERE key = 'community_relayer_enabled';
```

This takes effect within the next relayer poll cycle (up to 5 minutes). The relayer will
log that it is disabled and stop issuing transactions.

### Full Rollback (env flags + restart)

1. Set in `server/.env`:
   ```bash
   FEATURE_COMMUNITY_RELAYER_ENABLED=false
   FEATURE_AUTO_CLAIM=false
   FEATURE_AUTO_REGISTRATION=false
   ```
2. Rebuild and restart:
   ```bash
   npm run build
   pm2 restart roxonn-platform
   ```
3. Reset DB flag:
   ```sql
   UPDATE platform_flags SET value = FALSE, updated_at = NOW()
   WHERE key = 'community_relayer_enabled';
   ```
4. Verify: `pm2 logs roxonn-platform --lines 30` shows no relayer activity, `/health` 200.

**Note:** Rolling back does **not** undo any payouts already issued. Payouts are on-chain
and irreversible. The `payouts` table and `community_bounties` status changes persist.

---

## Flag Reference

| Flag / Column | Location | Default | Purpose |
|---------------|----------|---------|---------|
| `FEATURE_COMMUNITY_RELAYER_ENABLED` | env var / `server/.env` | `false` (OFF) | Enables the community-bounty payout relayer |
| `platform_flags.community_relayer_enabled` | DB table `platform_flags` (key/value) | `FALSE` (seeded in `migrations/0027_add_platform_flags.sql`) | DB kill-switch; checked every relayer cycle via `storage.getRelayerEnabled()` |
| `FEATURE_AUTO_CLAIM` | env var / `server/.env` | `false` (OFF) | Enables marking bounties `'claimed'` on PR merge |
| `FEATURE_AUTO_REGISTRATION` | env var / `server/.env` | `false` (OFF) | Enables auto-wallet-creation for new contributors |
| `FEATURE_GAS_MONITORING` | env var / `server/.env` | `true` (ON — `!== 'false'`) | Gas balance monitoring; already running, no action needed |

All flags are defined in `server/config.ts` at `export const FEATURE_FLAGS`.

---

## Related Documents

- `scripts/reconcile-payouts.ts` — FUND-05 historical backfill script (prerequisite)
- `scripts/count-wallet-orphans.ts` — D-09 read-only orphan counter (FUND-02 evidence)
- `migrations/0027_add_platform_flags.sql` — DB kill-switch seeding
- `.planning/REQUIREMENTS.md` — FUND-05 and SEC-03 current status
- `docs/PHASE_1_DEPLOYMENT_GUIDE.md` — Phase 1 deployment reference

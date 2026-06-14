// server/routes/__tests__/contributorResolution.test.ts
//
// Regression tests for the contributor-resolution decision tree (D-06 / TEST-01).
// Covers: FUND-01 keyword boundary, closed_by non-bot shortcut, timeline fallback,
// cross-ref refusal path + sendRefusedPayoutAlert assertion.
//
// Pattern: payoutMapper.test.ts (pure unit model) + blockchainRoutes.test.ts (vi.mock shape)
// DB-free: all IO deps mocked — no real network, no DB, no filesystem.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hasCorroboratingClosingKeyword,
  resolveClosingContributor,
} from '../../utils/contributorResolution';
import type { ContributorResolutionContext } from '../../utils/contributorResolution';
import type { WebhookPayload } from '../../github';

// ---------------------------------------------------------------------------
// Hoist: vi.hoisted is not needed — vi.mock factory runs before any imports,
// but we declare the mock fns here so we can reference them in tests.
// ---------------------------------------------------------------------------

// Mock axios (used inside resolveClosingContributor for timeline fetch)
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock GitHub helper deps that touch IO
vi.mock('../../github', () => ({
  getInstallationAccessToken: vi.fn(),
  buildSafeGitHubUrl: vi.fn(),
  getGitHubApiHeaders: vi.fn(),
}));

// Mock email so sendRefusedPayoutAlert is observable
vi.mock('../../email', () => ({
  sendRefusedPayoutAlert: vi.fn().mockResolvedValue(undefined),
  sendLedgerFailureAlert: vi.fn().mockResolvedValue(undefined),
}));

// Pull in the mocked fns for assertion
import axios from 'axios';
import {
  getInstallationAccessToken,
  buildSafeGitHubUrl,
  getGitHubApiHeaders,
} from '../../github';
import { sendRefusedPayoutAlert } from '../../email';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Synthetic context — no real tokens / repos / wallets
// ---------------------------------------------------------------------------
const SYNTHETIC_CTX: ContributorResolutionContext = {
  installationId: 'install-42',
  repoId: 99,
  issueNumber: 5,
  webhookOwner: 'test-owner',
  webhookRepo: 'test-repo',
};

/** Build a minimal WebhookPayload with optional closed_by override */
function makePayload(closedByLogin?: string | null): WebhookPayload {
  const issueAny: any = {
    id: 1,
    number: 5,
    state: 'closed',
    user: { login: 'issue-creator', id: 100 },
  };
  if (closedByLogin !== undefined) {
    // closed_by is an undocumented webhook field; attach via any
    issueAny.closed_by = closedByLogin == null ? null : { login: closedByLogin };
  }
  return {
    action: 'closed',
    repository: { id: 888, full_name: 'test-owner/test-repo' },
    sender: { login: 'sender', id: 200 },
    issue: issueAny,
  } as WebhookPayload;
}

/** Set up timeline mock to return a 'closed' event with optional commit_id and actor */
function mockTimeline(events: any[]) {
  (getInstallationAccessToken as Mock).mockResolvedValue('fake-token');
  (buildSafeGitHubUrl as Mock).mockReturnValue('https://api.github.com/repos/test-owner/test-repo/issues/5/timeline');
  (getGitHubApiHeaders as Mock).mockReturnValue({ Authorization: 'token fake-token' });
  (axios.get as Mock).mockResolvedValue({
    data: events,
    headers: {}, // no 'link' header → single page
  });
}

// ---------------------------------------------------------------------------
// Suite 1: PURE BOUNDARY — hasCorroboratingClosingKeyword (no mocks needed)
// ---------------------------------------------------------------------------
describe('hasCorroboratingClosingKeyword — FUND-01 boundary', () => {
  it('returns false for "closes #50" when querying issue #5 (substring-collision guard)', () => {
    expect(hasCorroboratingClosingKeyword('closes #50', 5)).toBe(false);
  });

  it('returns true for "closes #50" when querying issue #50 (exact match)', () => {
    expect(hasCorroboratingClosingKeyword('closes #50', 50)).toBe(true);
  });

  it('returns true for "fixes #5" when querying issue #5', () => {
    expect(hasCorroboratingClosingKeyword('fixes #5', 5)).toBe(true);
  });

  it('returns false for "see #5 for context" — not a closing keyword', () => {
    expect(hasCorroboratingClosingKeyword('see #5 for context', 5)).toBe(false);
  });

  it('returns true for "closes: #5" (colon variant)', () => {
    expect(hasCorroboratingClosingKeyword('closes: #5', 5)).toBe(true);
  });

  it('returns false for "preclose #5" — word boundary must hold (no partial word match)', () => {
    expect(hasCorroboratingClosingKeyword('preclose #5', 5)).toBe(false);
  });

  it('returns true for "resolves #5"', () => {
    expect(hasCorroboratingClosingKeyword('resolves #5', 5)).toBe(true);
  });

  it('returns false for "fixes #51" when querying issue #5 (trailing digit boundary)', () => {
    expect(hasCorroboratingClosingKeyword('fixes #512', 51)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: DECISION TREE — resolveClosingContributor (mocked deps)
// ---------------------------------------------------------------------------
describe('resolveClosingContributor — decision tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Tier 1: closed_by non-bot → resolves immediately, no timeline call ----

  it('(e) returns resolved with closed_by login when non-bot closed_by is present', async () => {
    const result = await resolveClosingContributor(makePayload('alice'), SYNTHETIC_CTX);

    expect(result).toEqual({ status: 'resolved', login: 'alice', prNumber: null });
    // Timeline must NOT be consulted — axios.get should not have been called
    expect(axios.get).not.toHaveBeenCalled();
    expect(getInstallationAccessToken).not.toHaveBeenCalled();
  });

  // ---- Tier 1 fall-through: closed_by is a bot ----

  it('(f) falls through to timeline when closed_by is a bot', async () => {
    const timelineEvents = [
      {
        event: 'closed',
        commit_id: 'abc123',
        actor: { login: 'bob' },
      },
    ];
    mockTimeline(timelineEvents);

    const result = await resolveClosingContributor(makePayload('roxonn[bot]'), SYNTHETIC_CTX);

    expect(result).toEqual({ status: 'resolved', login: 'bob', prNumber: null });
    // Timeline was consulted
    expect(getInstallationAccessToken).toHaveBeenCalledWith('install-42');
  });

  // ---- Tier 1 fall-through: no closed_by at all ----

  it('(g) falls through to timeline when closed_by is absent', async () => {
    const timelineEvents = [
      {
        event: 'closed',
        commit_id: 'def456',
        actor: { login: 'bob' },
      },
    ];
    mockTimeline(timelineEvents);

    // Payload has no closed_by property at all
    const result = await resolveClosingContributor(makePayload(undefined), SYNTHETIC_CTX);

    expect(result).toEqual({ status: 'resolved', login: 'bob', prNumber: null });
    expect(getInstallationAccessToken).toHaveBeenCalledWith('install-42');
  });

  // ---- Tier 2: timeline 'closed' event with commit_id and non-bot actor ----

  it('(h) resolves via timeline closed event actor when closed_by absent', async () => {
    const timelineEvents = [
      { event: 'commented', actor: { login: 'someone' } },
      { event: 'closed', commit_id: 'abc999', actor: { login: 'bob' } },
    ];
    mockTimeline(timelineEvents);

    const result = await resolveClosingContributor(makePayload(undefined), SYNTHETIC_CTX);

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.login).toBe('bob');
    }
  });

  // ---- Tier 2: 'closed' event actor is a bot → fall through to tier 3 ----

  it('falls through to tier 3 cross-ref when closed event actor is a bot', async () => {
    // 'closed' event actor is a bot; followed by a cross-ref with a closing keyword
    const timelineEvents = [
      {
        event: 'closed',
        commit_id: 'botcommit',
        actor: { login: 'github-actions[bot]' },
      },
      {
        event: 'cross-referenced',
        actor: { login: 'carol' },
        source: {
          type: 'issue',
          issue: {
            number: 77,
            state: 'closed',
            user: { login: 'carol' },
            pull_request: { merged_at: '2025-01-01T00:00:00Z' },
            title: 'Fix main bug',
            body: 'closes #5 — resolves the core issue',
          },
        },
      },
    ];
    mockTimeline(timelineEvents);

    const result = await resolveClosingContributor(makePayload('github-actions[bot]'), SYNTHETIC_CTX);

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.login).toBe('carol');
      expect(result.prNumber).toBe(77);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: REFUSAL PATH — no closing keyword → refused + sendRefusedPayoutAlert
// ---------------------------------------------------------------------------
describe('resolveClosingContributor — refusal path (FUND-01 cross-ref keyword gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(i) returns refused and fires sendRefusedPayoutAlert when merged PR has no closing keyword', async () => {
    // A merged PR by 'carol' whose title/body contain NO closing keyword for #5
    // (Note: the PR body mentions #50, which would trigger substring collision in naïve impl)
    const timelineEvents = [
      {
        event: 'cross-referenced',
        actor: { login: 'carol' },
        source: {
          type: 'issue',
          issue: {
            number: 22,
            state: 'closed',
            user: { login: 'carol' },
            pull_request: { merged_at: '2025-03-10T12:00:00Z' },
            title: 'Improve performance for #50',
            body: 'This PR improves performance for issue #50 and nothing else.',
          },
        },
      },
    ];
    mockTimeline(timelineEvents);

    const ctx: ContributorResolutionContext = {
      ...SYNTHETIC_CTX,
      issueNumber: 5, // querying #5, not #50
    };

    const result = await resolveClosingContributor(makePayload(undefined), ctx);

    expect(result).toEqual({ status: 'refused' });
    // Alert must have been fired exactly once
    expect(sendRefusedPayoutAlert).toHaveBeenCalledTimes(1);
    expect(sendRefusedPayoutAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: String(ctx.repoId),
        issueNumber: 5,
        candidatePR: 22,
        candidateAuthor: 'carol',
      })
    );
  });

  it('does NOT call sendRefusedPayoutAlert when cross-ref PR body has the closing keyword', async () => {
    // PR body correctly closes #5 — should resolve, not refuse
    const timelineEvents = [
      {
        event: 'cross-referenced',
        actor: { login: 'dave' },
        source: {
          type: 'issue',
          issue: {
            number: 33,
            state: 'closed',
            user: { login: 'dave' },
            pull_request: { merged_at: '2025-04-01T00:00:00Z' },
            title: 'Fix the auth flow',
            body: 'Closes #5 — this resolves the reported bug.',
          },
        },
      },
    ];
    mockTimeline(timelineEvents);

    const result = await resolveClosingContributor(makePayload(undefined), SYNTHETIC_CTX);

    expect(result.status).toBe('resolved');
    expect(sendRefusedPayoutAlert).not.toHaveBeenCalled();
  });

  it('returns not_found (not refused) when timeline has no relevant events', async () => {
    mockTimeline([]); // empty timeline

    const result = await resolveClosingContributor(makePayload(undefined), SYNTHETIC_CTX);

    expect(result).toEqual({ status: 'not_found' });
    // No alert fired — nothing to refuse
    expect(sendRefusedPayoutAlert).not.toHaveBeenCalled();
  });
});

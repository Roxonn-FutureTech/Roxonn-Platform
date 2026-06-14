// server/utils/contributorResolution.ts
// Contributor-resolution decision tree + FUND-01 closing-keyword boundary check.
// Importable in isolation — no side effects at module level (no top-level DB calls,
// no top-level network awaits). Extracted from handleIssueClosed per DEBT-01/D-05.
//
// Extraction model: server/utils/payoutMapper.ts

import axios from 'axios';
import { log } from '../utils';
import {
  getInstallationAccessToken,
  buildSafeGitHubUrl,
  getGitHubApiHeaders,
  WebhookPayload,
} from '../github';
import { sendRefusedPayoutAlert } from '../email';

// ---------------------------------------------------------------------------
// Context passed by the thin wrapper in handleIssueClosed
// ---------------------------------------------------------------------------
export interface ContributorResolutionContext {
  installationId: string;
  repoId: number;
  issueNumber: number;
  webhookOwner: string;
  webhookRepo: string;
}

// ---------------------------------------------------------------------------
// Discriminated result type — caller maps each status to the matching control flow
// ---------------------------------------------------------------------------
export type ContributorResolutionResult =
  | { status: 'resolved'; login: string; prNumber: number | null }
  | { status: 'refused' }   // sendRefusedPayoutAlert already fired
  | { status: 'not_found' };

// ---------------------------------------------------------------------------
// FUND-01 closing-keyword boundary check (pure function, exported for tests)
//
// Returns true when `text` contains a GitHub closing keyword followed by
// `#<issueNumber>` anchored on a trailing non-digit boundary (`(?!\d)`).
// This prevents issue #5 from being falsely corroborated by "closes #50" — a
// naive substring match would pay the WRONG contributor, defeating FUND-01.
// Uses GitHub's full canonical closing-keyword set.
// ---------------------------------------------------------------------------
export function hasCorroboratingClosingKeyword(text: string, issueNumber: number): boolean {
  const closingKeywords = [
    'close', 'closes', 'closed',
    'fix', 'fixes', 'fixed',
    'resolve', 'resolves', 'resolved',
  ];
  const regex = new RegExp(
    `\\b(${closingKeywords.join('|')})\\s*:?\\s+#${issueNumber}(?!\\d)`,
    'i',
  );
  return regex.test(text);
}

// ---------------------------------------------------------------------------
// resolveClosingContributor
//
// Implements the three-tier contributor-resolution decision tree extracted
// from handleIssueClosed, in exact order:
//
//   1. issue.closed_by from webhook payload (most reliable) — skip bots
//   2. Most-recent 'closed' timeline event that has a commit_id — skip bots
//   3. Cross-ref fallback: most-recent merged PR in timeline, but only if
//      title or body contains a FUND-01 corroborating closing keyword
//      (hasCorroboratingClosingKeyword). On no corroboration: fires
//      sendRefusedPayoutAlert and returns { status: 'refused' }.
//
// Returns:
//   { status: 'resolved', login, prNumber } — proceed with payout
//   { status: 'refused' }                   — alert fired; caller must return
//   { status: 'not_found' }                 — caller must log and return
// ---------------------------------------------------------------------------
export async function resolveClosingContributor(
  payload: WebhookPayload,
  ctx: ContributorResolutionContext,
): Promise<ContributorResolutionResult> {
  const { installationId, repoId, issueNumber, webhookOwner, webhookRepo } = ctx;

  let closingPRAuthor: string | null = null;
  let closingPRNumber: number | null = null;

  // -------------------------------------------------------------------------
  // Tier 1: issue.closed_by from webhook payload (most reliable)
  // -------------------------------------------------------------------------
  // Note: closed_by is not in the GitHubWebhookIssue interface (it is an
  // undocumented field GitHub includes in webhook payloads). Accessing via
  // optional chaining on the payload any-chain is safe here.
  const issueAny = payload.issue as any;
  if (issueAny?.closed_by?.login) {
    const closedByUser: string = issueAny.closed_by.login;

    if (!closedByUser.endsWith('[bot]')) {
      closingPRAuthor = closedByUser;
      log(`✅ Using issue.closed_by from webhook payload: ${closingPRAuthor}`, 'webhook-issue');
      // closingPRNumber stays null — the closed_by field doesn't carry a PR number
    } else {
      log(`⚠️ issue.closed_by is a bot (${closedByUser}), will check timeline instead`, 'webhook-issue');
    }
  } else {
    log(`⚠️ No issue.closed_by in webhook payload, will search timeline`, 'webhook-issue');
  }

  // -------------------------------------------------------------------------
  // Tiers 2 & 3: Timeline-based fallback (only entered when Tier 1 failed)
  // -------------------------------------------------------------------------
  if (!closingPRAuthor) {
    try {
      // --- Generate Installation Token ---
      const installationToken = await getInstallationAccessToken(installationId);
      if (!installationToken) {
        log(
          `Webhook Error: Could not get installation token for installId ${installationId}. Cannot fetch timeline.`,
          'webhook-issue',
        );
        return { status: 'not_found' };
      }
      const installationApiHeaders = getGitHubApiHeaders(installationToken);

      // --- Fetch issue timeline (paginated, max 10 pages / 1000 events) ---
      const timelineUrl = buildSafeGitHubUrl(
        '/repos/{owner}/{repo}/issues/{issueNumber}/timeline',
        {
          owner: webhookOwner,
          repo: webhookRepo,
          issueNumber: String(issueNumber),
        },
      );
      log(`Fetching timeline: ${timelineUrl}`, 'webhook-issue');

      let timelineEvents: any[] = [];
      let page = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        log(`Fetching timeline page ${page}...`, 'webhook-issue');
        const timelineResponse = await axios.get(timelineUrl, {
          headers: installationApiHeaders,
          params: { per_page: 100, page },
        });

        const events = timelineResponse.data || [];
        timelineEvents = timelineEvents.concat(events);

        const linkHeader = timelineResponse.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
          page++;
        } else {
          hasNextPage = false;
        }

        // Safety break — max 10 pages (1 000 events)
        if (page > 10) {
          log(
            `Reached max pagination limit (10 pages) for issue #${issueNumber}. Stopping.`,
            'webhook-issue',
          );
          hasNextPage = false;
        }
      }

      log(
        `Timeline received total ${timelineEvents.length} events. Searching for MOST RECENT closed event...`,
        'webhook-issue',
      );

      // -----------------------------------------------------------------------
      // Tier 2: Most-recent 'closed' event with a commit_id
      // -----------------------------------------------------------------------
      let closedEvent: any = null;
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const event = timelineEvents[i];
        if (event.event === 'closed' && event.commit_id) {
          closedEvent = event;
          log(
            `[Timeline] Found most recent 'closed' event at index ${i}, commit: ${event.commit_id}, actor: ${event.actor?.login}`,
            'webhook-issue',
          );
          break;
        }
      }

      if (closedEvent) {
        const closeActor: string | undefined = closedEvent.actor?.login;
        if (closeActor && !closeActor.endsWith('[bot]')) {
          closingPRAuthor = closeActor;
          log(`✅ Found contributor via 'closed' event: ${closingPRAuthor}`, 'webhook-issue');
        } else {
          log(`⚠️ 'closed' event actor is bot or missing: ${closeActor}`, 'webhook-issue');
        }
      }

      // -----------------------------------------------------------------------
      // Tier 3: Cross-referenced merged PRs (last resort)
      // -----------------------------------------------------------------------
      if (!closingPRAuthor) {
        log(`⚠️ Falling back to cross-reference search (less reliable)...`, 'webhook-issue');

        for (let i = timelineEvents.length - 1; i >= 0; i--) {
          const event = timelineEvents[i];

          if (
            event.event === 'cross-referenced' &&
            event.actor?.login &&
            event.source?.type === 'issue'
          ) {
            const sourceIssue = event.source.issue;
            const prNumber: number = sourceIssue?.number;
            const mergedAt = sourceIssue?.pull_request?.merged_at;
            const isMerged = sourceIssue?.state === 'closed' && mergedAt != null;

            log(
              `[Timeline Event ${i}] Cross-ref PR #${prNumber}, merged=${isMerged}, author=${sourceIssue?.user?.login}`,
              'webhook-issue',
            );

            if (isMerged) {
              const prAuthor: string | undefined = sourceIssue?.user?.login;

              if (!prAuthor || prAuthor.endsWith('[bot]')) {
                log(
                  `[Timeline Event ${i}] Skipping bot or missing PR author: ${prAuthor}`,
                  'webhook-issue',
                );
                continue;
              }

              // FUND-01: Require a corroborating closing keyword before trusting cross-ref fallback.
              // Anchor the match on a trailing non-digit boundary `(?!\d)` so that closing
              // issue #5 is NOT falsely corroborated by a PR that says "closes #50".
              const hasClosingRef =
                hasCorroboratingClosingKeyword(sourceIssue?.body || '', issueNumber) ||
                hasCorroboratingClosingKeyword(sourceIssue?.title || '', issueNumber);

              if (!hasClosingRef) {
                log(
                  `❌ Cross-reference fallback: PR #${prNumber} by ${prAuthor} (merged) has no verified 'closes #${issueNumber}' keyword in title/body. Refusing payout.`,
                  'webhook-issue',
                );
                await sendRefusedPayoutAlert({
                  repoId: String(repoId),
                  issueNumber,
                  candidatePR: prNumber,
                  candidateAuthor: prAuthor,
                });
                return { status: 'refused' };
              }

              closingPRAuthor = prAuthor;
              closingPRNumber = prNumber;
              log(
                `✅ Cross-reference fallback corroborated: PR #${prNumber} by ${prAuthor} has closing keyword for #${issueNumber}.`,
                'webhook-issue',
              );
              break;
            }
          }
        }
      }

      if (!closingPRAuthor) {
        log(
          `❌ Could not find contributor in timeline for issue #${issueNumber}. Cannot determine who to pay.`,
          'webhook-issue',
        );
        return { status: 'not_found' };
      }
    } catch (timelineError: any) {
      log(
        `Error fetching timeline for issue #${issueNumber}: ${timelineError.message}`,
        'webhook-issue',
      );
      return { status: 'not_found' };
    }
  }

  // closingPRAuthor is guaranteed non-null here
  return { status: 'resolved', login: closingPRAuthor!, prNumber: closingPRNumber };
}

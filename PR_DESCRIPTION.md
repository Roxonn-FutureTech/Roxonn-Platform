fix(webhook): fix contributor ID logic and address leaderboard feedback

This PR fixes a bug in the webhook handler where bots were incorrectly identified as contributors during bounty distribution. It also addresses the remaining feedback on the leaderboard PR.

**Changes:**
*   **Webhook Fix:** Updated `handleIssueClosed` to correctly extract the PR author from the source issue instead of the event actor. This prevents bots (like `coderabbitai[bot]`) from being flagged as the contributor.
*   **Leaderboard UI:** Updated the mobile view to show both ROXN and USDC earnings, matching the desktop experience.
*   **Tests:** Cleaned up test comments and removed an invalid test case as requested.
*   **Sync:** Merged `upstream/main` and resolved conflicts in `leaderboardService.ts`.

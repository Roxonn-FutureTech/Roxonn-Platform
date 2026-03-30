import { Probot } from "probot";

// The technology stack keywords to filter for (ported from bounty_hunter.py)
const STACK_KEYWORDS = [
  "typescript", "python", "rust", "next.js", "nextjs", "react",
  "mcp", "model context protocol", "ai", "llm", "langchain",
  "fastapi", "node.js", "nodejs", "n8n", "automation",
  "wayland", "niri", "compositor", "wasm", "webassembly"
];

// Potential bounty labels
const BOUNTY_LABELS = [
  "bounty", "price", "reward", "help wanted", "good first issue",
  "💰", "💵", "$", "algora", "opire", "paid"
];

const MIN_BOUNTY_USD = 50;

/**
 * Extract dollar amount from text like 'Price: 600 USD' or '$500' or '💰 $1,000'
 */
function extractBountyValue(text: string): string | null {
  const patterns = [
    /\\$\\s*([\\d,]+(?:\\.\\d{2})?)/,
    /([\\d,]+)\\s*(?:USD|usd)/,
    /Price:\\s*\\$?\\s*([\\d,]+)/i,
    /Reward:\\s*\\$?\\s*([\\d,]+)/i,
    /Bounty:\\s*\\$?\\s*([\\d,]+)/i,
    /💰\\s*\\$?\\s*([\\d,]+)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const val = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(val) && val >= MIN_BOUNTY_USD) {
        return `\\$${val}`;
      }
    }
  }
  return null;
}

/**
 * Check if the text matches our tech stack
 */
function matchesStack(text: string): string[] {
  const lowerText = text.toLowerCase();
  return STACK_KEYWORDS.filter(kw => lowerText.includes(kw));
}

export = (app: Probot) => {
  app.on(["issues.opened", "issues.edited"], async (context) => {
    const issue = context.payload.issue;
    const labels = issue.labels?.map((l: any) => l.name) || [];
    
    const fullText = `${issue.title} ${issue.body} ${labels.join(" ")}`;
    
    let bountyVal = extractBountyValue(fullText);
    if (!bountyVal) {
      for (const label of labels) {
        bountyVal = extractBountyValue(label);
        if (bountyVal) break;
      }
    }
    
    const stack = matchesStack(fullText);
    
    // Only proceed if it has both a tracked bounty and matches our stack footprint
    if (bountyVal && stack.length > 0) {
      const config = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: issue.number
      };

      // Check if we already commented
      const comments = await context.octokit.issues.listComments(config);
      const botCommented = comments.data.some(c => c.body?.includes("Roxonn Bounty Tracker"));

      if (!botCommented) {
        const commentBody = `🤖 **Roxonn Bounty Tracker**\n\n🎯 A valid bounty of **${bountyVal}** has been detected for this issue.\n🔧 **Relevant Skills:** ${stack.slice(0, 3).join(", ")}\n\nTo claim this bounty, submit a PR referencing this issue (e.g. \`Fixes #${issue.number}\`). Upon merge, the Smart Contract payout will be automatically triggered.`;
        await context.octokit.issues.createComment({
          ...config,
          body: commentBody
        });
      }
    }
  });

  app.on("pull_request.closed", async (context) => {
    const pr = context.payload.pull_request;
    
    // We only care if it was merged
    if (pr.merged) {
      const body = pr.body || "";
      // Crude extraction of linked issues from PR body (e.g. "Fixes #123")
      const fixRegex = /(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\\s+#(\\d+)/i;
      const match = body.match(fixRegex);

      if (match && match[1]) {
        const issueNumber = parseInt(match[1], 10);
        
        try {
          const config = {
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            issue_number: issueNumber
          };
          
          const issueReq = await context.octokit.issues.get(config);
          const issue = issueReq.data;
          
          const labels = issue.labels.map((l: any) => typeof l === 'string' ? l : l.name);
          const fullText = `${issue.title} ${issue.body} ${labels.join(" ")}`;
          const bountyVal = extractBountyValue(fullText);
          
          if (bountyVal) {
            const payoutMsg = `✅ **Roxonn Auto-Payout Triggered**\n\nThe linked PR #${pr.number} by @${pr.user.login} has been merged.\n💰 Payout of **${bountyVal} ROXN** is being processed to the contributor's wallet address.`;
            await context.octokit.issues.createComment({
              ...config,
              body: payoutMsg
            });
          }
        } catch (e) {
          app.log.error(`Failed to process auto-payout for PR #${pr.number}:`, e);
        }
      }
    }
  });
};

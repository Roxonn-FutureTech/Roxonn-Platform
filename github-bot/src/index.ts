import { Probot, Context } from "probot";
import { LRUCache } from "lru-cache";

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
function extractBountyValue(text: string): number | null {
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)/,
    /([\d,]+(?:\.\d{2})?)\s*(?:USD|usd)/i,
    /Price:\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /Reward:\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /Bounty:\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /💰\s*\$?\s*([\d,]+(?:\.\d{2})?)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val >= MIN_BOUNTY_USD) {
        return val;
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
  return STACK_KEYWORDS.filter(kw => {
    // Escape keywords to safely use in regex boundary matching
    const escaped = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    return regex.test(lowerText);
  });
}

// Lightweight in-memory cache to drop duplicate webhook replays from GitHub
const processedDeliveries = new LRUCache<string, boolean>({
  max: 5000,
  ttl: 1000 * 60 * 60 // 1 hour TTL
});

export = (app: Probot) => {
  app.on(["issues.opened", "issues.edited"], async (context: Context<"issues.opened" | "issues.edited">) => {
    const deliveryId = context.id;
    if (processedDeliveries.has(deliveryId)) return;
    processedDeliveries.set(deliveryId, true);

    try {
      const issue = context.payload.issue;
      const labels = issue.labels?.map((l) => typeof l === 'string' ? l : (l.name || "")) || [];
      
      const fullText = `${issue.title} ${issue.body} ${labels.join(" ")}`;
      
      let bountyVal = extractBountyValue(fullText);
      if (!bountyVal) {
        for (const label of labels) {
          bountyVal = extractBountyValue(label);
          if (bountyVal) break;
        }
      }
      
      const stack = matchesStack(fullText);
      
      if (bountyVal && stack.length > 0) {
        const config = {
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          issue_number: issue.number
        };

        const comments = await context.octokit.issues.listComments(config);
        const botCommented = comments.data.some((c) => c.body?.includes("Roxonn Bounty Tracker"));

        if (!botCommented) {
          const commentBody = `🤖 **Roxonn Bounty Tracker**\n\n🎯 A valid bounty of **$${bountyVal} USD** has been detected for this issue.\n🔧 **Relevant Skills:** ${stack.slice(0, 3).join(", ")}\n\n### 🛠 How to Claim\n1. Comment \`/attempt\` to register your intent.\n2. Submit a PR referencing this issue (e.g. \`Fixes #${issue.number}\`).\n3. Upon merge, the Smart Contract payout will be automatically triggered to your registered wallet.\n\n### 👥 Who's Working on This?\n| Contributor | Status |\n|-------------|--------|\n| *None yet*  | -      |`;
          await context.octokit.issues.createComment({
            ...config,
            body: commentBody
          });
        }
      }
    } catch (e) {
      app.log.error(`Failed to process issues.opened webhook:`, e);
    }
  });

  app.on("issue_comment.created", async (context: Context<"issue_comment.created">) => {
    const deliveryId = context.id;
    if (processedDeliveries.has(deliveryId)) return;
    processedDeliveries.set(deliveryId, true);

    try {
      const commentBody = context.payload.comment.body.trim().toLowerCase();
      if (commentBody === "/attempt") {
        const issue = context.payload.issue;
        const labels = issue.labels?.map((l) => typeof l === 'string' ? l : (l.name || "")) || [];
        const fullText = `${issue.title} ${issue.body} ${labels.join(" ")}`;
        
        let bountyVal = extractBountyValue(fullText);
        if (!bountyVal) {
          for (const label of labels) {
            bountyVal = extractBountyValue(label);
            if (bountyVal) break;
          }
        }
        
        const stack = matchesStack(fullText);
        
        if (bountyVal && stack.length > 0) {
          const config = {
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            issue_number: context.payload.issue.number
          };
          await context.octokit.issues.createComment({
            ...config,
            body: `🚀 @${context.payload.comment.user.login} has officially registered an attempt for this **$${bountyVal}** bounty!`
          });
        }
      }
    } catch (e) {
      app.log.error(`Failed to process issue_comment.created webhook:`, e);
    }
  });

  app.on("pull_request.closed", async (context: Context<"pull_request.closed">) => {
    const deliveryId = context.id;
    if (processedDeliveries.has(deliveryId)) return;
    processedDeliveries.set(deliveryId, true);

    try {
      const pr = context.payload.pull_request;
      
      if (pr.merged) {
        const body = pr.body || "";
        const fixRegex = /(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d+)/gi;
        const matches = [...body.matchAll(fixRegex)];

        for (const match of matches) {
          if (match && match[1]) {
            const issueNumber = parseInt(match[1], 10);
            
            const issueConfig = {
              owner: context.payload.repository.owner.login,
              repo: context.payload.repository.name,
              issue_number: issueNumber
            };
            
            const issueReq = await context.octokit.issues.get(issueConfig);
            const issue = issueReq.data;
            
            const labels = issue.labels.map((l) => typeof l === 'string' ? l : (l.name || ""));
            const fullText = `${issue.title} ${issue.body} ${labels.join(" ")}`;
            const bountyVal = extractBountyValue(fullText);
            
            if (bountyVal) {
              // Ensure payout notification comments on the PR, not the Issue
              const prConfig = {
                owner: context.payload.repository.owner.login,
                repo: context.payload.repository.name,
                issue_number: pr.number
              };

              const payoutMsg = `✅ **Roxonn Auto-Payout Triggered**\n\nThe linked issue #${issueNumber} has been resolved by this PR.\n💰 Payout of **$${bountyVal} (equivalent ROXN)** is being processed to @${pr.user.login}'s wallet address.`;
              await context.octokit.issues.createComment({
                ...prConfig,
                body: payoutMsg
              });

              // Example hook hook for blockchain interaction 
              app.log.info(`[PAYOUT] Dispatching $${bountyVal} transaction trigger for user @${pr.user.login}`);
            }
          }
        }
      }
    } catch (e) {
      app.log.error(`Failed to process auto-payout for PR #${context.payload.pull_request.number}:`, e);
    }
  });
};

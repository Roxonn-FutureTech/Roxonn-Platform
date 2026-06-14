/**
 * Community Bounty Auto-Claim Webhook Handlers
 */

import { db } from '../db';
import { communityBounties } from '../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { log } from '../vite';
import { ensureUserWallet } from '../services/autoRegistration';
import { gasMonitor } from '../services/gasMonitor';
import { postGitHubComment } from '../github';

function extractIssueNumbers(prBody: string): number[] {
  if (!prBody) return [];
  const regex = /(?:fixes|closes|resolves)\s+#(\d+)/gi;
  const issueNumbersMap: { [key: number]: boolean } = {};
  let match;
  while ((match = regex.exec(prBody)) !== null) {
    if (match[1]) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) {
        issueNumbersMap[num] = true;
      }
    }
  }
  return Object.keys(issueNumbersMap).map(Number);
}

export interface MergedPRData {
  prNumber: number;
  prAuthor: string;
  prAuthorId: string;
  prBody: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  installationId?: string;
}

export async function processMergedPullRequestForCommunityBounties(data: MergedPRData): Promise<void> {
  const { prNumber, prBody, repoFullName } = data;
  
  try {
    const issueNumbers = extractIssueNumbers(prBody);
    if (issueNumbers.length === 0) {
      log(\`PR #\${prNumber} has no linked issues\`, 'bounty:autoclaim');
      return;
    }
    
    log(\`PR #\${prNumber} linked to issues: \${issueNumbers.join(', ')}\`, 'bounty:autoclaim');
    
    for (const issueNumber of issueNumbers) {
      await processIssueBountyAutoClaim({ ...data, issueNumber });
    }
  } catch (error: any) {
    log(\`Failed to process community bounties for PR #\${prNumber}: \${error.message}\`, 'bounty:autoclaim');
  }
}

interface IssueBountyData extends MergedPRData {
  issueNumber: number;
}

async function processIssueBountyAutoClaim(data: IssueBountyData): Promise<void> {
  const { issueNumber, prNumber, prAuthor, prAuthorId, repoOwner, repoName, repoFullName, installationId } = data;
  
  try {
    const bounties = await db
      .select()
      .from(communityBounties)
      .where(
        and(
          eq(communityBounties.repoFullName, repoFullName),
          eq(communityBounties.issueNumber, issueNumber),
          eq(communityBounties.status, 'funded')
        )
      )
      .limit(1);
    
    if (bounties.length === 0) {
      log(\`No funded bounty for issue #\${issueNumber}\`, 'bounty:autoclaim');
      return;
    }
    
    const bounty = bounties[0];
    log(\`Found bounty \${bounty.id} for issue #\${issueNumber}\`, 'bounty:autoclaim');
    
    const contributorData = await ensureUserWallet(prAuthor, prAuthorId);
    
    if (!contributorData) {
      log(\`Auto-registration failed for \${prAuthor}\`, 'bounty:autoclaim');
      if (installationId) {
        await postGitHubComment(
          installationId, repoOwner, repoName, issueNumber,
          \`🎯 **Bounty Ready**\\n\\n@\${prAuthor}, sign up at https://roxonn.com to claim your bounty of **\${bounty.rewardAmount} \${bounty.currency}**\`
        );
      }
      return;
    }
    
    const { userId, walletAddress } = contributorData;
    
    try {
      await gasMonitor.ensureSufficientGas('0.1');
    } catch (gasError: any) {
      log(\`Insufficient gas: \${gasError.message}\`, 'bounty:autoclaim');
      if (installationId) {
        await postGitHubComment(
          installationId, repoOwner, repoName, issueNumber,
          \`⏳ **Payout Delayed**\\n\\n@\${prAuthor}, your bounty is reserved and will be processed shortly.\`
        );
      }
      return;
    }
    
    await db
      .update(communityBounties)
      .set({
        status: 'claimed',
        claimedByUserId: userId,
        claimedByGithubUsername: prAuthor,
        claimedPrNumber: prNumber,
        claimedPrUrl: \`https://github.com/\${repoFullName}/pull/\${prNumber}\`,
        claimedAt: new Date()
      })
      .where(eq(communityBounties.id, bounty.id));
    
    log(\`Bounty \${bounty.id} auto-claimed by user \${userId}\`, 'bounty:autoclaim');
    
    if (installationId) {
      await postGitHubComment(
        installationId, repoOwner, repoName, issueNumber,
        \`🎉 **Bounty Auto-Claimed!**\\n\\n@\${prAuthor}, your **\${bounty.rewardAmount} \${bounty.currency}** reward is being processed!\\n\\nWallet: \\\`\${walletAddress}\\\`\\nTrack at https://roxonn.com/dashboard\`
      );
    }
  } catch (error: any) {
    log(\`Failed to auto-claim for issue #\${issueNumber}: \${error.message}\`, 'bounty:autoclaim');
    if (installationId) {
      await postGitHubComment(
        installationId, repoOwner, repoName, issueNumber,
        \`⚠️ **Claim Issue**\\n\\n@\${prAuthor}, manual claim at https://roxonn.com/community-bounties\`
      ).catch(() => {});
    }
  }
}

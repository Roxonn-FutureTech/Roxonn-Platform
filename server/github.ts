import axios, { AxiosRequestConfig } from 'axios';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { config } from './config';
import { blockchain } from './blockchain';
import { storage } from './storage';
import { log } from './utils';
import { Webhooks } from "@octokit/webhooks";
import { ethers } from 'ethers';
// Import Octokit App Auth
import { createAppAuth } from "@octokit/auth-app";
import type { IssueBountyDetails } from "@shared/schema";

// Comment out old webhooks instance
/*
const webhooks = new Webhooks({
  secret: config.githubWebhookSecret
});
*/

interface GitHubRepo {
  id: number;
  name: string;
  description: string;
  updated_at: string;
  html_url: string;
  open_issues_count: number;
}

interface GitHubIssue { // Raw structure from GitHub API
  id: number; // Global ID
  number: number; // Repository-specific number
  title: string;
  body: string; // Often needed for context
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  labels: Array<{
    id?: number; // GitHub label objects have an id
    node_id?: string;
    url?: string;
    name: string;
    color: string;
    default?: boolean;
    description?: string | null;
  }>;
  state: string;
  html_url: string;
  // Add other fields if needed by client, e.g., updated_at, comments_url etc.
}

interface GitHubPR {
  id: number;
  title: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  state: string;
  html_url: string;
}

// Webhook Types
export interface GitHubWebhookUser {
  login: string;
  id: number;
}

export interface GitHubWebhookIssue {
  id: number;
  number: number;
  state: string;
  state_reason?: string;
  user: GitHubWebhookUser;
}

export interface GitHubWebhookPullRequest {
  id: number;
  number: number;
  merged: boolean;
  merged_by: GitHubWebhookUser;
  body: string;
  user: GitHubWebhookUser;
  html_url: string;
  base: {
    repo: {
      id: number;
    }
  };
}

export interface WebhookPayload {
  action: string;
  repository: {
    id: number;
    full_name: string;
  };
  pull_request?: GitHubWebhookPullRequest;
  issue?: GitHubWebhookIssue;
  sender: GitHubWebhookUser;
}

const ORG_NAME = 'Roxonn-FutureTech';

// Export the constant
export const GITHUB_API_BASE = 'https://api.github.com';

// --- SSRF Protection: Safe URL Builder ---

// GitHub username/org name regex: alphanumeric and hyphens, 1-39 characters
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

// GitHub repo name regex: alphanumeric, hyphens, underscores, dots, 1-100 characters
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Validates a GitHub username/organization name against SSRF attacks
 * @param owner - The GitHub username or organization name
 * @returns true if valid, false otherwise
 */
export function isValidGitHubOwner(owner: string): boolean {
  if (!owner || typeof owner !== 'string') return false;
  // Check for path traversal attempts
  if (owner.includes('/') || owner.includes('\\') || owner.includes('..')) return false;
  // Check for URL-encoded characters
  if (owner.includes('%')) return false;
  return GITHUB_OWNER_REGEX.test(owner);
}

/**
 * Validates a GitHub repository name against SSRF attacks
 * @param repo - The GitHub repository name
 * @returns true if valid, false otherwise
 */
export function isValidGitHubRepo(repo: string): boolean {
  if (!repo || typeof repo !== 'string') return false;
  // Check for path traversal attempts
  if (repo.includes('/') || repo.includes('\\') || repo.includes('..')) return false;
  // Check for URL-encoded characters
  if (repo.includes('%')) return false;
  return GITHUB_REPO_REGEX.test(repo);
}

/**
 * Safely builds a GitHub API URL with validated owner and repo
 * Prevents SSRF attacks by validating inputs before URL construction
 * @param path - The API path template (e.g., '/repos/{owner}/{repo}/issues')
 * @param params - Object containing owner, repo, and other parameters
 * @returns The safe URL or throws an error if validation fails
 */
export function buildSafeGitHubUrl(path: string, params: Record<string, string>): string {
  // Validate owner if present
  if (params.owner && !isValidGitHubOwner(params.owner)) {
    throw new Error(`Invalid GitHub owner name: ${params.owner}`);
  }

  // Validate repo if present
  if (params.repo && !isValidGitHubRepo(params.repo)) {
    throw new Error(`Invalid GitHub repository name: ${params.repo}`);
  }

  // Build the URL by replacing placeholders
  let url = path;
  for (const [key, value] of Object.entries(params)) {
    // Double-check each value doesn't contain dangerous characters
    if (value.includes('/') || value.includes('\\') || value.includes('..')) {
      throw new Error(`Invalid parameter value for ${key}: ${value}`);
    }
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }

  return `${GITHUB_API_BASE}${url}`;
}

// --- GitHub API Auth Helpers ---

// Export the helper
export function getGitHubApiHeaders(token: string): Record<string, string> {
    return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

// Gets headers using the logged-in user's token from the request
function getGitHubApiHeadersForUser(req: Request): Record<string, string> {
    // Add error handling if token is missing
    if (!req.user?.githubAccessToken) {
        log('Error: Missing user GitHub token for API header.', 'github');
        // Return minimal headers, API call will likely fail (or throw error?)
        return { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; 
    }
    return getGitHubApiHeaders(req.user.githubAccessToken);
}

// Gets headers using the server's PAT (use sparingly)
function getGitHubApiHeadersForServerPAT(): Record<string, string> {
    const githubPat = process.env.GITHUB_PAT || config.githubPat;
    if (!githubPat) {
        log('Error: Missing GitHub PAT for server-side API call.', 'github');
        return { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; 
    }
     return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `token ${githubPat}`,
        'X-GitHub-Api-Version': '2022-11-28',
    }; 
}

// Export the helper
export async function getInstallationAccessToken(installationId: string): Promise<string | null> {
    if (!config.githubAppId || !config.githubAppPrivateKey || !installationId) {
        log('Error: Missing GitHub App credentials or Installation ID for token generation.', 'github-auth');
        return null;
    }
    try {
        const auth = createAppAuth({
            appId: config.githubAppId,
            privateKey: config.githubAppPrivateKey,
            installationId: installationId,
        });
        const installationAuthentication = await auth({ type: "installation" });
        log(`Generated installation token for installation ID: ${installationId}`, 'github-auth');
        return installationAuthentication.token;
    } catch (error: any) {
        log(`Error generating installation token for ID ${installationId}: ${error.message}`, 'github-auth');
        return null;
    }
}

export async function getOrgRepos(req: Request, res: Response) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.perPage as string) || 10;

    const response = await axios.get<GitHubRepo[]>(
      `${GITHUB_API_BASE}/orgs/${ORG_NAME}/repos`,
      {
        params: {
          page,
          per_page: perPage,
          sort: 'updated',
          direction: 'desc'
        },
        headers: getGitHubApiHeadersForUser(req)
      }
    );

    // Get total count from GitHub API response headers
    const totalCount = parseInt(response.headers['x-total-count'] || '0');
    const totalPages = Math.ceil(totalCount / perPage);

    // Format repos data
    const repos = response.data
      .filter((repo: GitHubRepo) => repo.name !== '.github') // Filter out the .github repo
      .map((repo: GitHubRepo) => ({
        id: repo.id,
        name: repo.name,
        description: repo.description,
        updated_at: repo.updated_at,
        html_url: repo.html_url,
        open_issues_count: repo.open_issues_count
      }));

    return res.json({
      repos,
      pagination: {
        currentPage: page,
        perPage,
        totalCount,
        totalPages
      }
    });
  } catch (error: any) {
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch repositories'
    });
  }
}

export async function getRepoDetails(req: Request, res: Response) {
  try {
    const { owner, name } = req.params;

    // SSRF Protection: Validate owner and repo parameters
    const repoOwner = owner || ORG_NAME;
    if (!isValidGitHubOwner(repoOwner) || !isValidGitHubRepo(name)) {
      return res.status(400).json({ error: 'Invalid repository owner or name format' });
    }

    const repoFullName = `${repoOwner}/${name}`;

    // Check if this is a registered private repo that requires installation token
    const registeredRepo = await storage.findRepositoryByFullName(repoFullName);
    let apiHeaders: Record<string, string>;
    let isPrivateRepo = false;

    if (registeredRepo?.isPrivate && registeredRepo?.installationId) {
      // For private repos, use GitHub App installation token
      log(`Private repo detected: ${repoFullName}, using installation token`, 'github');

      // First verify the user is a collaborator on this private repo
      if (!req.user?.username) {
        return res.status(401).json({ error: 'Authentication required for private repository' });
      }

      const installationToken = await getInstallationAccessToken(registeredRepo.installationId);
      if (!installationToken) {
        log(`Could not get installation token for private repo ${repoFullName}`, 'github');
        return res.status(500).json({ error: 'Failed to access private repository' });
      }

      // Verify user is a collaborator using installation token
      try {
        const collaboratorCheckUrl = `${GITHUB_API_BASE}/repos/${repoFullName}/collaborators/${req.user.username}`;
        const collaboratorResponse = await axios.get(collaboratorCheckUrl, {
          headers: getGitHubApiHeaders(installationToken),
          validateStatus: (status) => status === 204 || status === 404
        });

        if (collaboratorResponse.status !== 204) {
          log(`User ${req.user.username} is not a collaborator on private repo ${repoFullName}`, 'github');
          return res.status(403).json({ error: 'You do not have access to this private repository' });
        }
      } catch (collabError: any) {
        log(`Error checking collaborator status: ${collabError.message}`, 'github');
        return res.status(403).json({ error: 'Could not verify access to private repository' });
      }

      apiHeaders = getGitHubApiHeaders(installationToken);
      isPrivateRepo = true;
    } else {
      // For public repos, use user's OAuth token (or fallback)
      apiHeaders = getGitHubApiHeadersForUser(req);
    }

    // Fetch repository details (using already validated repoOwner and name)
    const repoResponse = await axios.get(
      buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner: repoOwner, repo: name }),
      { headers: apiHeaders }
    );

    if (!repoResponse.data) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    // Then fetch issues and PRs
    const [issuesResponse, prsResponse] = await Promise.all([
      axios.get(buildSafeGitHubUrl('/repos/{owner}/{repo}/issues', { owner: repoOwner, repo: name }), {
        params: { state: 'open' },
        headers: apiHeaders
      }),
      axios.get(buildSafeGitHubUrl('/repos/{owner}/{repo}/pulls', { owner: repoOwner, repo: name }), {
        params: { state: 'open' },
        headers: apiHeaders
      })
    ]);

    const repo = repoResponse.data;
    const issues = issuesResponse.data;
    const prs = prsResponse.data;

    return res.json({
      repo: {
        id: repo.id,
        name: repo.name,
        description: repo.description,
        html_url: repo.html_url,
        updated_at: repo.updated_at,
        open_issues_count: repo.open_issues_count,
        // Forward permissions if available and needed by client
        permissions: repo.permissions,
        // Add private flag for client awareness
        private: isPrivateRepo || repo.private
      },
      issues: issues.map((issue: GitHubIssue) => ({ // issue is raw from GitHub API
        id: issue.id,         // Global GitHub ID
        number: issue.number, // Repository-specific issue number
        title: issue.title,
        body: issue.body,     // Include body
        user: issue.user,     // { login, avatar_url }
        created_at: issue.created_at,
        labels: issue.labels.map(label => ({ name: label.name, color: label.color })), // Simplify labels
        state: issue.state,
        html_url: issue.html_url,
        updated_at: (issue as any).updated_at // Add updated_at if present
      })),
      pullRequests: prs.map((pr: GitHubPR) => ({
        id: pr.id,
        title: pr.title,
        user: pr.user,
        created_at: pr.created_at,
        state: pr.state,
        html_url: pr.html_url
      }))
    });
  } catch (error: any) {
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch repository details'
    });
  }
}

// Webhook Functions
// Comment out old signature verification if using App webhook exclusively
/*
async function verifySignature(req: Request): Promise<boolean> {
  try {
    const signature = req.headers['x-hub-signature'];
    const signature256 = req.headers['x-hub-signature-256'];
    
    if (!signature && !signature256) {
      log('Missing signature headers', 'webhook');
      return false;
    }

    const rawBody = req.body.toString('utf8');

    // Use Octokit's verify method
    if (typeof signature256 === 'string') {
      return await webhooks.verify(rawBody, signature256);
    }
    return false;
  } catch (error) {
    log(`Signature verification error: ${error}`, 'webhook');
    return false;
  }
}
*/

// Updated helper to extract multiple issue numbers and avoid Set iteration
function extractIssueNumbers(prBody: string): number[] {
  if (!prBody) return [];
  const regex = /(?:fixes|closes|resolves)\s+#(\d+)/gi; 
  const issueNumbersMap: { [key: number]: boolean } = {}; // Use map to handle uniqueness
  let match;
  while ((match = regex.exec(prBody)) !== null) {
      if (match[1]) {
          const num = parseInt(match[1]);
          if (!isNaN(num)) {
              issueNumbersMap[num] = true;
          }
      }
  }
  // Convert map keys back to numbers
  return Object.keys(issueNumbersMap).map(Number);
}

// Comment out old handler entirely
/*
async function handleIssueEvent(payload: WebhookPayload) {
  // ... old implementation ...
}
*/

// New handler for merged Pull Requests
export async function handlePullRequestMerged(payload: WebhookPayload, installationId: string) {
  if (!payload.pull_request || !payload.pull_request.merged || !payload.pull_request.body) {
    log('PR not merged or body is empty, skipping distribution.', 'webhook');
    return;
  }

  const pr = payload.pull_request;
  const repoId = payload.repository.id;
  const repoFullName = payload.repository.full_name;
  const prAuthorUsername = pr.user.login; // User who opened the PR

  log(`Processing merged PR #${pr.number} by ${prAuthorUsername} in repo ${repoFullName} (Install ID: ${installationId})`, 'webhook');

  // Extract linked issue numbers from PR body
  const issueNumbers = extractIssueNumbers(pr.body);
  if (issueNumbers.length === 0) {
    log(`No issue numbers found linked in PR #${pr.number} body using keywords (closes, fixes, resolves).`, 'webhook');
    return;
  }

  log(`Found linked issue numbers: ${issueNumbers.join(', ')}`, 'webhook');

  // Get contributor user from DB (using PR author)
  const contributor = await storage.getUserByGithubUsername(prAuthorUsername);
  if (!contributor || !contributor.xdcWalletAddress) {
    log(`Contributor ${prAuthorUsername} (PR author) not registered or has no wallet. Skipping distribution for PR #${pr.number}.`, 'webhook');
    return;
  }

  // Get a pool manager for the repo (needed to authorize distribution)
  const poolManager = await storage.getRepositoryPoolManager(repoId);
  if (!poolManager) {
    log(`No pool manager found for repository ${repoId}. Cannot distribute rewards for PR #${pr.number}.`, 'webhook');
    return;
  }

  // --- Use Installation Token for GitHub API Calls --- 
  const installationToken = await getInstallationAccessToken(installationId);
  if (!installationToken) {
    log(`Webhook Error: Could not get installation token for installId ${installationId}. Cannot fetch issue details.`, 'webhook');
    return; // Cannot proceed without token
  }
  const installationApiHeaders = getGitHubApiHeaders(installationToken);

  // Process each linked issue number
  for (const issueNumber of issueNumbers) {
    log(`Checking bounty for issue #${issueNumber} linked to PR #${pr.number}`, 'webhook');
    
    let githubIssueId: number | null = null;
    try {
      // Fetch issue details USING INSTALLATION TOKEN
      const issueDetailsResponse = await axios.get(
         `${GITHUB_API_BASE}/repos/${repoFullName}/issues/${issueNumber}`,
         { headers: installationApiHeaders } // Use installation token headers
       );
       githubIssueId = issueDetailsResponse.data?.id; 
       if (!githubIssueId) {
           log(`Could not retrieve GitHub ID for issue #${issueNumber} from API response.`, 'webhook');
           continue;
       }
    } catch (issueFetchError: any) {
        log(`Failed to fetch details for issue #${issueNumber} in repo ${repoFullName}: ${issueFetchError.message}`, 'webhook');
        continue; // Skip to next issue number if fetch fails
    }

    log(`GitHub Issue ID for #${issueNumber} is ${githubIssueId}`, 'webhook');

    // Check if a bounty exists for this issue number on the blockchain
    try {
      // USE REPOSITORY-SPECIFIC issueNumber FOR BLOCKCHAIN CALLS
      const issueBountyDetailsArray = await blockchain.getIssueRewards(repoId, [issueNumber]);
      if (!issueBountyDetailsArray || issueBountyDetailsArray.length === 0) {
        log(`No bounty details found on-chain for issue #${issueNumber}.`, 'webhook');
        continue;
      }
      const issueBounty = issueBountyDetailsArray[0];

      // Determine currency type and amount (check USDC first, then ROXN, then XDC)
      let amountStr: string | null = null;
      let currency: string;
      
      const usdcAmount = parseFloat(issueBounty.usdcAmount || "0");
      const roxnAmount = parseFloat(issueBounty.roxnAmount || "0");
      const xdcAmount = parseFloat(issueBounty.xdcAmount || "0");
      
      if (usdcAmount > 0) {
        amountStr = issueBounty.usdcAmount ?? null;
        currency = "USDC";
      } else if (issueBounty.isRoxn || roxnAmount > 0) {
        amountStr = issueBounty.roxnAmount ?? null;
        currency = "ROXN";
      } else if (xdcAmount > 0) {
        amountStr = issueBounty.xdcAmount ?? null;
        currency = "XDC";
      } else {
        log(`No bounty amount found for issue #${issueNumber}.`, 'webhook');
        continue; // Skip to next issue
      }

      log(`Found bounty ${amountStr} ${currency} for issue #${issueNumber}. Attempting distribution to ${prAuthorUsername}.`, 'webhook');

      // Distribute reward using the REPOSITORY-SPECIFIC issueNumber.
      const result = await blockchain.distributeReward(
        repoId,
        issueNumber, // Use the repository-specific issue number
        contributor.xdcWalletAddress,
        poolManager.id // Authorize using the found pool manager's DB ID
      );

      log(`Distribution successful for issue #${issueNumber}. TX: ${result?.hash || 'N/A'}`, 'webhook');
      // TODO Optional: Update bounty status in DB if using a bounty_assignments table

    } catch (distributionError: any) {
      // Log error without assuming rewardAmountWei is defined here
      log(`Error distributing reward for issue #${issueNumber} to ${contributor.xdcWalletAddress}: ${distributionError.message}`, 'webhook');
      // Continue to next issue even if one fails
    }
  }
  log(`Finished processing merged PR #${pr.number} for repo ${repoFullName}`, 'webhook');
}

/**
 * Verifies if a GitHub repository exists and is accessible
 * @param owner Repository owner username or org
 * @param repo Repository name
 * @returns Boolean indicating if repository exists
 */
export async function verifyRepoExists(owner: string, repo: string): Promise<boolean> {
  // SSRF Protection: Validate owner and repo parameters
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid GitHub owner/repo format: ${owner}/${repo}`, 'github');
    return false;
  }

  try {
    log(`Verifying repository existence: ${owner}/${repo}`, 'github');

    const response = await axios.get(
      buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner, repo }),
      { headers: getGitHubApiHeadersForServerPAT() }
    );
    
    return response.status === 200;
  } catch (error) {
    log(`Error verifying repository: ${error}`, 'github');
    return false;
  }
}

/**
 * Verifies if the user associated with the provided token has admin access to a repository.
 * Uses the /repos/:owner/:repo endpoint which returns permissions for the authenticated user.
 * @param token User's GitHub access token
 * @param owner Repository owner username or org
 * @param repo Repository name
 * @returns Boolean indicating if user has admin access
 */
export async function verifyUserIsRepoAdmin(token: string, owner: string, repo: string): Promise<boolean> {
  // SSRF Protection: Validate owner and repo parameters
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid GitHub owner/repo format: ${owner}/${repo}`, 'github');
    return false;
  }

  try {
    log(`Verifying user admin permissions for ${owner}/${repo} via repo details endpoint`, 'github');

    // Fetch main repository details using the user's token
    const response = await axios.get(
      buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner, repo }),
      { headers: getGitHubApiHeaders(token) }
    );
    
    // Check if the response includes the permissions object and admin is true
    if (response.status === 200 && response.data?.permissions?.admin === true) {
      log(`Admin permission confirmed for user on ${owner}/${repo}.`, 'github');
      return true;
    } else {
      log(`Admin permission NOT found for user on ${owner}/${repo}. Status: ${response.status}, Permissions: ${JSON.stringify(response.data?.permissions)}`, 'github');
      return false;
    }

  } catch (error: any) {
    // Log error details, e.g., 404 means user likely doesn't have access at all
    log(`Error verifying user permission via repo details for ${owner}/${repo}: ${error.response?.status} - ${error.message}`, 'github');
    return false; // Return false on any error (like 404 Not Found / no access)
  }
}

/**
 * Verifies if a user is an admin of a GitHub organization
 * @param token User's GitHub OAuth token
 * @param orgName Organization login name
 * @returns Boolean indicating if user has admin access to the org
 */
export async function verifyUserIsOrgAdmin(token: string, orgName: string): Promise<boolean> {
  // SSRF Protection: Validate org name (use same validation as owner)
  if (!isValidGitHubOwner(orgName)) {
    log(`Invalid GitHub org name format: ${orgName}`, 'github');
    return false;
  }

  try {
    log(`Verifying user admin permissions for org ${orgName}`, 'github');

    // Fetch user's membership in the organization
    const response = await axios.get(
      buildSafeGitHubUrl('/user/memberships/orgs/{orgName}', { orgName }),
      { headers: getGitHubApiHeaders(token) }
    );

    // Check if the user has admin role in the organization
    if (response.status === 200 && response.data?.role === 'admin') {
      log(`Admin permission confirmed for user in org ${orgName}.`, 'github');
      return true;
    } else {
      log(`User is NOT admin in org ${orgName}. Role: ${response.data?.role}`, 'github');
      return false;
    }

  } catch (error: any) {
    // 404 means user is not a member of the org
    log(`Error verifying user org admin permission for ${orgName}: ${error.response?.status} - ${error.message}`, 'github');
    return false;
  }
}

/**
 * Get list of GitHub organizations where the user is an admin
 * @param token User's GitHub OAuth token
 * @returns Array of org objects with login and avatar_url
 */
export async function getUserAdminOrgs(token: string): Promise<{ login: string; avatar_url: string }[]> {
  try {
    log('Fetching user admin organizations', 'github');

    // Get all org memberships for the user
    const response = await axios.get(
      `${GITHUB_API_BASE}/user/memberships/orgs`,
      {
        headers: getGitHubApiHeaders(token),
        params: { state: 'active' }
      }
    );

    // Filter for admin role only
    const adminOrgs = response.data
      .filter((membership: any) => membership.role === 'admin')
      .map((membership: any) => ({
        login: membership.organization.login,
        avatar_url: membership.organization.avatar_url
      }));

    log(`User is admin of ${adminOrgs.length} organizations`, 'github');
    return adminOrgs;

  } catch (error: any) {
    log(`Error fetching user admin orgs: ${error.response?.status} - ${error.message}`, 'github');
    return [];
  }
}

/**
 * Get repositories from a GitHub organization that the user can register
 * @param token User's GitHub OAuth token
 * @param orgName Organization login name
 * @returns Array of repo objects
 */
export async function getOrgReposForRegistration(token: string, orgName: string): Promise<any[]> {
  // SSRF Protection: Validate org name
  if (!isValidGitHubOwner(orgName)) {
    log(`Invalid GitHub org name format: ${orgName}`, 'github');
    return [];
  }

  try {
    log(`Fetching repositories for org ${orgName}`, 'github');

    // Get all repos from the organization
    const response = await axios.get(
      buildSafeGitHubUrl('/orgs/{orgName}/repos', { orgName }),
      {
        headers: getGitHubApiHeaders(token),
        params: {
          type: 'all',
          per_page: 100,
          sort: 'updated'
        }
      }
    );

    // Filter for repos where user has admin permissions
    const adminRepos = response.data.filter((repo: any) => repo.permissions?.admin === true);

    log(`Found ${adminRepos.length} admin repos in org ${orgName} (of ${response.data.length} total)`, 'github');
    return adminRepos.map((repo: any) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      updated_at: repo.updated_at
    }));

  } catch (error: any) {
    log(`Error fetching org repos for ${orgName}: ${error.response?.status} - ${error.message}`, 'github');
    return [];
  }
}

// Comment out old webhook handler
/*
export async function handleGitHubWebhook(req: Request, res: Response) {
  try {
    log('Webhook request received', 'webhook');
    const event = req.headers['x-github-event'] as string;
    log(`Event: ${event}`, 'webhook');
    
    const rawBody = req.body.toString('utf8');
    const signature = req.headers['x-hub-signature-256'] as string; // Assert as string
    
    if (!signature) {
      log('Missing signature header (x-hub-signature-256)', 'webhook');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Verify signature *before* parsing body
    const isValid = await webhooks.verify(rawBody, signature);
    if (!isValid) {
      log('Invalid webhook signature', 'webhook');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    log('Webhook signature verified successfully', 'webhook');

    // Parse JSON body after verification
    const payload = JSON.parse(rawBody);

    // Route to the correct handler based on event type
    if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
      log(`Processing merged PR event for PR #${payload.pull_request?.number}`, 'webhook');
      // Call the new handler asynchronously (don't wait for it to finish)
      // Use setImmediate or similar to ensure response is sent first
      setImmediate(() => {
          handlePullRequestMerged(payload).catch(err => {
             log(`Error in background PR handler: ${err?.message || err}`, 'webhook');
          });
      });
      // Respond quickly with 202 Accepted
      res.status(202).json({ message: 'Webhook received and PR processing initiated.' }); 
    } else if (event === 'issues' && payload.action === 'closed') {
      // Explicitly ignore issue closed events now
      log(`Ignoring issue closed event for #${payload.issue?.number}`, 'webhook');
      res.status(200).json({ message: 'Issue event ignored.' });
    } else {
      log(`Ignoring ${event} event with action ${payload.action}`, 'webhook');
      res.status(200).json({ message: 'Event ignored' });
    }
  } catch (error: any) {
    log(`Webhook error: ${error?.message || error}`, 'webhook');
    // Ensure response is sent on error too
    if (!res.headersSent) {
        res.status(500).json({ 
          error: 'Webhook processing failed',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
  }
}
*/

// Function to get repositories the authenticated user administers (including orgs)
export async function getUserAdminRepos(req: Request, res: Response) {
  if (!req.user || !req.user.githubAccessToken) {
    return res.status(401).json({ error: 'User not authenticated or GitHub token missing' });
  }

  // Use private access token if user has upgraded, otherwise use regular token
  const userToken = (req.user as any).hasPrivateRepoAccess && (req.user as any).githubPrivateAccessToken
    ? (req.user as any).githubPrivateAccessToken
    : req.user.githubAccessToken;

  const apiHeaders = getGitHubApiHeaders(userToken);

  try {
    log(`Fetching admin repos for user ${req.user.githubUsername}`, 'github');
    let allAdminRepos: any[] = [];

    // 1. Fetch direct/collaborator repos
    try {
        log('Fetching direct/collaborator repos...', 'github');
        const directReposResponse = await axios.get<any[]>(
            `${GITHUB_API_BASE}/user/repos`,
            {
                params: { affiliation: 'owner,collaborator', per_page: 100 },
                headers: apiHeaders
            }
        );
        allAdminRepos = allAdminRepos.concat(directReposResponse.data.filter(repo => repo.permissions?.admin === true));
        log(`Found ${allAdminRepos.length} direct/collaborator admin repos.`, 'github');
    } catch (err: any) {
        log(`Error fetching direct repos: ${err.message}`, 'github');
        // Decide if this error is critical or if we should continue to orgs
        // For now, let's log and continue
    }

    // 2. Fetch user's organizations
    let userOrgs: { login: string }[] = [];
    try {
        log('Fetching user organizations...', 'github');
        const orgsResponse = await axios.get< { login: string }[] >(
            `${GITHUB_API_BASE}/user/orgs`,
            { headers: apiHeaders }
        );
        userOrgs = orgsResponse.data;
        log(`User is member of ${userOrgs.length} organizations.`, 'github');
    } catch (err: any) {
        log(`Error fetching user orgs: ${err.message}`, 'github');
        // Cannot fetch org repos if this fails
        // return res.status(500).json({ error: 'Failed to fetch user organizations' }); 
    }

    // 3. Fetch repos for each organization and filter for admin
    for (const org of userOrgs) {
        try {
            log(`Fetching repos for organization: ${org.login}...`, 'github');
            // Note: GitHub might require specific permissions/scopes to list org repos via user token
            const orgReposResponse = await axios.get<any[]>(
                `${GITHUB_API_BASE}/orgs/${org.login}/repos`,
                {
                    params: { type: 'member', per_page: 100 }, // Get repos user is member of within org
                    headers: apiHeaders
                }
            );
            const orgAdminRepos = orgReposResponse.data.filter(repo => repo.permissions?.admin === true);
            allAdminRepos = allAdminRepos.concat(orgAdminRepos);
            log(`Found ${orgAdminRepos.length} admin repos in ${org.login}. Total admin repos now: ${allAdminRepos.length}`, 'github');
        } catch (err: any) {
            log(`Error fetching repos for org ${org.login}: ${err.message}`, 'github');
            // Continue to next org even if one fails
        }
    }

    // 4. De-duplicate results (based on repo ID)
    const uniqueAdminRepos = Array.from(new Map(allAdminRepos.map(repo => [repo.id, repo])).values());
    log(`Total unique admin repos found: ${uniqueAdminRepos.length}`, 'github');

    // 5. Format the response
    const formattedRepos = uniqueAdminRepos.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      html_url: repo.html_url,
      private: repo.private || false, // Include private flag
      owner: {
        login: repo.owner.login
      },
      permissions: {
        admin: true // We already filtered for this
      }
    }));

    res.json({ repositories: formattedRepos });

  } catch (error: any) {
    // Catch any unexpected errors during the overall process
    log(`Error in getUserAdminRepos main block: ${error.message}`, 'github');
    if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to fetch user repositories due to an unexpected error.'
        });
    }
  }
}

// --- Handler for Issue Closed Event --- 
// Modify signature to accept installationId
export async function handleIssueClosed(payload: WebhookPayload, installationId: string) {
  log(`[handleIssueClosed Start] Event received for issue #${payload.issue?.number}, action: ${payload.action}`, 'webhook-issue');

  // 1. Basic Payload Check & Variable Setup
  if (!payload.issue || payload.action !== 'closed' || !installationId) { // Also check installationId
    log('Ignoring event: Not an issue closed event or missing installation ID.', 'webhook-issue');
    return;
  }
  const issue = payload.issue;
  const repo = payload.repository;
  const repoId = repo.id;
  const issueId = issue.id;
  const issueNumber = issue.number;
  const repoFullName = repo.full_name;

  // SSRF Protection: Validate repo full name even though it comes from webhook
  const [webhookOwner, webhookRepo] = (repoFullName || '').split('/');
  if (!isValidGitHubOwner(webhookOwner) || !isValidGitHubRepo(webhookRepo)) {
    log(`Invalid repo format in webhook payload: ${repoFullName}`, 'webhook-issue');
    return;
  }

  log(`Processing Issue Closed: Repo=${repoFullName}(${repoId}), Issue=#${issueNumber}(${issueId}), Install=${installationId}`, 'webhook-issue');

  log(`Issue state_reason: ${issue.state_reason || 'N/A'}`, 'webhook-issue');

  // 2. Check Repo Registration
  log(`Webhook: Checking registration for repo ID ${repoId}`, 'webhook-issue');
  const registration = await storage.findRegisteredRepositoryByGithubId(String(repoId));
  if (!registration) {
      log(`Ignoring Issue Closed: Repository ${repoFullName} (ID: ${repoId}) is not registered.`, 'webhook-issue');
      return;
  }
  log(`Repository ${repoFullName} is registered. Proceeding.`, 'webhook-issue');

  // 3. Check Bounty on Blockchain
  let issueBounty: IssueBountyDetails | null = null;
  try {
      // USE REPOSITORY-SPECIFIC issueNumber FOR BLOCKCHAIN CALLS
      const issueBountyDetailsArray = await blockchain.getIssueRewards(repoId, [issueNumber]);
      if (!issueBountyDetailsArray || issueBountyDetailsArray.length === 0) {
        log(`No bounty details found on-chain for issue #${issueNumber}.`, 'webhook-issue');
        return;
      }
      issueBounty = issueBountyDetailsArray[0];
      
      // Determine currency type and amount (check USDC first, then ROXN, then XDC)
      let amountStr: string | null = null;
      let currency: string;
      
      const usdcAmount = parseFloat(issueBounty.usdcAmount || "0");
      const roxnAmount = parseFloat(issueBounty.roxnAmount || "0");
      const xdcAmount = parseFloat(issueBounty.xdcAmount || "0");
      
      if (usdcAmount > 0) {
        amountStr = issueBounty.usdcAmount ?? null;
        currency = "USDC";
      } else if (issueBounty.isRoxn || roxnAmount > 0) {
        amountStr = issueBounty.roxnAmount ?? null;
        currency = "ROXN";
      } else if (xdcAmount > 0) {
        amountStr = issueBounty.xdcAmount ?? null;
        currency = "XDC";
      } else {
        log(`No bounty amount found for issue #${issueNumber}.`, 'webhook-issue');
        return;
      }
      
      log(`Found bounty ${amountStr} ${currency} for issue #${issueNumber}.`, 'webhook-issue');
  } catch (bcError: any) {
      log(`Error checking bounty for issue #${issueNumber}: ${bcError.message}`, 'webhook-issue');
      return; // Don't proceed if we can't check the bounty
  }

  // 4. Find Closing Merged PR via Timeline API
  let closingPRAuthor: string | null = null;
  try {
      // --- Generate Installation Token --- 
      const installationToken = await getInstallationAccessToken(installationId);
      if (!installationToken) {
          log(`Webhook Error: Could not get installation token for installId ${installationId}. Cannot fetch timeline.`, 'webhook-issue');
          return; // Cannot proceed without token
      }
      const installationApiHeaders = getGitHubApiHeaders(installationToken);
      // --- Use Installation Token for API Call (using validated webhook owner/repo) ---
      const timelineUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/{issueNumber}/timeline', {
        owner: webhookOwner,
        repo: webhookRepo,
        issueNumber: String(issueNumber)
      });
      log(`Fetching timeline: ${timelineUrl}`, 'webhook-issue');
      const timelineResponse = await axios.get(timelineUrl, {
          headers: installationApiHeaders // Use token!
       });
       // Iterate backwards through timeline events to find the most recent closing event by a merged PR
       const timelineEvents = timelineResponse.data || [];
       log(`Timeline received ${timelineEvents.length} events. Iterating backwards...`, 'webhook-issue');
       for (let i = timelineEvents.length - 1; i >= 0; i--) {
           const event = timelineEvents[i];
           log(`[Timeline Event ${i}] ID: ${event.id}, Event: ${event.event}, Actor: ${event.actor?.login}, Commit: ${event.commit_id || 'N/A'}, Source Type: ${event.source?.type || 'N/A'}, Source Issue State: ${event.source?.issue?.state || 'N/A'}`, 'webhook-issue'); // Log more source details

           // Check if this is a cross-reference event triggered by the contributor's PR
           if (event.event === 'cross-referenced' && event.actor?.login && event.source?.type === 'issue') {
               log(`[Timeline Event ${i}] Found potential cross-reference by Actor ${event.actor.login}. Checking source...`, 'webhook-issue');
               const sourceIssue = event.source.issue; // This object represents the PR
               log(`[Timeline Event ${i}] Source Issue Object: ${JSON.stringify(sourceIssue)}`, 'webhook-issue');

               // Verify the source PR is closed and has a merged indicator
               // GitHub API might represent the merged state in different ways, check common patterns:
               // 1. sourceIssue.state === 'closed'
               // 2. sourceIssue.pull_request object exists and sourceIssue.pull_request.merged === true
               // 3. sourceIssue.state_reason === 'completed' (less reliable for PRs)
               const isMerged = sourceIssue?.state === 'closed' && 
                                sourceIssue?.pull_request?.merged_at !== null;

               if (isMerged) {
                   closingPRAuthor = event.actor.login; // The actor of the cross-reference IS the contributor
                   log(`Found contributor '${closingPRAuthor}' via merged cross-referenced PR event.`, 'webhook-issue');
                   break; // Stop searching, we found the contributor
               } else {
                   log(`[Timeline Event ${i}] Cross-referenced source PR not marked as merged. State: ${sourceIssue?.state}, Merged At: ${sourceIssue?.pull_request?.merged_at}`, 'webhook-issue'); // Log merged_at
               }
           } 
           // Keep the old 'closed' event check as a fallback, though less likely to work based on logs
           else if (event.event === 'closed' && event.source?.issue?.pull_request?.merged === true) {
               closingPRAuthor = event.source.issue.user?.login; 
               log(`Found contributor '${closingPRAuthor}' via direct closed event source (Fallback).`, 'webhook-issue');
               break; 
           }
       }

       if (!closingPRAuthor) {
           log(`Could not find a merged PR closing event in timeline for issue #${issueNumber}. Cannot determine contributor.`, 'webhook-issue');
           return;
       }

  } catch (timelineError: any) {
      log(`Error fetching timeline for issue #${issueNumber}: ${timelineError.message}`, 'webhook-issue');
      return;
  }
  
  // 5. Get Contributor Details from DB
  log(`Looking up contributor: ${closingPRAuthor}`, 'webhook-issue');
  const contributor = await storage.getUserByGithubUsername(closingPRAuthor);
  if (!contributor || !contributor.xdcWalletAddress) {
      log(`Contributor ${closingPRAuthor} (PR author) not registered or has no wallet. Skipping distribution for issue #${issueNumber}.`, 'webhook-issue');
      return;
  }
  log(`Found contributor wallet: ${contributor.xdcWalletAddress}`, 'webhook-issue');

  // 6. Get Pool Manager for Distribution Authorization
  const poolManager = await storage.getRepositoryPoolManager(repoId);
  if (!poolManager) {
      log(`No pool manager found for repository ${repoId}. Cannot distribute reward for issue #${issueNumber}.`, 'webhook-issue');
      return;
  }
  log(`Found pool manager: ${poolManager.id} (${poolManager.username})`, 'webhook-issue');

  // 7. Distribute Reward
  try {
      log(`Attempting distribution for issue #${issueNumber} to ${contributor.xdcWalletAddress}`, 'webhook-issue');
      // USE REPOSITORY-SPECIFIC issueNumber FOR BLOCKCHAIN CALLS
      const result = await blockchain.distributeReward(
          repoId,
          issueNumber, 
          contributor.xdcWalletAddress,
          poolManager.id 
      );
      log(`Distribution successful for issue #${issueNumber}. TX: ${result?.hash || 'N/A'}`, 'webhook-issue');
  } catch (distributionError: any) {
      log(`Error distributing reward for issue #${issueNumber}: ${distributionError.message}`, 'webhook-issue');
  }
}

// Function to find a GitHub app installation by app name/slug
export async function findAppInstallationByName(
  installations: any[], 
  appName: string = "roxonn-futuretech"
): Promise<any | null> {
  // Normalize app name for case-insensitive matching
  const normalizedAppName = appName.toLowerCase();
  
  // First try to find an exact match on app_slug
  const exactMatch = installations.find(installation => 
    installation.app_slug?.toLowerCase() === normalizedAppName
  );
  
  if (exactMatch) {
    log(`Found exact match for app ${appName} with installation ID ${exactMatch.id}`, 'github-app');
    return exactMatch;
  }
  
  // Then try a contains match on app_slug or app_name
  const containsMatch = installations.find(installation => 
    (installation.app_slug && installation.app_slug.toLowerCase().includes(normalizedAppName)) ||
    (installation.app_name && installation.app_name.toLowerCase().includes(normalizedAppName))
  );
  
  if (containsMatch) {
    log(`Found partial match for app ${appName} with installation ID ${containsMatch.id}`, 'github-app');
    return containsMatch;
  }
  
  // If we get here, no match was found
  log(`No installation found matching ${appName}`, 'github-app');
  return null;
}

// --- Bounty Command Parser ---
export interface BountyCommand {
  type: 'allocate' | 'request';
  amount?: string;
  currency?: 'XDC' | 'ROXN' | 'USDC';
}

export function parseBountyCommand(comment: string): BountyCommand | null {
  if (!comment || typeof comment !== 'string') {
    return null;
  }

  const patterns = [
    /\/bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /\/bounty\s*$/i,
    /@roxonn\s+bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /@roxonn\s+bounty\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = comment.match(pattern);
    if (match) {
      const amount = match[1];
      const currency = match[2]?.toUpperCase() as 'XDC' | 'ROXN' | 'USDC' | undefined;
      
      if (amount && currency) {
        // Validate currency
        if (!['XDC', 'ROXN', 'USDC'].includes(currency)) {
          return null;
        }
        // Validate amount
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0 || amountNum > 1000000) {
          return null;
        }
        return {
          type: 'allocate',
          amount,
          currency,
        };
      } else {
        // Just /bounty or @roxonn bounty without amount
        return {
          type: 'request',
        };
      }
    }
  }
  return null;
}

// --- Post GitHub Comment Helper ---
export async function postGitHubComment(
  installationId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  try {
    const installationToken = await getInstallationAccessToken(installationId);
    if (!installationToken) {
      throw new Error('Could not get installation token');
    }

    const apiHeaders = getGitHubApiHeaders(installationToken);
    const commentUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/{issueNumber}/comments', {
      owner,
      repo,
      issueNumber: String(issueNumber),
    });

    await axios.post(commentUrl, { body }, { headers: apiHeaders });
    log(`Posted comment on ${owner}/${repo}#${issueNumber}`, 'bounty-command');
  } catch (error: any) {
    log(`Error posting GitHub comment: ${error.message}`, 'bounty-command-ERROR');
    throw error;
  }
}

// --- Bounty Command Handler ---
export async function handleBountyCommand(
  payload: any,
  installationId: string
): Promise<void> {
  log(`[handleBountyCommand] Processing bounty command`, 'bounty-command');

  const comment = payload.comment;
  const issue = payload.issue;
  const repository = payload.repository;
  const sender = payload.sender;

  if (!comment || !issue || !repository || !sender) {
    log('Missing required payload fields', 'bounty-command-ERROR');
    return;
  }

  const repoId = String(repository.id);
  const repoFullName = repository.full_name;
  const issueNumber = issue.number;
  const issueId = String(issue.id);
  const issueUrl = issue.html_url;
  const commenter = sender.login;
  const commentBody = comment.body;

  // SSRF Protection
  const [owner, repo] = (repoFullName || '').split('/');
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid repo format: ${repoFullName}`, 'bounty-command-ERROR');
    return;
  }

  // Parse command
  const command = parseBountyCommand(commentBody);
  if (!command) {
    log(`No valid bounty command found in comment`, 'bounty-command');
    return;
  }

  log(`Command parsed: type=${command.type}, amount=${command.amount}, currency=${command.currency}`, 'bounty-command');

  // Check repository registration
  const registration = await storage.findRegisteredRepositoryByGithubId(repoId);
  if (!registration) {
    const errorMsg = `❌ **Repository Not Registered**

This repository is not registered on Roxonn. Please register it first at [Roxonn Dashboard](https://app.roxonn.com).

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
    await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
    return;
  }

  // Rate limiting: Check if command was posted recently (1 minute)
  const recentRequests = await storage.getBountyRequestsByIssue(repoId, issueId);
  const oneMinuteAgo = new Date(Date.now() - 60000);
  const recentRequest = recentRequests.find(
    (req) => req.requestedBy === commenter && new Date(req.createdAt) > oneMinuteAgo
  );

  if (recentRequest) {
    const errorMsg = `⏱️ **Rate Limit**

Please wait at least 1 minute between bounty commands on the same issue.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
    await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
    return;
  }

  // Handle allocation (pool manager only)
  if (command.type === 'allocate' && command.amount && command.currency) {
    // Check if commenter is pool manager
    const poolManager = await storage.getRepositoryPoolManager(registration.id);
    if (!poolManager || poolManager.githubUsername !== commenter) {
      const errorMsg = `❌ **Not Authorized**

Only pool managers can allocate bounties. You can request a bounty by commenting \`/bounty\`.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
      return;
    }

    // Check pool balance
    try {
      const repoDetails = await blockchain.getRepository(registration.id);
      const poolBalanceStr = command.currency === 'XDC' 
        ? repoDetails.xdcPoolRewards 
        : command.currency === 'ROXN'
        ? repoDetails.roxnPoolRewards
        : repoDetails.usdcPoolRewards;

      const poolBalance = ethers.parseUnits(poolBalanceStr, command.currency === 'USDC' ? 6 : 18);
      const amountWei = ethers.parseUnits(command.amount, command.currency === 'USDC' ? 6 : 18);
      
      if (poolBalance < amountWei) {
        const errorMsg = `❌ **Insufficient Funds**

Pool balance: ${ethers.formatUnits(poolBalance, command.currency === 'USDC' ? 6 : 18)} ${command.currency}
Requested: ${command.amount} ${command.currency}

Please add funds to the pool first.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
        await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
        return;
      }

      // Allocate bounty on blockchain
      const result = await blockchain.allocateIssueReward(
        registration.id,
        issueNumber,
        command.amount,
        command.currency,
        poolManager.id
      );

      // Success message
      const remainingBalance = poolBalance - amountWei;
      const successMsg = `🎯 **Bounty Allocated!**

| Amount | Status | Pool Balance |
|--------|--------|--------------|
| **${command.amount} ${command.currency}** | ✅ Active | ${ethers.formatUnits(remainingBalance, command.currency === 'USDC' ? 6 : 18)} ${command.currency} remaining |

**How to earn this bounty:**
1. Submit a Pull Request that fixes this issue
2. Reference this issue in your PR (e.g., "Closes #${issueNumber}")
3. Once merged, the bounty is automatically sent to your Roxonn wallet

🔗 [View on Roxonn](https://app.roxonn.com/repos/${owner}/${repo})

---
<sub>Powered by [Roxonn](https://app.roxonn.com) • Earn crypto for open source contributions</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, successMsg);
      log(`Bounty allocated: ${command.amount} ${command.currency} for issue #${issueNumber}`, 'bounty-command');

    } catch (error: any) {
      log(`Error allocating bounty: ${error.message}`, 'bounty-command-ERROR');
      const errorMsg = `❌ **Allocation Failed**

${error.message}

Please try again or contact support.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
    }

  } else {
    // Handle request (anyone can request)
    await storage.createBountyRequest({
      githubRepoId: repoId,
      githubIssueId: issueId,
      githubIssueNumber: issueNumber,
      githubIssueUrl: issueUrl,
      requestedBy: commenter,
      suggestedAmount: command.amount || null,
      suggestedCurrency: command.currency || null,
    });

    const amountText = command.amount && command.currency 
      ? `**Suggested amount:** ${command.amount} ${command.currency}`
      : 'No amount suggested';

    const requestMsg = `📋 **Bounty Requested**

@${commenter} has requested a bounty for this issue.

${amountText}

Repository maintainers can approve this request:
- Comment \`/bounty <amount> <currency>\` to allocate
- Or visit [Roxonn Dashboard](https://app.roxonn.com/repos/${owner}/${repo})

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
    await postGitHubComment(installationId, owner, repo, issueNumber, requestMsg);
    log(`Bounty request created by ${commenter} for issue #${issueNumber}`, 'bounty-command');
  }
}

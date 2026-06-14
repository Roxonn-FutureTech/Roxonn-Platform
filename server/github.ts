import axios, { AxiosRequestConfig } from 'axios';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { config } from './config';
import { blockchain } from './blockchain';
import { storage, recordPayoutWithRetry } from './storage';
import { log, sanitizeUserInput, sanitizeGitHubIssue } from './utils';
import { Webhooks } from "@octokit/webhooks";
import { ethers } from 'ethers';
// Import Octokit App Auth
import { createAppAuth } from "@octokit/auth-app";
import type { IssueBountyDetails } from "@shared/schema";
import { buildPoolPayoutRow } from './utils/payoutMapper';
import { sendRefusedPayoutAlert } from './email';

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

/**
 * Verify that a PR was merged and closes a specific issue
 *
 * WHY THIS FUNCTION:
 * - Community bounty relayer must verify PR merge before calling completeBounty()
 * - GitHub merge events cannot be verified on-chain
 * - Prevents fraudulent bounty claims without actual PR merge
 * - Provides audit trail for bounty completion
 *
 * VERIFICATION STEPS:
 * 1. Fetch PR details from GitHub API
 * 2. Verify PR.merged is true (not just closed)
 * 3. Verify PR.merged_at timestamp exists
 * 4. Extract issue numbers from PR body (closes #123 syntax)
 * 5. Verify target issue is in the linked issues list
 * 6. Verify issue is now closed
 *
 * WHY THESE CHECKS:
 * - merged=true: Ensures code was actually merged, not just closed
 * - merged_at: Prevents claiming bounty for drafts/abandoned PRs
 * - Issue linkage: Ensures PR actually addressed the bounty issue
 * - Issue closed: Confirms issue resolution (GitHub auto-closes on merge)
 *
 * @param owner - Repository owner (username or org)
 * @param repo - Repository name
 * @param prNumber - Pull request number
 * @param issueNumber - Issue number that should be closed by this PR
 * @param installationId - GitHub App installation ID for auth
 * @returns Object with verification result and details
 */
export async function verifyPRMergedAndClosesIssue(
  owner: string,
  repo: string,
  prNumber: number,
  issueNumber: number,
  installationId: string
): Promise<{
  verified: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  issueLinked: boolean;
  issueClosed: boolean;
  error?: string;
}> {
  // SSRF Protection: Validate input parameters
  if (!isValidGitHubOwner(owner)) {
    return {
      verified: false,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      issueLinked: false,
      issueClosed: false,
      error: `Invalid repository owner format: ${owner}`
    };
  }

  if (!isValidGitHubRepo(repo)) {
    return {
      verified: false,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      issueLinked: false,
      issueClosed: false,
      error: `Invalid repository name format: ${repo}`
    };
  }

  try {
    log(`Verifying PR #${prNumber} merged and closes issue #${issueNumber} in ${owner}/${repo}`, 'github');

    // WHY INSTALLATION TOKEN: Use GitHub App installation token for API access
    // This provides repo-specific permissions without requiring user tokens
    const installationToken = await getInstallationAccessToken(installationId);
    if (!installationToken) {
      return {
        verified: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        issueLinked: false,
        issueClosed: false,
        error: `Could not get installation token for installId ${installationId}`
      };
    }

    const headers = getGitHubApiHeaders(installationToken);

    // STEP 1: Fetch PR details
    // WHY: Get merge status, merge timestamp, and PR body for issue linkage
    const prResponse = await axios.get(
      buildSafeGitHubUrl('/repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: prNumber.toString()
      }),
      { headers }
    );

    const pr = prResponse.data;

    // STEP 2: Verify PR was merged (not just closed)
    // WHY: Closed PRs without merge should not trigger bounty payout
    if (!pr.merged || !pr.merged_at) {
      log(`PR #${prNumber} is not merged (merged=${pr.merged}, merged_at=${pr.merged_at})`, 'github');
      return {
        verified: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        issueLinked: false,
        issueClosed: false,
        error: 'PR is not merged'
      };
    }

    const mergedAt = pr.merged_at;
    const mergedBy = pr.merged_by?.login || null;

    log(`PR #${prNumber} was merged at ${mergedAt} by ${mergedBy}`, 'github');

    // STEP 3: Extract issue numbers from PR body
    // WHY: Verify PR explicitly links to the bounty issue
    const prBody = pr.body || '';
    const linkedIssueNumbers = extractIssueNumbers(prBody);

    log(`PR #${prNumber} links to issues: ${linkedIssueNumbers.join(', ')}`, 'github');

    // STEP 4: Verify target issue is linked
    // WHY: Prevent claiming bounty for PR that doesn't address the issue
    const issueLinked = linkedIssueNumbers.includes(issueNumber);
    if (!issueLinked) {
      log(`PR #${prNumber} does not link to issue #${issueNumber}`, 'github');
      return {
        verified: false,
        merged: true,
        mergedAt,
        mergedBy,
        issueLinked: false,
        issueClosed: false,
        error: `PR does not link to issue #${issueNumber} (found: ${linkedIssueNumbers.join(', ')})`
      };
    }

    // STEP 5: Verify issue is now closed
    // WHY: GitHub auto-closes issues when PR with "closes #123" is merged
    // If issue is not closed, something is wrong (manual reopen, etc.)
    const issueResponse = await axios.get(
      buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: issueNumber.toString()
      }),
      { headers }
    );

    const issue = issueResponse.data;
    const issueClosed = issue.state === 'closed';

    if (!issueClosed) {
      log(`Issue #${issueNumber} is not closed (state=${issue.state})`, 'github');
      return {
        verified: false,
        merged: true,
        mergedAt,
        mergedBy,
        issueLinked: true,
        issueClosed: false,
        error: `Issue #${issueNumber} is not closed`
      };
    }

    // ALL CHECKS PASSED
    log(`✅ Verification passed: PR #${prNumber} merged and closes issue #${issueNumber}`, 'github');
    return {
      verified: true,
      merged: true,
      mergedAt,
      mergedBy,
      issueLinked: true,
      issueClosed: true
    };

  } catch (error: any) {
    const errorMsg = `Error verifying PR #${prNumber}: ${error.response?.status} - ${error.message}`;
    log(errorMsg, 'github');
    return {
      verified: false,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      issueLinked: false,
      issueClosed: false,
      error: errorMsg
    };
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
      const orgsResponse = await axios.get<{ login: string }[]>(
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

  // 2.5. CRITICAL: Check Payout Idempotency EARLY (before any expensive operations)
  const existingPayout = await storage.getPayoutByRepoAndIssue(String(repoId), issueNumber);
  if (existingPayout) {
    log(`✅ Payout already processed for repo ${repoId} issue #${issueNumber}. TX: ${existingPayout.txHash}. Skipping duplicate.`, 'webhook-issue');
    return;
  }

  // 3. Check Bounty on Blockchain
  let issueBounty: IssueBountyDetails | null = null;
  let amountStr: string | null = null;
  let currency: string = '';

  try {
    // USE REPOSITORY-SPECIFIC issueNumber FOR BLOCKCHAIN CALLS
    const issueBountyDetailsArray = await blockchain.getIssueRewards(repoId, [issueNumber]);
    if (!issueBountyDetailsArray || issueBountyDetailsArray.length === 0) {
      log(`No bounty details found on-chain for issue #${issueNumber}.`, 'webhook-issue');
      return;
    }
    issueBounty = issueBountyDetailsArray[0];

    // Determine currency type and amount (check USDC first, then ROXN, then XDC)

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

  // 4. Find Closing Contributor
  let closingPRAuthor: string | null = null;
  let closingPRNumber: number | null = null;

  // CRITICAL FIX: Use issue.closed_by from webhook payload (most reliable)
  if (payload.issue?.closed_by?.login) {
    const closedByUser = payload.issue.closed_by.login;

    // Skip bot accounts
    if (!closedByUser.endsWith('[bot]')) {
      closingPRAuthor = closedByUser;
      log(`✅ Using issue.closed_by from webhook payload: ${closingPRAuthor}`, 'webhook-issue');

      // Try to get PR number from issue body or timeline (optional enhancement)
      // For now, we have the correct contributor
    } else {
      log(`⚠️ issue.closed_by is a bot (${closedByUser}), will check timeline instead`, 'webhook-issue');
    }
  } else {
    log(`⚠️ No issue.closed_by in webhook payload, will search timeline`, 'webhook-issue');
  }

  // FALLBACK: If no closed_by or it was a bot, search timeline
  if (!closingPRAuthor) {
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

    let timelineEvents: any[] = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      log(`Fetching timeline page ${page}...`, 'webhook-issue');
      const timelineResponse = await axios.get(timelineUrl, {
        headers: installationApiHeaders,
        params: { per_page: 100, page: page }
      });

      const events = timelineResponse.data || [];
      timelineEvents = timelineEvents.concat(events);

      // Check for Link header to see if there are more pages
      const linkHeader = timelineResponse.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        page++;
      } else {
        hasNextPage = false;
      }

      // Safety break to prevent infinite loops (e.g. max 10 pages / 1000 events)
      if (page > 10) {
        log(`Reached max pagination limit (10 pages) for issue #${issueNumber}. Stopping.`, 'webhook-issue');
        hasNextPage = false;
      }
    }

      log(`Timeline received total ${timelineEvents.length} events. Searching for MOST RECENT closed event...`, 'webhook-issue');

      // NEW APPROACH: Find the MOST RECENT 'closed' event to get the actual closing PR
      let closedEvent = null;
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const event = timelineEvents[i];
        if (event.event === 'closed' && event.commit_id) {
          closedEvent = event;
          log(`[Timeline] Found most recent 'closed' event at index ${i}, commit: ${event.commit_id}, actor: ${event.actor?.login}`, 'webhook-issue');
          break;
        }
      }

      if (closedEvent) {
        // The actor who performed the close action
        const closeActor = closedEvent.actor?.login;

        // Skip bot accounts
        if (closeActor && !closeActor.endsWith('[bot]')) {
          closingPRAuthor = closeActor;
          log(`✅ Found contributor via 'closed' event: ${closingPRAuthor}`, 'webhook-issue');
        } else {
          log(`⚠️ 'closed' event actor is bot or missing: ${closeActor}`, 'webhook-issue');
        }
      }

      // FALLBACK: Search cross-referenced PRs (OLD BUGGY METHOD - only as last resort)
      if (!closingPRAuthor) {
        log(`⚠️ Falling back to cross-reference search (less reliable)...`, 'webhook-issue');

        for (let i = timelineEvents.length - 1; i >= 0; i--) {
          const event = timelineEvents[i];

          // Check if this is a cross-reference event triggered by the contributor's PR
          if (event.event === 'cross-referenced' && event.actor?.login && event.source?.type === 'issue') {
            const sourceIssue = event.source.issue; // This object represents the PR
            const prNumber = sourceIssue?.number;
            const mergedAt = sourceIssue?.pull_request?.merged_at;
            const isMerged = sourceIssue?.state === 'closed' && mergedAt != null;

            log(`[Timeline Event ${i}] Cross-ref PR #${prNumber}, merged=${isMerged}, author=${sourceIssue?.user?.login}`, 'webhook-issue');

            if (isMerged) {
              // Use PR author from source, not event actor (which could be a bot commenting)
              const prAuthor = sourceIssue?.user?.login;

              // Skip bot accounts (they end with [bot])
              if (!prAuthor || prAuthor.endsWith('[bot]')) {
                log(`[Timeline Event ${i}] Skipping bot or missing PR author: ${prAuthor}`, 'webhook-issue');
                continue;
              }

              // FUND-01: Require a corroborating closing keyword before trusting cross-ref fallback.
              // The enclosing `if (isMerged)` already guarantees a merged PR (via the correct
              // sourceIssue.pull_request.merged_at path); the only additional corroboration this
              // fallback needs is a "closes/fixes/resolves #<issueNumber>" reference in title/body.
              // Without it we cannot be sure this PR closed the issue — refuse and alert, never guess.
              const closingKeywords = ['closes', 'fixes', 'resolves', 'close', 'fix', 'resolve'];
              const prBody = (sourceIssue?.body || '').toLowerCase();
              const prTitle = (sourceIssue?.title || '').toLowerCase();
              const hasClosingRef = closingKeywords.some(kw =>
                prBody.includes(`${kw} #${issueNumber}`) ||
                prTitle.includes(`${kw} #${issueNumber}`)
              );

              if (!hasClosingRef) {
                log(`❌ Cross-reference fallback: PR #${prNumber} by ${prAuthor} (merged) has no verified 'closes #${issueNumber}' keyword in title/body. Refusing payout.`, 'webhook-issue');
                await sendRefusedPayoutAlert({ repoId: String(repoId), issueNumber, candidatePR: prNumber, candidateAuthor: prAuthor });
                return; // payout stays unpaid; human does manual payout
              }

              closingPRAuthor = prAuthor;
              closingPRNumber = prNumber;
              log(`✅ Cross-reference fallback corroborated: PR #${prNumber} by ${prAuthor} has closing keyword for #${issueNumber}.`, 'webhook-issue');
              break; // Stop searching
            }
          }
        }
      }

      if (!closingPRAuthor) {
        log(`❌ Could not find contributor in timeline for issue #${issueNumber}. Cannot determine who to pay.`, 'webhook-issue');
        return;
      }

    } catch (timelineError: any) {
      log(`Error fetching timeline for issue #${issueNumber}: ${timelineError.message}`, 'webhook-issue');
      return;
    }
  }

  // 5. Get Contributor Details from DB
  log(`🔍 Looking up contributor: ${closingPRAuthor}${closingPRNumber ? ` (PR #${closingPRNumber})` : ''}`, 'webhook-issue');
  const contributor = await storage.getUserByGithubUsername(closingPRAuthor);
  if (!contributor || !contributor.xdcWalletAddress) {
    log(`❌ Contributor ${closingPRAuthor} not registered or has no wallet. Skipping distribution for issue #${issueNumber}.`, 'webhook-issue');
    return;
  }
  log(`✅ Found contributor wallet: ${contributor.xdcWalletAddress}`, 'webhook-issue');

  // 6. Get Pool Manager for Distribution Authorization
  const poolManager = await storage.getRepositoryPoolManager(repoId);
  if (!poolManager) {
    log(`❌ No pool manager found for repository ${repoId}. Cannot distribute reward for issue #${issueNumber}.`, 'webhook-issue');
    return;
  }
  log(`✅ Found pool manager: ${poolManager.id} (${poolManager.username})`, 'webhook-issue');

  // 7. Distribute Reward (D-12: pay-then-record order — blockchain tx FIRST)
  let distributionResult: any = null;
  try {
    log(`💰 Attempting distribution for issue #${issueNumber}${closingPRNumber ? ` (PR #${closingPRNumber})` : ''}`, 'webhook-issue');
    log(`   Contributor: ${closingPRAuthor}`, 'webhook-issue');
    log(`   Wallet: ${contributor.xdcWalletAddress}`, 'webhook-issue');
    log(`   Amount: ${amountStr} ${currency}`, 'webhook-issue');

    // USE REPOSITORY-SPECIFIC issueNumber FOR BLOCKCHAIN CALLS
    distributionResult = await blockchain.distributeReward(
      repoId,
      issueNumber,
      contributor.xdcWalletAddress,
      poolManager.id
    );
    log(`✅ Distribution successful for issue #${issueNumber}. TX: ${distributionResult?.hash || 'N/A'}`, 'webhook-issue');
  } catch (distributionError: any) {
    log(`Error distributing reward for issue #${issueNumber}: ${distributionError.message}`, 'webhook-issue');
    return; // distribution failed — do not attempt to record
  }

  // 8. Record payout in its OWN try-catch AFTER the distribution try-catch closes (FUND-04).
  // A ledger-write failure must NOT re-send funds. recordPayoutWithRetry handles retries+alert
  // without re-throwing (D-10). The distributeReward call above has already completed.
  if (distributionResult?.hash && amountStr) {
    const baseBountyAmount = parseFloat(amountStr);
    // FUND-04: use the tested buildPoolPayoutRow mapper (D-08 key-remap at the call site).
    // poolManagerAddress = poolManager.xdcWalletAddress (wallet string), NOT poolManager.id (int).
    await recordPayoutWithRetry(buildPoolPayoutRow({
      repositoryGithubId: String(repoId),
      issueNumber: issueNumber,
      recipientGithubUsername: closingPRAuthor,
      recipientUserId: contributor.id,
      recipientWalletAddress: contributor.xdcWalletAddress,
      baseBountyAmount: baseBountyAmount,
      currency: currency,
      txHash: distributionResult.hash,
      blockNumber: distributionResult.blockNumber ?? null,
      poolManagerAddress: poolManager.xdcWalletAddress ?? null,
    }));
    log(`Payout ledger row submitted for repo ${repoId} issue #${issueNumber}`, 'webhook-issue');
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
/*
 * BOUNTY COMMAND TYPES
 *
 * WHY THESE TYPES:
 * - 'pool_allocate': Existing pool bounty flow (pool managers only)
 * - 'community_create': NEW community bounty flow (anyone can create)
 * - 'community_claim': NEW claim community bounty via /claim command
 * - 'status': NEW check bounty status via @roxonn status
 * - 'request': Existing bounty request (ask pool manager to allocate)
 *
 * WHY SEPARATE TYPES:
 * - Clear separation between pool and community bounties
 * - Different authorization rules (pool = managers, community = anyone)
 * - Different workflows (pool = instant, community = payment required)
 */
export interface BountyCommand {
  type: 'pool_allocate' | 'community_create' | 'community_claim' | 'status' | 'request' | 'attempt';
  amount?: string;
  currency?: 'XDC' | 'ROXN' | 'USDC';
  prNumber?: number; // For claim commands
}

/*
 * COMMAND PARSER
 *
 * WHY THIS PARSING LOGIC:
 * 1. Clean comment first (remove code blocks, inline code, quotes)
 * 2. Try to match specific patterns in order of priority
 * 3. Return appropriate command type based on pattern
 *
 * COMMAND PATTERNS (in priority order):
 * 1. /bounty pool <amount> <currency> → pool_allocate (EXISTING, preserved)
 * 2. /bounty <amount> <currency> → community_create (NEW, default)
 * 3. /claim #<prNumber> → community_claim (NEW)
 * 4. @roxonn status → status (NEW)
 * 5. /bounty → request (EXISTING, ask pool manager)
 *
 * WHY PRIORITY MATTERS:
 * - "pool" keyword must be checked first (more specific)
 * - Otherwise "/bounty pool 100 USDC" would match "/bounty" pattern
 */
export function parseBountyCommand(comment: string): BountyCommand | null {
  if (!comment || typeof comment !== 'string') {
    return null;
  }

  // Remove code blocks (``` ... ```) to avoid parsing commands in examples/documentation
  // WHY: Prevents bot from responding to examples in documentation
  let cleanedComment = comment.replace(/```[\s\S]*?```/g, '');

  // Remove inline code (` ... `) to avoid parsing commands in inline examples
  // WHY: Prevents bot from responding to inline code examples
  cleanedComment = cleanedComment.replace(/`[^`]+`/g, '');

  // Remove quoted text (> ...) as these are usually references/quotes
  // WHY: Prevents bot from responding to quoted comments
  cleanedComment = cleanedComment.replace(/^>\s*.*/gm, '');

  // =========================================================================
  // PATTERN 0: /attempt (Signal intent to work on issue)
  // =========================================================================
  // WHY FIRST: Simple pattern, no arguments needed
  if (/\/attempt\s*$/i.test(cleanedComment) || /\/attempt\b/i.test(cleanedComment)) {
    return {
      type: 'attempt',
    };
  }

  // =========================================================================
  // PATTERN 1: /claim #<prNumber> (Community bounty claim)
  // =========================================================================
  // WHY FIRST: Most specific pattern, no ambiguity
  const claimPattern = /\/claim\s+#?(\d+)/i;
  const claimMatch = cleanedComment.match(claimPattern);
  if (claimMatch) {
    const prNumber = parseInt(claimMatch[1], 10);
    if (!isNaN(prNumber) && prNumber > 0) {
      return {
        type: 'community_claim',
        prNumber,
      };
    }
  }

  // =========================================================================
  // PATTERN 2: @roxonn status (Check bounty status)
  // =========================================================================
  // WHY SECOND: Specific status check, no amount parsing needed
  if (/@roxonn\s+status/i.test(cleanedComment)) {
    return {
      type: 'status',
    };
  }

  // =========================================================================
  // PATTERN 3: /bounty pool <amount> <currency> (Pool bounty - EXISTING)
  // =========================================================================
  // WHY THIRD: Must check "pool" keyword before generic "/bounty"
  // PRESERVES EXISTING BEHAVIOR for pool managers
  const poolBountyPatterns = [
    /\/bounty\s+pool\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /@roxonn\s+bounty\s+pool\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
  ];

  for (const pattern of poolBountyPatterns) {
    const match = cleanedComment.match(pattern);
    if (match) {
      const amount = match[1];
      const currency = match[2]?.toUpperCase() as 'XDC' | 'ROXN' | 'USDC';

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
        type: 'pool_allocate',
        amount,
        currency,
      };
    }
  }

  // =========================================================================
  // PATTERN 4: /bounty <amount> <currency> (Community bounty - NEW DEFAULT)
  // =========================================================================
  // WHY FOURTH: Generic bounty creation (NEW: defaults to community)
  // BREAKING CHANGE: Old "/bounty X USDC" now creates community bounty
  // MIGRATION: Pool managers must use "/bounty pool X USDC" explicitly
  const communityBountyPatterns = [
    /\/bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /@roxonn\s+bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
  ];

  for (const pattern of communityBountyPatterns) {
    const match = cleanedComment.match(pattern);
    if (match) {
      const amount = match[1];
      const currency = match[2]?.toUpperCase() as 'XDC' | 'ROXN' | 'USDC';

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
        type: 'community_create',
        amount,
        currency,
      };
    }
  }

  // =========================================================================
  // PATTERN 5: /bounty (Bounty request - EXISTING)
  // =========================================================================
  // WHY LAST: Most generic, matches "/bounty" without amount
  // PRESERVES EXISTING BEHAVIOR: Ask pool manager to allocate
  const requestPatterns = [
    /\/bounty\s*$/i,
    /@roxonn\s+bounty\s*$/i,
  ];

  for (const pattern of requestPatterns) {
    if (pattern.test(cleanedComment)) {
      return {
        type: 'request',
      };
    }
  }

  // No pattern matched
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

  // =========================================================================
  // REPOSITORY REGISTRATION CHECK
  // =========================================================================
  // WHY: Some commands require registration (pool bounties), others don't (community bounties)
  const registration = await storage.findRegisteredRepositoryByGithubId(repoId);

  // Commands that REQUIRE registration: pool_allocate, request
  // Commands that DON'T require registration: community_create, community_claim, status
  if (['pool_allocate', 'request'].includes(command.type) && !registration) {
    const errorMsg = `❌ **Repository Not Registered**

This repository is not registered on Roxonn. Please register it first at [Roxonn Dashboard](https://app.roxonn.com).

**Note:** You can still create community bounties on unregistered repos by commenting \`/bounty <amount> <currency>\`.

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

  // =========================================================================
  // COMMAND TYPE: attempt (Signal intent to work on issue)
  // =========================================================================
  // WHY: Developers can signal they're working on a bounty
  // AUTHORIZATION: Anyone can use this command
  if (command.type === 'attempt') {
    await handleAttemptCommand(payload, installationId);
    return;
  }

  // =========================================================================
  // COMMAND TYPE: pool_allocate (EXISTING POOL BOUNTY FLOW - PRESERVED)
  // =========================================================================
  // WHY: Pool managers allocate bounties from pre-funded repository pool
  // AUTHORIZATION: Only pool managers can use this command
  if (command.type === 'pool_allocate' && command.amount && command.currency) {
    // Check if commenter is pool manager
    // Use GitHub repo ID for blockchain calls (not internal DB id)
    const blockchainRepoId = parseInt(registration.githubRepoId);
    const poolManager = await storage.getRepositoryPoolManager(blockchainRepoId);
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
      const repoDetails = await blockchain.getRepository(blockchainRepoId);
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
        blockchainRepoId,
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

  // =========================================================================
  // COMMAND TYPE: community_create (NEW COMMUNITY BOUNTY FLOW)
  // =========================================================================
  // WHY: Anyone can create community bounties on any public repo
  // AUTHORIZATION: Any authenticated user
  // WORKFLOW: Create pending bounty → Reply with payment links → User pays → Bounty activated
  } else if (command.type === 'community_create' && command.amount && command.currency) {
    log(`Creating community bounty: ${command.amount} ${command.currency}`, 'bounty-command');

    // Check if bounty already exists for this issue
    const existingBounty = await storage.getCommunityBountyByIssue(owner, repo, issueNumber);
    if (existingBounty) {
      const statusEmoji = existingBounty.status === 'funded' ? '✅' : '⏳';
      const errorMsg = `❌ **Bounty Already Exists**

This issue already has a community bounty:
- **Status:** ${statusEmoji} ${existingBounty.status}
- **Amount:** ${existingBounty.amount} ${existingBounty.currency}
- **Created by:** @${existingBounty.createdByGithubUsername}

${existingBounty.status === 'funded' ? 'This bounty is active and ready to claim!' : 'Waiting for payment...'}

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
      return;
    }

    // Get user info (if authenticated)
    let creatorUserId: number | undefined;
    try {
      const user = await storage.getUserByUsername(commenter);
      creatorUserId = user?.id;
    } catch (error) {
      log(`Could not find user ${commenter}, creating bounty without user ID`, 'bounty-command');
    }

    // CRITICAL-5 FIX: Sanitize issue data before storing
    const sanitizedIssue = sanitizeGitHubIssue(issue);

    // Create pending bounty in database
    try {
      const bounty = await storage.createCommunityBounty({
        githubRepoOwner: owner,
        githubRepoName: repo,
        githubIssueNumber: issueNumber,
        githubIssueId: issueId,
        githubIssueUrl: issueUrl,
        creatorUserId,
        createdByGithubUsername: commenter,
        title: sanitizedIssue.title || `Issue #${issueNumber}`,
        description: sanitizedIssue.body?.substring(0, 500) || null,
        amount: command.amount,
        currency: command.currency,
      });

      // Generate payment links (placeholder URLs for now - will implement in Phase 5)
      const cryptoPaymentUrl = `https://app.roxonn.com/bounties/${bounty.id}/pay/crypto`;
      const fiatPaymentUrl = `https://app.roxonn.com/bounties/${bounty.id}/pay/fiat`;

      const successMsg = `🎯 **Community Bounty Created!**

| Amount | Currency | Status |
|--------|----------|--------|
| **${command.amount}** | ${command.currency} | ⏳ Awaiting Payment |

**Next Steps:**
1. Fund this bounty using one of the payment methods below
2. Once funded, anyone can claim it by submitting a PR
3. Bounty is paid automatically when PR is merged

**Payment Options:**
🔐 [Pay with Crypto](${cryptoPaymentUrl}) (USDC/XDC/ROXN)
💳 [Pay with Card/Bank](${fiatPaymentUrl}) (Fiat → Crypto)

**About Community Bounties:**
- ✅ Works on ANY public GitHub repo (no registration required)
- ✅ Transparent escrow (funds held in smart contract)
- ✅ Automatic payout on PR merge
- ✅ Refundable if unclaimed (with expiry)

🔗 [View Bounty Details](https://app.roxonn.com/bounties/${bounty.id})

---
<sub>Powered by [Roxonn](https://app.roxonn.com) • Community Bounty #${bounty.id}</sub>`;

      await postGitHubComment(installationId, owner, repo, issueNumber, successMsg);
      log(`Community bounty created: ID=${bounty.id}, Amount=${command.amount} ${command.currency}`, 'bounty-command');

    } catch (error: any) {
      log(`Error creating community bounty: ${error.message}`, 'bounty-command-ERROR');
      const errorMsg = `❌ **Bounty Creation Failed**

${error.message}

Please try again or contact support.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
    }

  // =========================================================================
  // COMMAND TYPE: community_claim (NEW CLAIM COMMUNITY BOUNTY)
  // =========================================================================
  // WHY: Contributors claim bounty after PR merge
  // AUTHORIZATION: PR author only
  // WORKFLOW: Verify PR merge → Mark as claimed → Relayer completes payout
  } else if (command.type === 'community_claim' && command.prNumber) {
    log(`Processing claim for PR #${command.prNumber}`, 'bounty-command');

    // Check if bounty exists for this issue
    const bounty = await storage.getCommunityBountyByIssue(owner, repo, issueNumber);
    if (!bounty) {
      const errorMsg = `❌ **No Bounty Found**

This issue does not have an active community bounty.

Want to create one? Comment \`/bounty <amount> <currency>\`

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
      return;
    }

    // Check bounty status
    if (bounty.status !== 'funded') {
      const statusMsg = bounty.status === 'pending_payment'
        ? 'still awaiting payment'
        : bounty.status === 'claimed'
        ? 'already claimed'
        : bounty.status === 'completed'
        ? 'already paid out'
        : `in ${bounty.status} status`;

      const errorMsg = `❌ **Bounty Not Claimable**

This bounty is ${statusMsg}.

${bounty.status === 'pending_payment' ? 'The creator needs to fund it first.' : ''}
${bounty.status === 'claimed' ? 'Payout is in progress.' : ''}
${bounty.status === 'completed' ? `Already paid to @${bounty.claimedByGithubUsername}` : ''}

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
      return;
    }

    // Verify PR exists and is merged (TODO: Implement in Phase 4)
    // For now, we'll create a placeholder that marks the bounty as claimed
    // The actual PR verification will be implemented in the webhook handler

    try {
      // Get user info
      let claimerUserId: number | undefined;
      try {
        const user = await storage.getUserByUsername(commenter);
        claimerUserId = user?.id;
      } catch (error) {
        log(`Could not find user ${commenter}`, 'bounty-command');
      }

      // Mark bounty as claimed
      await storage.updateCommunityBounty(bounty.id, {
        status: 'claimed',
        claimedByUserId: claimerUserId,
        claimedByGithubUsername: commenter,
        claimedPrNumber: command.prNumber,
        claimedPrUrl: `https://github.com/${owner}/${repo}/pull/${command.prNumber}`,
        claimedAt: new Date(),
      });

      const successMsg = `🎉 **Bounty Claimed!**

@${commenter} has claimed this bounty for PR #${command.prNumber}.

**What happens next:**
1. ✅ Our relayer will verify the PR merge
2. ✅ Payout will be processed automatically
3. ✅ Funds sent to your Roxonn wallet

**Bounty Details:**
- **Amount:** ${bounty.amount} ${bounty.currency}
- **Net Payout:** ${(parseFloat(bounty.amount) * 0.99).toFixed(8)} ${bounty.currency} (1% platform fee)

⏳ Payout typically completes within 5 minutes.

---
<sub>Powered by [Roxonn](https://app.roxonn.com) • Bounty #${bounty.id}</sub>`;

      await postGitHubComment(installationId, owner, repo, issueNumber, successMsg);
      log(`Bounty claimed: ID=${bounty.id}, Claimer=${commenter}, PR=${command.prNumber}`, 'bounty-command');

    } catch (error: any) {
      log(`Error claiming bounty: ${error.message}`, 'bounty-command-ERROR');
      const errorMsg = `❌ **Claim Failed**

${error.message}

Please try again or contact support.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
      await postGitHubComment(installationId, owner, repo, issueNumber, errorMsg);
    }

  // =========================================================================
  // COMMAND TYPE: status (NEW CHECK BOUNTY STATUS)
  // =========================================================================
  // WHY: Users can check bounty status without creating new comments
  } else if (command.type === 'status') {
    log(`Checking bounty status for issue #${issueNumber}`, 'bounty-command');

    // Check for community bounty
    const communityBounty = await storage.getCommunityBountyByIssue(owner, repo, issueNumber);

    // Check for pool bounty (if repo is registered)
    let poolBountyStatus: string | null = null;
    if (registration) {
      try {
        const blockchainRepoId = parseInt(registration.githubRepoId);
        const repoDetails = await blockchain.getRepository(blockchainRepoId);
        // Check if this issue has an allocated bounty in the pool
        // (This is a simplified check - actual implementation may vary)
        poolBountyStatus = 'Check Roxonn Dashboard for pool bounty details';
      } catch (error) {
        log(`Could not fetch pool bounty status: ${error}`, 'bounty-command');
      }
    }

    // Build status message
    let statusMsg = `📊 **Bounty Status**\n\n`;

    if (communityBounty) {
      const statusEmoji = {
        'pending_payment': '⏳',
        'funded': '✅',
        'claimed': '🎯',
        'completed': '💰',
        'refunded': '↩️',
        'expired': '⏰',
      }[communityBounty.status] || '❓';

      statusMsg += `**Community Bounty:** ${statusEmoji} ${communityBounty.status.toUpperCase()}\n`;
      statusMsg += `- **Amount:** ${communityBounty.amount} ${communityBounty.currency}\n`;
      statusMsg += `- **Created by:** @${communityBounty.createdByGithubUsername}\n`;

      if (communityBounty.status === 'pending_payment') {
        statusMsg += `- ⏳ Awaiting payment from creator\n`;
      } else if (communityBounty.status === 'funded') {
        statusMsg += `- ✅ Active and claimable!\n`;
        statusMsg += `- 💡 Submit a PR and comment \`/claim #<pr_number>\`\n`;
      } else if (communityBounty.status === 'claimed') {
        statusMsg += `- **Claimed by:** @${communityBounty.claimedByGithubUsername}\n`;
        statusMsg += `- **PR:** #${communityBounty.claimedPrNumber}\n`;
        statusMsg += `- ⏳ Payout in progress...\n`;
      } else if (communityBounty.status === 'completed') {
        statusMsg += `- **Paid to:** @${communityBounty.claimedByGithubUsername}\n`;
        statusMsg += `- **PR:** #${communityBounty.claimedPrNumber}\n`;
        statusMsg += `- 💰 Completed!\n`;
      }

      statusMsg += `\n🔗 [View Details](https://app.roxonn.com/bounties/${communityBounty.id})\n`;
    }

    if (poolBountyStatus && registration) {
      statusMsg += `\n**Pool Bounty:** ${poolBountyStatus}\n`;
      statusMsg += `🔗 [View on Roxonn](https://app.roxonn.com/repos/${owner}/${repo})\n`;
    }

    if (!communityBounty && !poolBountyStatus) {
      statusMsg += `No active bounties found for this issue.\n\n`;
      statusMsg += `**Want to create one?**\n`;
      statusMsg += `- Comment \`/bounty <amount> <currency>\` for a community bounty\n`;
      if (registration) {
        statusMsg += `- Or ask a pool manager to allocate from the repository pool\n`;
      }
    }

    statusMsg += `\n---\n<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;

    await postGitHubComment(installationId, owner, repo, issueNumber, statusMsg);
    log(`Status check completed for issue #${issueNumber}`, 'bounty-command');

  // =========================================================================
  // COMMAND TYPE: request (EXISTING BOUNTY REQUEST - PRESERVED)
  // =========================================================================
  // WHY: Contributors can request pool managers to allocate bounties
  // REQUIRES: Repository must be registered
  } else if (command.type === 'request') {
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
- Comment \`/bounty pool <amount> <currency>\` to allocate from pool
- Or visit [Roxonn Dashboard](https://app.roxonn.com/repos/${owner}/${repo})

**Tip:** You can also create a community bounty yourself:
- Comment \`/bounty <amount> <currency>\` to fund it directly

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`;
    await postGitHubComment(installationId, owner, repo, issueNumber, requestMsg);
    log(`Bounty request created by ${commenter} for issue #${issueNumber}`, 'bounty-command');
  }
}

// =========================================================================
// WELCOME COMMENT TEMPLATE
// =========================================================================

/**
 * Generate the welcome comment posted to every new issue
 * This comment includes:
 * - How to create bounties
 * - How developers can claim bounties
 * - Commands reference
 * - Attempt tracker table (updated dynamically)
 */
function generateWelcomeComment(): string {
  return `## 💰 Add a Roxonn Bounty to this Issue

Turn this issue into a paid bounty and attract top developers!

---

### 🚀 How It Works

**For Bounty Creators (Clients):**
1. **Add bounty**: Comment \`/bounty <amount> <currency>\` (e.g., \`/bounty 100 USDC\`)
2. **Pay to escrow**: We'll reply with payment link (crypto or fiat)
3. **Auto-payout**: When PR merges, developer gets paid automatically!

**For Developers (Contributors):**
1. **Signal intent**: Comment \`/attempt\` to show you're working on it (optional)
2. **Submit PR**: Create PR with \`fixes #[issue-number]\` in description
3. **Get paid**: PR merges → Instant payout to your wallet! 💸

---

### ⌨️ Commands

| Command | Who | What it does |
|---------|-----|--------------|
| \`/bounty <amount> <currency>\` | Clients | Create bounty (e.g., \`/bounty 50 XDC\`) |
| \`/attempt\` | Developers | Signal you're working on this |
| \`@roxonn status\` | Anyone | Check bounty status |

**Supported currencies:** XDC, ROXN, USDC

---

### ❓ FAQ

**Q: How much does it cost?**
A: 5% total platform fee (2.5% from client, 2.5% from developer). Lowest in the industry!

**Q: When do developers get paid?**
A: Automatically within 60 seconds after PR merge. No manual claim needed.

**Q: Can I use crypto or fiat?**
A: Both! Pay with crypto wallet OR credit card via Onramp.money.

**Q: What if multiple people attempt?**
A: First merged PR wins the bounty. Coordinate in comments to avoid duplicate work.

---

### ✅ Requirements for Valid Submission

- PR must reference this issue: \`fixes #[issue-number]\` in PR description
- PR must be merged (not just closed)
- Developer must have XDC wallet linked to Roxonn account
- Code must meet acceptance criteria listed in issue description

---

### 💡 Tips for Bounty Creators

**Make your bounty attractive:**
- ✅ Clear description of what needs to be done
- ✅ Acceptance criteria (how you'll evaluate submissions)
- ✅ Relevant skills needed (React, Python, etc.)
- ✅ Links to related files/docs
- ✅ Fair pricing (check similar bounties at [roxonn.com/explore](https://roxonn.com/explore))

**Suggested bounty amounts:**
- 🐛 Simple bug fix: 10-50 USDC
- ✨ Small feature: 50-200 USDC
- 🚀 Complex feature: 200-1000+ USDC

---

### 📊 Who's Working on This?

| Developer | Started | Status |
|-----------|---------|--------|
| _No attempts yet_ | - | - |

---

### 📚 New to Roxonn?

- **Tutorial**: [Getting Started Guide](https://roxonn.com/docs/getting-started)
- **Install Extension**: [Easy Bounty Creation Tool](https://roxonn.com/extension)
- **Browse Bounties**: [Explore Active Bounties](https://roxonn.com/explore)
- **Need Help?**: [Discord](https://discord.gg/roxonn) | [Docs](https://roxonn.com/docs)

---

_Posted by Roxonn Bot • [What is this?](https://roxonn.com/docs/bot)_`;
}

/**
 * Format relative time for display
 */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

// =========================================================================
// ISSUE OPENED HANDLER - Post Welcome Comment
// =========================================================================

/**
 * Handler for issues.opened webhook event
 * Posts the welcome comment to every new issue in repos with Roxonn GitHub App installed
 */
export async function handleIssueOpened(
  payload: any,
  installationId: string
): Promise<void> {
  log(`[handleIssueOpened] Processing new issue`, 'welcome-comment');

  const issue = payload.issue;
  const repository = payload.repository;

  if (!issue || !repository) {
    log('Missing required payload fields for issue opened', 'welcome-comment-ERROR');
    return;
  }

  const repoFullName = repository.full_name;
  const issueNumber = issue.number;

  // SSRF Protection
  const [owner, repo] = (repoFullName || '').split('/');
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid repo format: ${repoFullName}`, 'welcome-comment-ERROR');
    return;
  }

  try {
    // Get installation token
    const installationToken = await getInstallationAccessToken(installationId);
    if (!installationToken) {
      log(`Could not get installation token for welcome comment`, 'welcome-comment-ERROR');
      return;
    }

    // Post welcome comment
    const welcomeBody = generateWelcomeComment();
    const apiHeaders = getGitHubApiHeaders(installationToken);
    const commentUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/{issueNumber}/comments', {
      owner,
      repo,
      issueNumber: String(issueNumber),
    });

    const response = await axios.post(commentUrl, { body: welcomeBody }, { headers: apiHeaders });
    const commentId = response.data.id;

    log(`Posted welcome comment on ${owner}/${repo}#${issueNumber}, comment ID: ${commentId}`, 'welcome-comment');

    // Store comment reference for later updates
    await storage.createIssueComment({
      githubRepoOwner: owner,
      githubRepoName: repo,
      githubIssueNumber: issueNumber,
      githubCommentId: String(commentId),
      commentType: 'welcome',
      installationId,
    });

    log(`Welcome comment stored for ${owner}/${repo}#${issueNumber}`, 'welcome-comment');

  } catch (error: any) {
    log(`Error posting welcome comment: ${error.message}`, 'welcome-comment-ERROR');
    throw error;
  }
}

// =========================================================================
// ATTEMPT COMMAND HANDLER
// =========================================================================

/**
 * Handler for /attempt command
 * Records that a user is working on a bounty and updates the attempt tracker
 */
export async function handleAttemptCommand(
  payload: any,
  installationId: string
): Promise<void> {
  log(`[handleAttemptCommand] Processing /attempt command`, 'attempt');

  const comment = payload.comment;
  const issue = payload.issue;
  const repository = payload.repository;
  const sender = payload.sender;

  if (!comment || !issue || !repository || !sender) {
    log('Missing required payload fields for attempt command', 'attempt-ERROR');
    return;
  }

  const repoFullName = repository.full_name;
  const issueNumber = issue.number;
  const commenter = sender.login;

  // SSRF Protection
  const [owner, repo] = (repoFullName || '').split('/');
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid repo format: ${repoFullName}`, 'attempt-ERROR');
    return;
  }

  try {
    // Check if user is already attempting this issue
    const existingAttempt = await storage.getActiveAttemptByUserAndIssue(
      commenter, owner, repo, issueNumber
    );

    if (existingAttempt) {
      // User already has an active attempt
      const timeAgo = formatTimeAgo(existingAttempt.startedAt);
      await postGitHubComment(installationId, owner, repo, issueNumber,
        `@${commenter} You're already working on this issue (started ${timeAgo}).

Keep going! 💪 When you're ready, submit a PR with \`fixes #${issueNumber}\` in the description.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`
      );
      return;
    }

    // Get user from database (optional - attempt works for unregistered users too)
    const user = await storage.getUserByGithubUsername(commenter);

    // Get bounty for this issue (optional - attempt works before bounty exists)
    const bounty = await storage.getCommunityBountyByIssue(owner, repo, issueNumber);

    // Create the attempt
    await storage.createBountyAttempt({
      bountyId: bounty?.id,
      userId: user?.id,
      githubUsername: commenter,
      githubRepoOwner: owner,
      githubRepoName: repo,
      githubIssueNumber: issueNumber,
    });

    // Post confirmation comment
    await postGitHubComment(installationId, owner, repo, issueNumber,
      `👤 @${commenter} is now working on this ${bounty ? 'bounty' : 'issue'}!

**Started:** ${new Date().toUTCString()}
${bounty ? `**Bounty:** ${bounty.amount} ${bounty.currency}` : ''}

**Next steps:**
1. Create a Pull Request when ready
2. Include \`fixes #${issueNumber}\` in PR description
${bounty ? `3. Bounty will be paid automatically when PR merges!` : '3. Add a bounty to this issue: `/bounty <amount> <currency>`'}

_Other contributors: Please coordinate in comments or work on different issues._

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`
    );

    // Update the welcome comment's attempt tracker table
    await updateAttemptTrackerInWelcomeComment(owner, repo, issueNumber, installationId);

    log(`Attempt recorded for ${commenter} on ${owner}/${repo}#${issueNumber}`, 'attempt');

  } catch (error: any) {
    if (error.message?.includes('already have an active attempt')) {
      log(`${commenter} already has active attempt on issue #${issueNumber}`, 'attempt');
      return;
    }
    log(`Error handling attempt command: ${error.message}`, 'attempt-ERROR');
    throw error;
  }
}

/**
 * Update the attempt tracker table in the welcome comment
 */
async function updateAttemptTrackerInWelcomeComment(
  owner: string,
  repo: string,
  issueNumber: number,
  installationId: string
): Promise<void> {
  try {
    // Get the welcome comment reference
    const welcomeComment = await storage.getWelcomeComment(owner, repo, issueNumber);
    if (!welcomeComment) {
      log(`No welcome comment found for ${owner}/${repo}#${issueNumber}`, 'attempt-tracker');
      return;
    }

    // Get all active attempts for this issue
    const attempts = await storage.getActiveAttemptsByIssue(owner, repo, issueNumber);

    // Build the new table rows
    let tableRows: string;
    if (attempts.length === 0) {
      tableRows = '| _No attempts yet_ | - | - |';
    } else {
      tableRows = attempts.map(attempt =>
        `| @${attempt.githubUsername} | ${formatTimeAgo(attempt.startedAt)} | 🔨 Working |`
      ).join('\n');
    }

    // Get installation token
    const installationToken = await getInstallationAccessToken(installationId);
    if (!installationToken) {
      log(`Could not get installation token for updating attempt tracker`, 'attempt-tracker-ERROR');
      return;
    }

    const apiHeaders = getGitHubApiHeaders(installationToken);

    // Get current comment body
    const getCommentUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/comments/{commentId}', {
      owner,
      repo,
      commentId: welcomeComment.githubCommentId,
    });

    const commentResponse = await axios.get(getCommentUrl, { headers: apiHeaders });
    const currentBody = commentResponse.data.body;

    // Replace the attempt tracker table in the comment body
    const tablePattern = /### 📊 Who's Working on This\?\n\n\| Developer \| Started \| Status \|\n\|[-]+\|[-]+\|[-]+\|\n([\s\S]*?)(?=\n---|\n###|$)/;
    const newTableSection = `### 📊 Who's Working on This?\n\n| Developer | Started | Status |\n|-----------|---------|--------|\n${tableRows}`;

    const updatedBody = currentBody.replace(tablePattern, newTableSection);

    // Update the comment
    const updateCommentUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues/comments/{commentId}', {
      owner,
      repo,
      commentId: welcomeComment.githubCommentId,
    });

    await axios.patch(updateCommentUrl, { body: updatedBody }, { headers: apiHeaders });

    log(`Updated attempt tracker for ${owner}/${repo}#${issueNumber}`, 'attempt-tracker');

  } catch (error: any) {
    log(`Error updating attempt tracker: ${error.message}`, 'attempt-tracker-ERROR');
    // Don't throw - this is a non-critical update
  }
}

// =========================================================================
// AUTO-PAYOUT ON PR MERGE HANDLER
// =========================================================================

/**
 * Handler for pull_request.closed (merged=true) webhook event
 * Automatically pays out community bounties when PR is merged
 */
export async function handlePullRequestMergedForAutoPayout(
  payload: any,
  installationId: string
): Promise<void> {
  log(`[handlePullRequestMergedForAutoPayout] Processing merged PR`, 'auto-payout');

  const pr = payload.pull_request;
  const repository = payload.repository;

  if (!pr || !pr.merged || !repository) {
    log('PR not merged or missing required fields', 'auto-payout');
    return;
  }

  const repoFullName = repository.full_name;
  const prNumber = pr.number;
  const prAuthor = pr.user?.login;
  const prBody = pr.body || '';
  const prUrl = pr.html_url;

  // SSRF Protection
  const [owner, repo] = (repoFullName || '').split('/');
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    log(`Invalid repo format: ${repoFullName}`, 'auto-payout-ERROR');
    return;
  }

  log(`Processing merged PR #${prNumber} by ${prAuthor} in ${owner}/${repo}`, 'auto-payout');

  // Extract issue numbers from PR body
  const issueNumbers = extractIssueNumbers(prBody);
  if (issueNumbers.length === 0) {
    log(`No issue numbers found in PR #${prNumber} body`, 'auto-payout');
    return;
  }

  log(`Found linked issues: ${issueNumbers.join(', ')}`, 'auto-payout');

  // Process each linked issue
  for (const issueNumber of issueNumbers) {
    try {
      // Check for community bounty on this issue
      const bounty = await storage.getCommunityBountyByIssue(owner, repo, issueNumber);

      if (!bounty) {
        log(`No community bounty for issue #${issueNumber}`, 'auto-payout');
        continue;
      }

      if (bounty.status !== 'funded') {
        log(`Bounty for issue #${issueNumber} is ${bounty.status}, not funded`, 'auto-payout');
        continue;
      }

      log(`Found funded bounty: ${bounty.amount} ${bounty.currency} for issue #${issueNumber}`, 'auto-payout');

      // Get the contributor (PR author)
      const contributor = await storage.getUserByGithubUsername(prAuthor);

      if (!contributor) {
        // Post comment asking user to sign up
        await postGitHubComment(installationId, owner, repo, issueNumber,
          `⚠️ **Bounty Payout Pending**

@${prAuthor} Your PR #${prNumber} was merged! 🎉

However, you need to sign up on Roxonn to receive the bounty payment.

**Steps to claim your bounty:**
1. Go to [roxonn.com](https://roxonn.com) and sign up with GitHub
2. Connect or create an XDC wallet in settings
3. Your bounty will be sent automatically!

**Bounty:** ${bounty.amount} ${bounty.currency}

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`
        );

        // Mark bounty as pending claim
        await storage.updateCommunityBounty(bounty.id, {
          status: 'claimed',
          claimedByGithubUsername: prAuthor,
          claimedPrNumber: prNumber,
          claimedPrUrl: prUrl,
          claimedAt: new Date(),
        });

        log(`Bounty for issue #${issueNumber} pending - contributor ${prAuthor} not registered`, 'auto-payout');
        continue;
      }

      if (!contributor.xdcWalletAddress) {
        // Post comment asking user to add wallet
        await postGitHubComment(installationId, owner, repo, issueNumber,
          `⚠️ **Bounty Payout Pending**

@${prAuthor} Your PR #${prNumber} was merged! 🎉

However, you need to connect an XDC wallet to receive the bounty payment.

**Steps to claim your bounty:**
1. Go to [roxonn.com/settings/wallet](https://roxonn.com/settings/wallet)
2. Connect or create an XDC wallet
3. Your bounty will be sent automatically!

**Bounty:** ${bounty.amount} ${bounty.currency}

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`
        );

        // Mark bounty as pending claim
        await storage.updateCommunityBounty(bounty.id, {
          status: 'claimed',
          claimedByUserId: contributor.id,
          claimedByGithubUsername: prAuthor,
          claimedPrNumber: prNumber,
          claimedPrUrl: prUrl,
          claimedAt: new Date(),
        });

        log(`Bounty for issue #${issueNumber} pending - contributor ${prAuthor} has no wallet`, 'auto-payout');
        continue;
      }

      // Execute the payout via relayer (mark as claimed, relayer will complete)
      // Using atomic claim to prevent race conditions
      try {
        await storage.claimCommunityBountyAtomic(
          bounty.id,
          contributor.id,
          prAuthor,
          prNumber,
          prUrl
        );

        log(`Bounty ${bounty.id} claimed atomically, relayer will complete payout`, 'auto-payout');

        // Post success comment (payout will be completed by relayer)
        await postGitHubComment(installationId, owner, repo, issueNumber,
          `✅ **Bounty Claimed Successfully!**

@${prAuthor} Your PR #${prNumber} was merged and bounty claim is being processed! 🎉

**Payout Details:**
- **Bounty:** ${bounty.amount} ${bounty.currency}
- **Net Payout:** ${(parseFloat(bounty.amount) * 0.975).toFixed(4)} ${bounty.currency} (2.5% platform fee)
- **Recipient:** \`${contributor.xdcWalletAddress.slice(0, 10)}...${contributor.xdcWalletAddress.slice(-6)}\`

⏳ Payout will be processed within 60 seconds by our relayer.

---
<sub>Powered by [Roxonn](https://app.roxonn.com)</sub>`
        );

        // Update attempt status to completed
        await storage.completeAttemptByPR(prAuthor, owner, repo, issueNumber, prNumber, prUrl);

      } catch (claimError: any) {
        if (claimError.message?.includes('not claimable')) {
          log(`Bounty ${bounty.id} already claimed or not claimable`, 'auto-payout');
        } else {
          throw claimError;
        }
      }

    } catch (error: any) {
      log(`Error processing auto-payout for issue #${issueNumber}: ${error.message}`, 'auto-payout-ERROR');
      // Continue to next issue
    }
  }

  log(`Finished processing auto-payout for PR #${prNumber}`, 'auto-payout');
}

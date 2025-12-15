import { Router, Request, Response } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { blockchain } from '../blockchain';
import { config } from '../config';
import { log } from '../utils';
import { storage } from '../storage';
import axios from 'axios';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { registeredRepositories } from '../../shared/schema';
import {
  getOrgRepos,
  getRepoDetails,
  verifyUserIsOrgAdmin,
  getUserAdminOrgs,
  getOrgReposForRegistration,
  getUserAdminRepos,
  getInstallationAccessToken,
  getGitHubApiHeaders,
  GITHUB_API_BASE,
  findAppInstallationByName,
  isValidGitHubOwner,
  isValidGitHubRepo,
  buildSafeGitHubUrl,
} from '../github';
import { securityMiddlewares } from '../security/middlewares';

const router = Router();

/**
 * @openapi
 * /api/github/repos:
 *   get:
 *     summary: Get GitHub repositories
 *     tags: [Repositories]
 *     responses:
 *       200:
 *         description: List of repositories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get(
  '/github/repos',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  getOrgRepos
);

/**
 * @openapi
 * /api/github/repos/{owner}/{name}:
 *   get:
 *     summary: Get GitHub repository details
 *     tags: [Repositories]
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Repository details
 *         content:
 *           application/json:
 *             schema: { type: object }
 */
router.get(
  '/github/repos/:owner/:name',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  getRepoDetails
);

/**
 * @openapi
 * /api/github/user/repos:
 *   get:
 *     summary: Get repositories where authenticated user is admin
 *     tags: [Repositories]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of admin repositories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/github/user/repos',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  getUserAdminRepos
);

// Get GitHub organizations where user is an admin
router.get(
  '/github/user/orgs',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    if (!req.user?.githubAccessToken) {
      return res.status(401).json({ error: 'GitHub authentication required' });
    }
    try {
      const orgs = await getUserAdminOrgs(req.user.githubAccessToken);
      res.json({ orgs });
    } catch (error: any) {
      log(`Error fetching user admin orgs: ${error.message}`, 'routes-ERROR');
      res.status(500).json({ error: 'Failed to fetch organizations' });
    }
  }
);

// Get repositories from a GitHub organization (for registration)
router.get(
  '/github/orgs/:org/repos',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    if (!req.user?.githubAccessToken) {
      return res.status(401).json({ error: 'GitHub authentication required' });
    }

    const { org } = req.params;
    if (!org) {
      return res.status(400).json({ error: 'Organization name required' });
    }

    try {
      // Verify user is an admin of this org
      const isOrgAdmin = await verifyUserIsOrgAdmin(req.user.githubAccessToken, org);
      if (!isOrgAdmin) {
        return res.status(403).json({ error: 'You must be an admin of this organization' });
      }

      // Get repos from the org
      const repos = await getOrgReposForRegistration(req.user.githubAccessToken, org);

      // Get already registered repos to mark them
      const registeredRepos = await storage.getAllRegisteredRepositories();
      const registeredRepoIds = new Set(registeredRepos.map(r => r.githubRepoId));

      // Mark repos that are already registered
      const reposWithStatus = repos.map(repo => ({
        ...repo,
        isRegistered: registeredRepoIds.has(String(repo.id))
      }));

      res.json({ repos: reposWithStatus });
    } catch (error: any) {
      log(`Error fetching org repos for ${org}: ${error.message}`, 'routes-ERROR');
      res.status(500).json({ error: 'Failed to fetch organization repositories' });
    }
  }
);

// Partner API for verifying user registrations
/**
 * @openapi
 * /api/partners/verify-registration:
 *   get:
 *     summary: Verify user registration (Partner API)
 *     tags: [Partners]
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *       - in: query
 *         name: githubId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Verification result
 *       401:
 *         description: Unauthorized
 */
router.get('/partners/verify-registration', async (req: Request, res: Response) => {
  try {
    const { username, githubId } = req.query;
    // API key should be in header, not query parameter (prevents logging exposure)
    const apiKey = req.headers['x-api-key'] as string;

    // Check for API key (should match the one configured in env variables)
    if (!apiKey || apiKey !== config.partnerApiKey) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized - Invalid or missing API key in X-API-Key header"
      });
    }

    // Check if at least one identifier is provided
    if (!username && !githubId) {
      return res.status(400).json({
        success: false,
        error: "At least one user identifier (username or githubId) is required"
      });
    }

    // Look up user by either GitHub ID or username
    let user = null;
    if (githubId) {
      user = await storage.getUserByGithubId(githubId.toString());
    }

    if (!user && username) {
      user = await storage.getUserByUsername(username.toString());
    }

    // If user not found, return appropriate response
    if (!user) {
      return res.status(404).json({
        success: false,
        verified: false,
        message: "User not found"
      });
    }

    // Check if user has completed registration (wallet setup)
    const isRegistered = !!user.isProfileComplete && !!user.xdcWalletAddress;

    res.json({
      success: true,
      verified: isRegistered,
      message: isRegistered ? "User is registered" : "User exists but has not completed registration",
      timestamp: new Date().toISOString(),
      // Include minimal user info that's safe to share with partners
      user: isRegistered ? {
        username: user.username,
        githubId: user.githubId,
        registrationDate: user.createdAt,
        hasWallet: !!user.xdcWalletAddress
      } : null
    });
  } catch (error: any) {
    log(`Error in partner verification API: ${error.message}`, 'partner-api-ERROR');
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: "Failed to verify user registration"
    });
  }
});

// --- Repository Registration Routes ---
/**
 * @openapi
 * /api/repositories/register:
 *   post:
 *     summary: Register a repository
 *     tags: [Repositories]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - githubRepoId
 *               - githubRepoFullName
 *             properties:
 *               githubRepoId:
 *                 type: string
 *               githubRepoFullName:
 *                 type: string
 *               installationId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Repository registered successfully
 *       400:
 *         description: Invalid input or missing installation
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/repositories/register',
  requireAuth,
  csrfProtection,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  securityMiddlewares.sanitizeRepoPayload,
  securityMiddlewares.validateRepoPayload,
  async (req: Request, res: Response) => {
    // Input validation (basic)
    const { githubRepoId, githubRepoFullName, installationId } = req.body;
    if (!githubRepoId || !githubRepoFullName) {
      return res.status(400).json({ error: 'Missing repository ID or name' });
    }

    // SSRF Protection: Validate repository name format
    const [repoOwnerFromName, repoNameFromName] = (githubRepoFullName || '').split('/');
    if (!isValidGitHubOwner(repoOwnerFromName) || !isValidGitHubRepo(repoNameFromName)) {
      return res.status(400).json({ error: 'Invalid repository name format' });
    }

    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      // Check if already registered by this user
      const existing = await storage.findRegisteredRepository(req.user.id, githubRepoId);
      if (existing) {
        return res.status(200).json({ message: 'Repository already registered by you.', registration: existing });
      }

      // Check if this is an org repo (owner !== user's username)
      const [repoOwner] = githubRepoFullName.split('/');
      if (repoOwner && repoOwner.toLowerCase() !== req.user.username.toLowerCase()) {
        // This is likely an org repo - verify user is org admin
        log(`Org repo detected: ${githubRepoFullName}, verifying org admin status for ${req.user.username}`, 'routes');

        if (!req.user.githubAccessToken) {
          return res.status(401).json({ error: 'GitHub authentication required for org repository registration' });
        }

        const isOrgAdmin = await verifyUserIsOrgAdmin(req.user.githubAccessToken, repoOwner);
        if (!isOrgAdmin) {
          log(`User ${req.user.username} is not an admin of org ${repoOwner}`, 'routes');
          return res.status(403).json({
            error: 'You must be an admin of this organization to register its repositories',
            orgName: repoOwner
          });
        }
        log(`User ${req.user.username} verified as admin of org ${repoOwner}`, 'routes');
      }

      // If installation ID is provided directly from frontend (after GitHub App installation)
      if (installationId) {
        log(`Using provided installation ID ${installationId} for ${githubRepoFullName}`, 'routes');

        // Fetch repository details to check if it's private
        const [owner, repo] = githubRepoFullName.split('/');
        let isPrivate = false;
        try {
          const userToken = (req.user as any).hasPrivateRepoAccess && (req.user as any).githubPrivateAccessToken
            ? (req.user as any).githubPrivateAccessToken
            : req.user.githubAccessToken;

          const repoDetails = await axios.get(
            buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner: repoOwnerFromName, repo: repoNameFromName }),
            {
              headers: {
                Authorization: `token ${userToken}`,
                Accept: 'application/vnd.github.v3+json'
              }
            }
          );
          isPrivate = repoDetails.data.private || false;
          log(`Repository ${githubRepoFullName} is ${isPrivate ? 'private' : 'public'}`, 'routes');
        } catch (error) {
          log(`Could not fetch repository details for ${githubRepoFullName}, defaulting to public`, 'routes');
        }

        // Register the repository with the provided installation ID
        const result = await storage.registerRepositoryDirectly(
          req.user.id,
          githubRepoId,
          githubRepoFullName,
          installationId,
          isPrivate
        );

        return res.status(201).json({
          success: true,
          message: 'Repository registered successfully with provided installation ID',
          repoId: githubRepoId
        });
      }

      // Extract owner and repo from the full name
      const [owner, repo] = githubRepoFullName.split('/');
      if (!owner || !repo) {
        return res.status(400).json({ error: 'Invalid repository name format' });
      }

      // Check for GitHub App installation
      try {
        // First try repository-specific installation
        try {
          const repoResponse = await axios.get(
            buildSafeGitHubUrl('/repos/{owner}/{repo}/installation', { owner, repo }),
            {
              headers: {
                Authorization: `token ${req.user.githubAccessToken}`,
                Accept: 'application/vnd.github.v3+json'
              }
            }
          );

          // If we got here, app is installed for this specific repo
          const installationId = repoResponse.data.id.toString();
          log(`GitHub App installed for ${githubRepoFullName}, installation ID: ${installationId}`, 'routes');

          // Fetch repository details to check if it's private
          let isPrivate = false;
          try {
            const userToken = (req.user as any).hasPrivateRepoAccess && (req.user as any).githubPrivateAccessToken
              ? (req.user as any).githubPrivateAccessToken
              : req.user.githubAccessToken;

            const repoDetails = await axios.get(
              buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner, repo }),
              {
                headers: {
                  Authorization: `token ${userToken}`,
                  Accept: 'application/vnd.github.v3+json'
                }
              }
            );
            isPrivate = repoDetails.data.private || false;
          } catch (error) {
            log(`Could not fetch repository details for ${githubRepoFullName}`, 'routes');
          }

          // Register the repository with the installation ID
          const result = await storage.registerRepositoryDirectly(
            req.user.id,
            githubRepoId,
            githubRepoFullName,
            installationId,
            isPrivate
          );

          // Return success
          return res.status(201).json({
            success: true,
            message: 'Repository registered successfully',
            repoId: githubRepoId
          });
        } catch (repoError) {
          // Repository-specific installation not found, check user installations
          log(`Repository-specific installation not found for ${githubRepoFullName}, checking user installations`, 'routes');

          try {
            // Check if the app is installed for the user/organization (this endpoint is user-specific, not repository)
            const userInstallationsResponse = await axios.get(
              `${GITHUB_API_BASE}/user/installations`,
              {
                headers: {
                  Authorization: `token ${req.user.githubAccessToken}`,
                  Accept: 'application/vnd.github.v3+json'
                }
              }
            );

            // Log the raw response for debugging
            log(`User installations raw response: ${JSON.stringify(userInstallationsResponse.data)}`, 'routes');

            // Extract installations more safely
            const installations = userInstallationsResponse.data &&
              userInstallationsResponse.data.installations ?
              userInstallationsResponse.data.installations : [];

            log(`Found ${installations.length} installations for user`, 'routes');

            // Log each installation in detail
            if (installations.length > 0) {
              installations.forEach((inst: any, idx: number) => {
                const slug = inst.app_slug || 'unknown';
                const id = inst.id || 'unknown';
                const name = inst.app_name || 'N/A';
                log(`Installation ${idx}: app_slug="${slug}", id=${id}, app_name="${name}"`, 'routes');
              });
            }

            // Use the new helper function to find our app installation by name
            const matchingInstallation = await findAppInstallationByName(installations);

            if (matchingInstallation) {
              // App is installed at the user/org level
              const installationId = matchingInstallation.id.toString();
              log(`GitHub App found via user installations, ID: ${installationId}`, 'routes');

              // Fetch repository details to check if it's private
              let isPrivate = false;
              try {
                const userToken = (req.user as any).hasPrivateRepoAccess && (req.user as any).githubPrivateAccessToken
                  ? (req.user as any).githubPrivateAccessToken
                  : req.user.githubAccessToken;

                const repoDetails = await axios.get(
                  buildSafeGitHubUrl('/repos/{owner}/{repo}', { owner: repoOwnerFromName, repo: repoNameFromName }),
                  {
                    headers: {
                      Authorization: `token ${userToken}`,
                      Accept: 'application/vnd.github.v3+json'
                    }
                  }
                );
                isPrivate = repoDetails.data.private || false;
              } catch (error) {
                log(`Could not fetch repository details for ${githubRepoFullName}`, 'routes');
              }

              // Register the repository with the installation ID
              const result = await storage.registerRepositoryDirectly(
                req.user.id,
                githubRepoId,
                githubRepoFullName,
                installationId,
                isPrivate
              );

              // Return success
              return res.status(201).json({
                success: true,
                message: 'Repository registered successfully via user installation',
                repoId: githubRepoId
              });
            }
          } catch (userInstallError: any) {
            log(`Error checking user installations: ${userInstallError.message || userInstallError}`, 'routes');
            // Continue to the redirect flow below
          }

          // If we got here, the app is not installed for the user or the repo
          throw new Error("GitHub App not installed for user or repository");
        }
      } catch (error) {
        // GitHub App not installed
        log(`GitHub App not installed for ${githubRepoFullName}, redirecting to installation`, 'routes');

        return res.status(400).json({
          success: false,
          error: "GitHub App not installed",
          // Use the config variable for the app name
          installUrl: `https://github.com/apps/${config.githubAppName}/installations/new?state=${githubRepoId}`
        });
      }
    } catch (error) {
      log(`Error registering repository: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to register repository' });
    }
  }
);

/**
 * @openapi
 * /api/repositories/registered:
 *   get:
 *     summary: Get repositories registered by current user
 *     tags: [Repositories]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of registered repositories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 repositories:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Repository'
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/repositories/registered',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    try {
      const registrations = await storage.getRegisteredRepositoriesByUser(req.user.id);
      res.json({ repositories: registrations });
    } catch (error) {
      log(`Error fetching registered repositories: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch registered repositories' });
    }
  }
);

// Toggle repository active status (pool manager only)
router.patch(
  '/repositories/:repoId/active',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { repoId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    try {
      // Verify user owns this repository
      const repo = await storage.findRegisteredRepositoryByGithubId(repoId);
      if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
      }

      if (repo.userId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to modify this repository' });
      }

      const updated = await storage.updateRepositoryActiveStatus(repoId, isActive);
      if (updated) {
        log(`Repository ${repoId} active status set to ${isActive} by user ${req.user.id}`, 'routes');
        res.json({ success: true, isActive });
      } else {
        res.status(500).json({ error: 'Failed to update repository' });
      }
    } catch (error) {
      log(`Error updating repository active status: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to update repository active status' });
    }
  }
);

/**
 * @openapi
 * /api/repositories/accessible:
 *   get:
 *     summary: Get all repositories accessible to current user
 *     tags: [Repositories]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of accessible repositories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 repositories:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Repository'
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/repositories/accessible',
  requireAuth,
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    try {
      // Get all registered repos (both public and private)
      const allRegisteredRepos = await storage.getAllRegisteredRepositories();
      const username = req.user.username;

      // Check access for each repo
      const accessibleRepos = await Promise.all(
        allRegisteredRepos.map(async (repo) => {
          // Public repos are always accessible
          if (!repo.isPrivate) {
            return repo;
          }

          // For private repos, check if user is a collaborator using GitHub App installation token
          try {
            const installationToken = await getInstallationAccessToken(repo.installationId);
            if (!installationToken) {
              log(`Could not get installation token for private repo ${repo.githubRepoFullName}`, 'routes');
              return null;
            }

            // Check if user is a collaborator on this private repo
            const collaboratorCheckUrl = `https://api.github.com/repos/${repo.githubRepoFullName}/collaborators/${username}`;
            const response = await axios.get(collaboratorCheckUrl, {
              headers: {
                Authorization: `token ${installationToken}`,
                Accept: 'application/vnd.github.v3+json'
              },
              validateStatus: (status) => status === 204 || status === 404 // 204 = is collaborator, 404 = not collaborator
            });

            // If user is a collaborator, include the repo
            if (response.status === 204) {
              log(`User ${username} is collaborator on private repo ${repo.githubRepoFullName}`, 'routes');
              return repo;
            }

            return null; // User is not a collaborator
          } catch (error: any) {
            log(`Error checking collaborator status for ${repo.githubRepoFullName}: ${error.message}`, 'routes-ERROR');
            return null; // On error, don't show private repo
          }
        })
      );

      // Filter out null values (repos user doesn't have access to)
      const filteredRepos = accessibleRepos.filter(repo => repo !== null);

      // Fetch pool info from blockchain for each accessible repo
      const repositoriesWithPoolInfo = await Promise.all(
        filteredRepos.map(async (repo) => {
          try {
            const poolInfo = await blockchain.getRepository(parseInt(repo.githubRepoId));
            return {
              ...repo,
              xdcPoolRewards: poolInfo?.xdcPoolRewards || "0.0",
              roxnPoolRewards: poolInfo?.roxnPoolRewards || "0.0",
              usdcPoolRewards: poolInfo?.usdcPoolRewards || "0.0",
              poolInfoError: null, // Indicate successful fetch
            };
          } catch (err: any) {
            log(`Error fetching pool info for repo ${repo.githubRepoId}: ${err.message}`, 'routes-ERROR');
            return {
              ...repo,
              xdcPoolRewards: "0.0",
              roxnPoolRewards: "0.0",
              usdcPoolRewards: "0.0",
              poolInfoError: "Unable to fetch pool information. Please try again later.", // Indicate error to user
            };
          }
        })
      );

      const privateCount = repositoriesWithPoolInfo.filter(r => r.isPrivate).length;
      log(`User ${username} (ID: ${req.user.id}) has access to ${repositoriesWithPoolInfo.length} repos (${privateCount} private)`, 'routes');
      res.json({ repositories: repositoriesWithPoolInfo });
    } catch (error) {
      log(`Error fetching accessible repositories: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch accessible repositories' });
    }
  }
);

// Get all publicly visible registered repos, now including their pool balances
router.get(
  '/repositories/public',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (_req: Request, res: Response) => {
    try {
      const registeredRepos = await storage.getAllPublicRepositories();

      const repositoriesWithPoolInfo = await Promise.all(
        registeredRepos.map(async (repo) => {
          try {
            const poolInfo = await blockchain.getRepository(parseInt(repo.githubRepoId)); // Changed getPoolInfo to getRepository
            return {
              ...repo,
              xdcPoolRewards: poolInfo?.xdcPoolRewards || "0.0",
              roxnPoolRewards: poolInfo?.roxnPoolRewards || "0.0",
              poolInfoError: null, // Indicate successful fetch
              // issues array from poolInfo is also available if needed: poolInfo?.issues
            };
          } catch (err: any) {
            log(`Error fetching pool info for repo ${repo.githubRepoId} in /api/repositories/public: ${err.message}`, 'routes-ERROR');
            return {
              ...repo,
              xdcPoolRewards: "0.0",
              roxnPoolRewards: "0.0",
              poolInfoError: "Unable to fetch pool information. Please try again later.", // Indicate error to user
            };
          }
        })
      );

      res.json({ repositories: repositoriesWithPoolInfo });
    } catch (error) {
      log(`Error fetching public repositories: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch public repositories' });
    }
  }
);

// Public API to get repository data by ID
router.get(
  '/public/repositories/:repoId',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;
      const numberId = parseInt(repoId, 10);

      if (isNaN(numberId)) {
        return res.status(400).json({ error: 'Invalid repository ID format' });
      }

      // Check if repository exists and is public
      const repoRegistration = await storage.getPublicRepositoryById(numberId);
      if (!repoRegistration) {
        return res.status(404).json({ error: 'Repository not found or not public' });
      }

      // Get blockchain data without authentication
      const repoData = await blockchain.getRepository(numberId);

      res.json({
        repository: repoData,
        github_info: {
          name: repoRegistration.githubRepoFullName.split('/')[1] || '',
          owner: repoRegistration.githubRepoFullName.split('/')[0] || '',
          full_name: repoRegistration.githubRepoFullName
        }
      });
    } catch (error) {
      log(`Error fetching public repository data: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch repository data' });
    }
  }
);

// Public API to get repository bounties
router.get(
  '/public/repositories/:repoId/bounties',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    try {
      const { repoId } = req.params;
      const numberId = parseInt(repoId, 10);

      if (isNaN(numberId)) {
        return res.status(400).json({ error: 'Invalid repository ID format' });
      }

      // Check if repository exists and is public
      const repoRegistration = await storage.getPublicRepositoryById(numberId);
      if (!repoRegistration) {
        return res.status(404).json({ error: 'Repository not found or not public' });
      }

      // Get repository from blockchain to extract bounties
      const repoData = await blockchain.getRepository(numberId);

      // Extract bounties from repository data
      const bounties = repoData?.issues || [];

      res.json({
        bounties,
        repositoryId: numberId,
        repositoryName: repoRegistration.githubRepoFullName
      });
    } catch (error) {
      log(`Error fetching public repository bounties: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch repository bounties' });
    }
  }
);

// Public API to get GitHub issues with bounty labels
router.get('/public/github/issues', async (req: Request, res: Response) => {
  try {
    const { owner, repo, labels } = req.query;

    // SSRF Protection: Validate owner and repo using centralized validation functions
    if (typeof owner !== 'string' || typeof repo !== 'string') {
      return res.status(400).json({ error: 'Missing owner/repo parameters' });
    }
    if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
      return res.status(400).json({ error: 'Invalid owner/repo format' });
    }

    // Get issues with bounty labels from GitHub API directly
    // Use GitHub App installation token if available
    const fullRepoName = `${owner}/${repo}`;

    // Find the installation for this repository
    const repositoryInfo = await storage.findRepositoryByFullName(fullRepoName);

    // Use safe URL builder to prevent SSRF
    let issuesUrl = buildSafeGitHubUrl('/repos/{owner}/{repo}/issues', { owner, repo });
    let headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json'
    };

    // If we have installation ID, use app auth
    if (repositoryInfo?.installationId) {
      const token = await getInstallationAccessToken(repositoryInfo.installationId);
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Add label filter if provided
    if (labels && typeof labels === 'string') {
      const labelList = labels.split(',').join(',');
      issuesUrl += `?labels=${encodeURIComponent(labelList)}`;
    }

    const response = await axios.get(issuesUrl, { headers });

    // Return the issues
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching GitHub issues with bounty labels:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub issues' });
  }
});

// NEW: Unified public API endpoint that combines all repository data sources
router.get('/public/unified-repo/:owner/:repo', async (req: Request, res: Response) => {
  const { owner, repo } = req.params;

  // Validate owner and repo so they only contain safe GitHub-acceptable characters
  // GitHub username/org: alphanumeric (a-z, 0-9), hyphens (-), max 39 chars
  // Repo name: most allow dot (.), underscore (_), hyphens (-), no slashes, max 100 chars
  const validOwner = /^[a-zA-Z0-9-]{1,39}$/.test(owner);
  const validRepo = /^[\w\-.]{1,100}$/.test(repo);

  if (!owner || !repo || !validOwner || !validRepo) {
    return res.status(400).json({ error: 'Invalid owner or repo name.' });
  }

  const fullRepoName = `${owner}/${repo}`;
  log(`Fetching unified data for ${fullRepoName}`, 'routes');

  try {
    // Step 1: Get GitHub repository data (description, issues, etc.)
    let githubData;
    try {
      // Try to get data using GitHub App installation if available
      const repoInfo = await storage.findRepositoryByFullName(fullRepoName);
      if (repoInfo?.installationId) {
        const token = await getInstallationAccessToken(repoInfo.installationId);
        const headers = {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        };
        const repoResponse = await axios.get(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, { headers });
        githubData = repoResponse.data;
      } else {
        // Fall back to public GitHub API if no installation is found
        const repoResponse = await axios.get(`${GITHUB_API_BASE}/repos/${owner}/${repo}`);
        githubData = repoResponse.data;
      }
    } catch (githubError) {
      console.error('Error fetching GitHub data:', githubError);
      githubData = null;
    }

    // Step 2: Get blockchain data if the repository is registered
    let blockchainData = null;
    let repoId = null;
    try {
      // Check if repository exists in our system
      const registration = await storage.findRepositoryByFullName(fullRepoName);
      if (registration) {
        repoId = registration.githubRepoId;
        blockchainData = await blockchain.getRepository(parseInt(repoId, 10));
      }
    } catch (blockchainError) {
      console.error('Error fetching blockchain data:', blockchainError);
    }

    // Step 3: Get GitHub issues that might have bounties
    let issues = [];
    try {
      // Get issues with or without a token depending on availability
      const repoInfo = await storage.findRepositoryByFullName(fullRepoName);
      let headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json'
      };

      if (repoInfo?.installationId) {
        const token = await getInstallationAccessToken(repoInfo.installationId);
        headers['Authorization'] = `Bearer ${token}`;
      }

      const issuesResponse = await axios.get(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=open`,
        { headers }
      );
      issues = issuesResponse.data;
    } catch (issuesError) {
      console.error('Error fetching GitHub issues:', issuesError);
    }

    // Return the combined data
    res.json({
      github: githubData,
      blockchain: blockchainData,
      issues: issues,
      registered: !!repoId,
      repoId: repoId
    });
  } catch (error) {
    console.error('Error in unified repo endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch repository data' });
  }
});

// NEW: Endpoint to get details for a repo based on owner/name (for URL mapping)
router.get(
  '/repos/details',
  securityMiddlewares.repoRateLimiter,
  securityMiddlewares.securityMonitor,
  async (req: Request, res: Response) => {
    const { owner, repo } = req.query;

    if (!owner || !repo || typeof owner !== 'string' || typeof repo !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid owner/repo query parameters' });
    }

    const fullRepoName = `${owner}/${repo}`;
    log(`Fetching details for ${fullRepoName} via /api/repos/details`, 'routes');

    try {
      // TODO: Need a function in storage like findRegisteredRepositoryByName(owner, repo)
      // Placeholder: Querying directly for now (adjust table/column names if needed)
      const registrations = await db.select()
        .from(registeredRepositories)
        .where(sql`${registeredRepositories.githubRepoFullName} = ${fullRepoName}`)
        .limit(1);

      const registration = registrations[0];

      if (registration) {
        log(`Repository ${fullRepoName} found in Roxonn DB (ID: ${registration.githubRepoId})`, 'routes');
        // Repo is managed on Roxonn
        // TODO: Fetch relevant Roxonn data (pool balance, tasks, managers etc.)
        // This might involve calling blockchain.getRepository(registration.githubRepoId)
        // and potentially other DB lookups.
        const roxonnData = {
          githubRepoId: registration.githubRepoId,
          githubRepoFullName: registration.githubRepoFullName,
          registeredAt: registration.registeredAt, // Fixed: Use registeredAt instead of createdAt
          // Placeholder for actual data
          poolBalance: '0', // Example: await blockchain.getRepositoryPoolBalance(...)
          managers: [], // Example: await storage.getPoolManagers(...)
          tasks: [], // Example: await storage.getOpenTasks(...)
        };
        return res.json({ status: 'managed', data: roxonnData });
      } else {
        log(`Repository ${fullRepoName} not found in Roxonn DB`, 'routes');
        // Repo is not managed on Roxonn
        // TODO: Optionally fetch basic info from GitHub API
        let githubInfo = null;
        try {
          // Example: Reuse existing helper if suitable or create a new one
          // Need to handle auth carefully - maybe unauthenticated or use app token
          // githubInfo = await getBasicRepoInfo(owner, repo); // Hypothetical function
          githubInfo = { name: repo, owner: owner, description: 'Basic info from GitHub (placeholder)', stars: 0 };
        } catch (githubError: any) {
          log(`Failed to fetch basic GitHub info for ${fullRepoName}: ${githubError.message}`, 'routes');
        }
        return res.json({ status: 'not_managed', github_info: githubInfo });
      }
    } catch (error: any) {
      log(`Error fetching repository details for ${fullRepoName}: ${error.message}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch repository details' });
    }
  }
);

// --- GitHub App Routes ---
router.get('/github/app/install-url', requireAuth, (_req: Request, res: Response) => {
  // Construct the installation URL for the GitHub App
  // Use the config variable
  const installUrl = `https://github.com/apps/${config.githubAppName}/installations/new`;
  // Optionally, could add ?target_id=... or ?repository_id=... if needed
  res.json({ installUrl });
});

// NEW: Endpoint called by frontend after user redirects back from GitHub installation
router.post('/github/app/finalize-installation', requireAuth, csrfProtection, async (req: Request, res: Response) => {
  const { installationId } = req.body;
  const userId = req.user!.id; // requireAuth ensures user exists

  if (!installationId || typeof installationId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid installation ID' });
  }
  log(`Finalizing installation ID ${installationId} for user ID ${userId}`, 'github-app');

  try {
    // 1. Get an installation access token
    const token = await getInstallationAccessToken(installationId);
    if (!token) { throw new Error('Could not generate installation token'); }
    const headers = getGitHubApiHeaders(token);

    // 2. Fetch repositories associated with this installation ID from GitHub
    interface InstallationReposResponse {
      total_count: number;
      repositories: any[]; // Use specific type if known, else any[]
    }
    const repoResponse = await axios.get<InstallationReposResponse>(
      `${GITHUB_API_BASE}/installation/repositories`,
      { headers: headers }
    );

    // Check response structure before accessing .repositories
    if (!repoResponse.data || !Array.isArray(repoResponse.data.repositories)) {
      throw new Error('Could not fetch repositories for installation - invalid response structure');
    }

    const repositories = repoResponse.data.repositories;
    log(`Found ${repositories.length} repositories for installation ${installationId}`, 'github-app');

    // 3. Update DB for each repository
    let finalResults = [];
    let successfulAssociations = 0;
    for (const repo of repositories) {
      const githubRepoId = String(repo.id);
      const githubRepoFullName = repo.full_name;
      if (!githubRepoId || !githubRepoFullName) {
        log(`Warning: Skipping repo with missing ID or full name from installation ${installationId}: ${JSON.stringify(repo)}`, 'github-app');
        continue; // Skip this repo
      }

      try {
        // Check if the repository already exists in our DB
        const existingRepo = await storage.findRegisteredRepositoryByGithubId(githubRepoId);

        if (!existingRepo) {
          // Repository doesn't exist, create it first and link to installation
          log(`Repository ${githubRepoFullName} (ID: ${githubRepoId}) not found in DB. Creating...`, 'github-app');
          await storage.addOrUpdateInstallationRepo(installationId, githubRepoId, githubRepoFullName);
          log(`Repository ${githubRepoFullName} created and linked to installation ${installationId}.`, 'github-app');
          // Now associate the user
          await storage.associateUserToInstallationRepo(userId, githubRepoId, installationId);
          log(`User ${userId} associated with new repository ${githubRepoFullName}.`, 'github-app');
        } else {
          // Repository exists, just associate the user (this also updates installation ID)
          log(`Repository ${githubRepoFullName} (ID: ${githubRepoId}) found in DB. Associating user...`, 'github-app');
          await storage.associateUserToInstallationRepo(userId, githubRepoId, installationId);
          log(`User ${userId} associated with existing repository ${githubRepoFullName}.`, 'github-app');
        }
        successfulAssociations++;
      } catch (dbError: any) {
        // Log the specific error for this repo but continue with others
        log(`Error associating repo ${githubRepoFullName} (ID: ${githubRepoId}) for user ${userId}: ${dbError.message}`, 'github-app');
        // Optionally add to a list of failed associations to return to the user
      }
    }

    log(`Successfully processed ${repositories.length} repositories, associated ${successfulAssociations} for user ${userId}`, 'github-app');
    // Return success even if some individual associations failed (they were logged)
    res.json({ success: true, count: successfulAssociations }); // Update count to reflect actual successes

  } catch (error: any) {
    // This catches errors like token generation or the initial repo fetch
    log(`Error finalizing installation ${installationId} for user ${userId}: ${error.message}`, 'github-app');
    res.status(500).json({ error: 'Failed to finalize installation' });
  }
});

export default router;


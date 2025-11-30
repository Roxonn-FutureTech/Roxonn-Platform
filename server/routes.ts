import type { Express, Request, Response, NextFunction } from "express";
import express from 'express';
import jwt, { SignOptions } from 'jsonwebtoken'; // Added SignOptions
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setupAuth, requireAuth, requireVSCodeAuth, csrfProtection } from "./auth";
import { handleVSCodeAIChatCompletions } from './vscode-ai-handler';
import crypto from 'crypto'; // Fixing the crypto.createHmac issue by using the correct import
import { storage } from "./storage";
import {
    updateProfileSchema,
    type BlockchainError,
    fundRoxnRepoSchema, // Corrected name
    fundUsdcRepoSchema, // For USDC funding
    allocateUnifiedBountySchema, // Corrected name
    submitAssignmentSchema
} from "@shared/schema";
import { registeredRepositories, courseAssignments } from "../shared/schema";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { handleOpenAIStream } from './openai-stream';
import { getOrgRepos, getRepoDetails, verifyRepoExists, verifyUserIsRepoAdmin, verifyUserIsOrgAdmin, getUserAdminOrgs, getOrgReposForRegistration, getUserAdminRepos, handlePullRequestMerged, handleIssueClosed, getInstallationAccessToken, getGitHubApiHeaders, GITHUB_API_BASE, findAppInstallationByName, isValidGitHubOwner, isValidGitHubRepo, buildSafeGitHubUrl, handleBountyCommand, parseBountyCommand } from "./github";
import { blockchain } from "./blockchain";
import { ethers } from "ethers";
import { log } from "./utils";
import passport from "passport";
import { IncomingMessage } from 'http';
import { config } from './config';
import { Webhooks } from "@octokit/webhooks";
import axios from 'axios';
// import rawBody from 'raw-body'; // Not needed as we use express.json with verify
import { exchangeCodeForRefreshToken, getZohoAuthUrl, isZohoConfigured } from './zoho';
import { onrampService } from './onrampService';
import { TransactionStatus } from '../shared/schema';
import { WalletService } from './walletService';
import { checkRepositoryFundingLimit, recordRepositoryFunding, getRepositoryFundingStatus, REPOSITORY_FUNDING_DAILY_LIMIT } from './funding-limits';
import { transferLimits, DAILY_TRANSFER_LIMIT } from './transfer-limits';
import { encryptWithSharedSecret, deriveSharedSecret, SERVER_PUBLIC_KEY_BASE64 } from './ecdh';
import { sendOtpEmail } from './email';
import aiScopingAgentRouter from './routes/aiScopingAgent';
import multiCurrencyWalletRoutes from './routes/multiCurrencyWallet';
import referralRoutes from './routes/referralRoutes';
import promotionalBountiesRoutes from './routes/promotionalBounties';
import { referralService } from './services/referralService';
import { activityService } from './services/activityService';
import { dispatchTask } from './services/proofOfComputeService';
import { handleHeartbeat, getNodeStatus, getAllNodeStatuses } from './services/exoNodeService';
import { securityMiddlewares } from './security/middlewares';
import { getCourseVideoUrls, isCourseValid } from './azure-media';

// Get current file path in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Extend IncomingMessage to include body property
interface ExtendedIncomingMessage extends IncomingMessage {
  body?: any;
}

// Sanitize user data to remove sensitive information
function sanitizeUserData(user: any) {
  if (!user) return null;
  
  // Create a copy of the user object without sensitive fields
  const { xdcWalletMnemonic, xdcPrivateKey, encryptedPrivateKey, encryptedMnemonic, githubAccessToken, ...sanitizedUser } = user;
  
  return sanitizedUser;
}

// --- Webhook Middleware (Keep existing one for now, maybe rename later?) ---
const webhookMiddleware = express.raw({ 
  type: ['application/json', 'application/x-www-form-urlencoded'],
  verify: (req: ExtendedIncomingMessage, _res, buf) => {
    // Store raw body for signature verification
    if (buf && buf.length) {
      req.body = buf;
    }
  }
});

// --- GitHub App Webhook Handler ---
async function handleGitHubAppWebhook(req: Request, res: Response) {
  log('GitHub App Webhook request received', 'webhook-app');
  const event = req.headers['x-github-event'] as string;
  const signature = req.headers['x-hub-signature-256'] as string;
  const delivery = req.headers['x-github-delivery'] as string;
  
  log(`Event: ${event}, Delivery: ${delivery}`, 'webhook-app');

  if (!signature) {
    log('Missing app webhook signature', 'webhook-app');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Initialize Octokit Webhooks for App verification
  const appWebhooks = new Webhooks({
    secret: config.githubAppWebhookSecret! // Use the App specific secret
  });

  // Verify signature using App secret
  const isValid = await appWebhooks.verify(req.body.toString('utf8'), signature);
  if (!isValid) {
      log('Invalid app webhook signature', 'webhook-app');
      return res.status(401).json({ error: 'Invalid signature' });
  }
  log('App webhook signature verified successfully', 'webhook-app');

  // Parse payload AFTER verification
  const payload = JSON.parse(req.body.toString('utf8'));
  const installationId = String(payload.installation?.id);

  if (!installationId) {
      log('App webhook ignored: Missing installation ID', 'webhook-app');
      return res.status(400).json({ error: 'Missing installation ID' });
  }

  log(`Processing event '${event}'...`, 'webhook-app');

  try {
    // --- Handle Installation Events ---
    if (event === 'installation' || event === 'installation_repositories') {
      // ... logic to call storage.upsert/remove ...
      return res.status(200).json({ message: 'Installation event processed.' });
    
    // --- Handle Issue Comment for Bounty Commands ---
    } else if (event === 'issue_comment' && payload.action === 'created') {
      const commentBody = payload.comment?.body || '';
      const command = parseBountyCommand(commentBody);
      
      if (command) {
        log(`Processing bounty command from ${payload.sender?.login} on issue #${payload.issue?.number}`, 'webhook-app');
        setImmediate(() => {
          handleBountyCommand(payload, installationId).catch(err => {
            log(`Error processing bounty command: ${err?.message || err}`, 'webhook-app');
          });
        });
        return res.status(202).json({ message: 'Bounty command processing initiated.' });
      }
      return res.status(200).json({ message: 'Comment ignored - no bounty command' });

    // --- Handle Issue Closed for Payout ---
    } else if (event === 'issues' && payload.action === 'closed') {
      log(`Processing App issue closed event for #${payload.issue?.number}`, 'webhook-app');
      setImmediate(() => {
          // Pass payload ONLY for now. Handler will generate token.
          handleIssueClosed(payload, installationId).catch(err => {
             log(`Error in background App Issue Closed handler: ${err?.message || err}`, 'webhook-app');
          });
      });
      return res.status(202).json({ message: 'Webhook received and Issue Closed processing initiated.' });

    // --- Handle Repository Visibility Changes ---
    } else if (event === 'repository' && (payload.action === 'privatized' || payload.action === 'publicized')) {
      const repoId = String(payload.repository?.id);
      const repoName = payload.repository?.full_name;
      const isPrivate = payload.action === 'privatized';
      log(`Processing repository visibility change: ${repoName} (${repoId}) -> ${isPrivate ? 'private' : 'public'}`, 'webhook-app');

      try {
        const updated = await storage.updateRepositoryVisibility(repoId, isPrivate);
        if (updated) {
          log(`Successfully updated visibility for ${repoName} to ${isPrivate ? 'private' : 'public'}`, 'webhook-app');
        } else {
          log(`Repository ${repoName} not found in registered repositories`, 'webhook-app');
        }
      } catch (err: any) {
        log(`Error updating repository visibility: ${err?.message || err}`, 'webhook-app');
      }
      return res.status(200).json({ message: 'Repository visibility update processed.' });

    // --- Ignore Other Events ---
    } else {
      log(`Ignoring App event ${event} with action ${payload.action}`, 'webhook-app');
      return res.status(200).json({ message: 'Event ignored' });
    }
  } catch (error: any) {
     log(`App Webhook processing error: ${error?.message || error}`, 'webhook-app');
     if (!res.headersSent) {
         return res.status(500).json({ error: 'App webhook processing failed' });
     }
  }
}

export async function registerRoutes(app: Express) {
  // Authentication is already initialized in index.ts
  // Don't call setupAuth(app) again to avoid double registration

  // Health check endpoint for AWS ALB
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "healthy" });
  });
  
  // Zoho CRM Integration Routes
  app.get("/api/zoho/auth", (req, res) => {
    if (!isZohoConfigured()) {
      return res.status(500).json({ error: "Zoho CRM is not configured" });
    }
    
    // Redirect to Zoho authorization page
    const authUrl = getZohoAuthUrl();
    res.redirect(authUrl);
  });
  
  // Zoho OAuth callback handler
  app.get("/api/zoho/auth/callback", async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: "Authorization code not provided" });
    }
    
    try {
      // Exchange code for refresh token
      const refreshToken = await exchangeCodeForRefreshToken(code.toString());
      
      // Display the refresh token to save in environment variables
      res.send(`
        <h1>Zoho Authorization Complete</h1>
        <p>Please save this refresh token in your environment variables:</p>
        <pre>ZOHO_REFRESH_TOKEN="${refreshToken}"</pre>
        <p>You can now close this window and restart your application.</p>
      `);
    } catch (error) {
      console.error("Error getting Zoho refresh token:", error);
      res.status(500).json({ error: "Failed to get refresh token" });
    }
  });

  // Debug middleware to log only blockchain operations
  app.use("/api/blockchain", (req: Request, res: Response, next: NextFunction) => {
    log(`${req.method} ${req.path}`, 'blockchain');
    next();
  });

  // Public GitHub API routes with security protections
  app.get("/api/github/repos", 
    securityMiddlewares.repoRateLimiter, 
    securityMiddlewares.securityMonitor,
    getOrgRepos
  );
  app.get("/api/github/repos/:owner/:name", 
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    getRepoDetails
  );

  // New route to get repositories the authenticated user admins
  app.get("/api/github/user/repos",
    requireAuth,
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    getUserAdminRepos
  );

  // Get GitHub organizations where user is an admin
  app.get("/api/github/user/orgs",
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
  app.get("/api/github/orgs/:org/repos",
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

  // Public routes
  app.get("/api/auth/user", (req, res) => {
    // Sanitize user data before sending to client
    res.json(sanitizeUserData(req.user) || null);
  });

  // Partner API for verifying user registrations
  app.get("/api/partners/verify-registration", async (req: Request, res: Response) => {
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
  // This is now handled by GitHub App installation webhooks
  app.post("/api/repositories/register",
    requireAuth,
    csrfProtection,
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    securityMiddlewares.sanitizeRepoPayload,
    securityMiddlewares.validateRepoPayload,
    // preventDbOverload removed - CSRF token triggers false positives, already have enough validation
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
  });

  // Get repos registered by current user (Keep this for UI)
  app.get("/api/repositories/registered",
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
  });

  // Toggle repository active status (pool manager only)
  app.patch("/api/repositories/:repoId/active",
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
  });

  // Get repositories accessible to the current user (public + private repos they have GitHub access to)
  // Uses GitHub App installation tokens to check collaborator status - NO user private tokens needed
  app.get("/api/repositories/accessible",
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
            };
          } catch (err: any) {
            log(`Error fetching pool info for repo ${repo.githubRepoId}: ${err.message}`, 'routes-ERROR');
            return {
              ...repo,
              xdcPoolRewards: "0.0",
              roxnPoolRewards: "0.0",
              usdcPoolRewards: "0.0",
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
  });

  // Get all publicly visible registered repos, now including their pool balances
  app.get("/api/repositories/public", 
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
              // issues array from poolInfo is also available if needed: poolInfo?.issues
            };
          } catch (err: any) {
            log(`Error fetching pool info for repo ${repo.githubRepoId} in /api/repositories/public: ${err.message}`, 'routes-ERROR');
            return {
              ...repo,
              xdcPoolRewards: "0.0",
              roxnPoolRewards: "0.0",
            };
          }
        })
      );
      
      res.json({ repositories: repositoriesWithPoolInfo });
    } catch (error) {
      log(`Error fetching public repositories: ${error}`, 'routes');
      res.status(500).json({ error: 'Failed to fetch public repositories' });
    }
  });
  
  // Public API to get repository data by ID
  app.get("/api/public/repositories/:repoId", 
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
  });
  
  // Public API to get repository bounties
  app.get("/api/public/repositories/:repoId/bounties", 
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
  });
  
  // Public API to get GitHub issues with bounty labels
  app.get("/api/public/github/issues", async (req: Request, res: Response) => {
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
  app.get("/api/public/unified-repo/:owner/:repo", async (req: Request, res: Response) => {
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
  app.get("/api/repos/details", 
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
  });
  // --- End Platform Repository Routes ---

  // --- GitHub App Routes ---
  app.get("/api/github/app/install-url", requireAuth, (_req: Request, res: Response) => {
    // Construct the installation URL for the GitHub App
    // Use the config variable
    const installUrl = `https://github.com/apps/${config.githubAppName}/installations/new`;
    // Optionally, could add ?target_id=... or ?repository_id=... if needed
    res.json({ installUrl });
  });
  
  // NEW: Endpoint called by frontend after user redirects back from GitHub installation
  app.post("/api/github/app/finalize-installation", requireAuth, csrfProtection, async (req: Request, res: Response) => {
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

  // Protected profile routes
  app.patch("/api/profile", requireAuth, csrfProtection, async (req, res) => {
    const result = updateProfileSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: "Invalid profile data" });
    }

    try {
      // Since this route uses requireAuth middleware, we know req.user exists
      const updatedUser = await storage.updateProfile(req.user!.id, result.data);
      // Sanitize user data before sending to client
      res.json(sanitizeUserData(updatedUser));
    } catch (error) {
      console.error("Error updating profile:", error);
      res.status(400).json({ error: "Failed to update profile" });
    }
  });

  // Get wallet info
  app.get('/api/wallet/info', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Get wallet info from blockchain service
      const walletInfo = await blockchain.getWalletInfo(user.id);
      
      // Mask address for logging to reduce sensitive data exposure
      const maskedAddress = walletInfo.address ? 
        `${walletInfo.address.substring(0, 6)}...${walletInfo.address.substring(walletInfo.address.length - 4)}` : 
        'none';
      log(`Wallet info retrieved for user ${user.id}, Address=${maskedAddress}`, 'routes');
      
      // Add cache control headers to prevent caching sensitive data
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      // Format BigInt values as strings for JSON response
      res.json({
        address: walletInfo.address,
        balance: walletInfo.balance.toString(),
        tokenBalance: walletInfo.tokenBalance.toString()
      });
    } catch (error) {
      console.error('Error fetching wallet info:', error);
      res.status(500).json({ error: 'Failed to fetch wallet information' });
    }
  });
  
  // Get transfer limits for user wallet
  app.get('/api/wallet/limits', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      // Get transfer limits from service
      const transferStatus = transferLimits.getUserTransferStatus(user.id.toString());
      
      // Format the response
      const response = {
        usedAmount: transferStatus.usedAmount,
        remainingLimit: transferStatus.remainingLimit,
        dailyLimit: DAILY_TRANSFER_LIMIT,
        resetTime: transferStatus.resetTimestamp
      };
      
      // Add cache control headers
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.json(response);
    } catch (error) {
      console.error('Error fetching transfer limits:', error);
      res.status(500).json({ error: 'Failed to fetch transfer limits' });
    }
  });
  
  // Get recent transactions for user wallet
  app.get('/api/wallet/transactions', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      // Get limit from query parameters or use default
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      
      // Get recent transactions from blockchain service
      const transactions = await blockchain.getRecentTransactions(user.id, limit);
      
      // Add cache control headers
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.json({ transactions });
    } catch (error) {
      console.error('Error fetching transactions:', error);
      res.status(500).json({ error: 'Failed to fetch transaction history' });
    }
  });
  
  // Generate Onramp.money URL for buying USDC on XDC
  app.get('/api/wallet/buy-xdc-url', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      if (!user.xdcWalletAddress) {
        return res.status(400).json({ error: 'Wallet address not found' });
      }
      
      // Convert XDC address format (xdc...) to 0x format for Onramp.money
      // Onramp requires addresses to start with 0x, not xdc
      const walletAddress = user.xdcWalletAddress.toLowerCase().startsWith('xdc')
        ? '0x' + user.xdcWalletAddress.substring(3)
        : user.xdcWalletAddress;
      
      // Construct the Onramp.money URL with required parameters
      // Using USDC on XDC Network
      const baseUrl = config.onrampMoneyBaseUrl;
      const params = new URLSearchParams({
        appId: config.onrampMoneyAppId,
        walletAddress: walletAddress,
        coinCode: 'usdc',
        network: 'xdc',
        fiatCode: 'INR'
      });
      
      // Add redirect URL back to the wallet page
      params.append('redirectUrl', `${config.frontendUrl}/wallet`);
      
      // Add a unique transaction identifier (could be user ID + timestamp)
      const merchantRecognitionId = `roxonn-${user.id}-${Date.now()}`;
      params.append('merchantRecognitionId', merchantRecognitionId);
      
      const fullUrl = `${baseUrl}?${params.toString()}`;
      
      // Log the generated URL (masking wallet address for security)
      const maskedAddress = `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`;
      log(`Generated Onramp.money URL for user ${user.id}, Address=${maskedAddress} (0x format), MerchantID=${merchantRecognitionId}, Currency=USDC on XDC`);
      
      // Create initial transaction record
      await onrampService.createTransaction({
        userId: user.id,
        walletAddress: user.xdcWalletAddress,
        merchantRecognitionId,
        status: TransactionStatus.INITIATED,
        metadata: { 
          initiatedAt: new Date().toISOString(),
          currency: 'USDC',
          network: 'xdc',
          onrampWalletAddress: walletAddress // Store the 0x format used in Onramp
        }
      });
      
      res.json({ url: fullUrl });
    } catch (error) {
      // Enhanced error logging
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error generating Onramp.money URL:', error);
      log(`Error generating Onramp.money URL: ${errorMessage}`);
      
      // Return appropriate error response
      res.status(500).json({ 
        error: 'UrlGenerationFailed', 
        message: 'Failed to generate purchase URL. Please try again later.' 
      });
    }
  });
  
  // Generate Onramp.money URL for selling/withdrawing USDC on XDC (Off-ramp)
  app.get('/api/wallet/sell-xdc-url', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      if (!user.xdcWalletAddress) {
        return res.status(400).json({ error: 'Wallet address not found' });
      }
      
      // Check if user has any USDC balance on XDC network
      const walletService = new WalletService();
      const usdcBalance = await walletService.getUSDCBalance(user.xdcWalletAddress);
      
      // Validate USDC balance
      if (!usdcBalance) {
        return res.status(400).json({ error: 'Could not retrieve USDC balance' });
      }
      
      try {
        // Check if USDC balance is sufficient
        const balanceValue = parseFloat(usdcBalance);
        
        // Check if balance is too low
        if (balanceValue <= 0) {
          return res.status(400).json({ error: 'Insufficient USDC balance for withdrawal' });
        }
      } catch (error) {
        log(`Error parsing USDC balance for user ${user.id}`, 'wallet-ERROR');
        return res.status(500).json({ error: 'Error processing wallet balance' });
      }
      
      // Convert XDC address format (xdc...) to 0x format for Onramp.money
      // Onramp requires addresses to start with 0x, not xdc
      const walletAddress = user.xdcWalletAddress.toLowerCase().startsWith('xdc')
        ? '0x' + user.xdcWalletAddress.substring(3)
        : user.xdcWalletAddress;
      
      // Construct the Onramp.money Off-ramp URL with required parameters
      // Using USDC on XDC Network
      const baseUrl = config.onrampMoneyBaseUrl.replace('/buy/', '/sell/');
      const params = new URLSearchParams({
        appId: config.onrampMoneyAppId,
        walletAddress: walletAddress,
        coinCode: 'usdc',
        network: 'xdc',
        fiatCode: 'INR'
      });
      
      // Add redirect URL back to the wallet page
      params.append('redirectUrl', `${config.frontendUrl}/wallet`);
      
      // Add a unique transaction identifier (could be user ID + timestamp)
      const merchantRecognitionId = `roxonn-offramp-${user.id}-${Date.now()}`;
      params.append('merchantRecognitionId', merchantRecognitionId);
      
      const fullUrl = `${baseUrl}?${params.toString()}`;
      
      // Log the generated URL (masking wallet address for security)
      const maskedAddress = `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`;
      log(`Generated Onramp.money Off-ramp URL for user ${user.id}, Address=${maskedAddress} (0x format), MerchantID=${merchantRecognitionId}, Currency=USDC on XDC`);
      
      // Create initial transaction record for off-ramp
      await onrampService.createTransaction({
        userId: user.id,
        walletAddress: user.xdcWalletAddress,
        merchantRecognitionId,
        status: TransactionStatus.INITIATED,
        metadata: { 
          initiatedAt: new Date().toISOString(),
          transactionType: 'offramp',
          currency: 'USDC',
          network: 'xdc',
          onrampWalletAddress: walletAddress // Store the 0x format used in Onramp
        }
      });
      
      res.json({ url: fullUrl });
    } catch (error) {
      // Enhanced error logging
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error generating Onramp.money Off-ramp URL:', error);
      log(`Error generating Onramp.money Off-ramp URL: ${errorMessage}`);
      
      // Return appropriate error response
      res.status(500).json({ 
        error: 'UrlGenerationFailed', 
        message: 'Failed to generate withdrawal URL. Please try again later.' 
      });
    }
  });

  // Webhook endpoint for Onramp.money transaction updates
  app.post('/api/webhook/onramp-money', express.json({ verify: (req: IncomingMessage, res, buf) => {
    // Store the raw body for signature verification
    (req as any).rawBody = buf;
  }}), async (req, res) => {
    try {
      // Get the signature from the headers
      const signature = req.headers['x-signature'] as string;
      
      if (!signature) {
        log('Missing signature in Onramp.money webhook');
        return res.status(401).json({ error: 'Unauthorized - Missing signature' });
      }
      
      // Verify the signature using the App Secret Key
      const rawBody = (req as any).rawBody;
      
      // Check if the secret key is configured
      if (!config.onrampMoneyAppSecretKey) {
        log('Onramp.money App Secret Key is not configured');
        return res.status(500).json({ error: 'Server configuration error' });
      }
      
      // Use the createHmac function from the Node.js crypto module
      const hmac = crypto.createHmac('sha512', config.onrampMoneyAppSecretKey);
      hmac.update(rawBody);
      const calculatedSignature = hmac.digest('hex');
      
      if (calculatedSignature !== signature) {
        log('Invalid signature in Onramp.money webhook');
        return res.status(401).json({ error: 'Unauthorized - Invalid signature' });
      }
      
      // Process the webhook payload
      const payload = req.body;
      
      // Log the webhook event (sanitized - no sensitive data)
      const sanitizedPayload = {
        merchantRecognitionId: payload.merchantRecognitionId,
        orderId: payload.orderId,
        statusCode: payload.statusCode,
        status: payload.status,
        hasWalletAddress: !!payload.walletAddress,
        hasTxHash: !!payload.txHash
      };
      log(`Received Onramp.money webhook: ${JSON.stringify(sanitizedPayload)}`);
      
      // Extract transaction details
      const { 
        merchantRecognitionId, 
        orderId, 
        statusCode, 
        status, 
        walletAddress, 
        amount, 
        txHash,
        actualCryptoAmount,
        expectedCryptoAmount,
        fiatAmount
      } = payload;
      
      // Validate required fields
      if (!merchantRecognitionId) {
        log('Missing merchantRecognitionId in Onramp.money webhook');
        return res.status(400).json({ error: 'Bad Request - Missing merchantRecognitionId' });
      }
      
      // Get the mapped status
      const mappedStatus = onrampService.mapStatus(status, statusCode);
      
      // Find existing transaction record
      const existingTransaction = await onrampService.getTransactionByMerchantId(merchantRecognitionId);
      
      if (existingTransaction) {
        // Update existing transaction
        await onrampService.updateTransaction(merchantRecognitionId, {
          orderId: orderId || existingTransaction.orderId,
          status: mappedStatus,
          statusCode,
          statusMessage: status,
          amount: amount || existingTransaction.amount,
          txHash: txHash || existingTransaction.txHash,
          metadata: { 
            ...(existingTransaction.metadata as Record<string, any> || {}),
            lastWebhook: payload,
            lastUpdated: new Date().toISOString()
          }
        });
        
        log(`Updated transaction ${merchantRecognitionId} status to ${mappedStatus}`);
      } else {
        // Transaction not found, create a new record
        // First, find the user by wallet address
        const userRecord = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.xdcWalletAddress, walletAddress)
        });
        
        if (!userRecord) {
          log(`No user found with wallet address ${walletAddress} for Onramp.money transaction`);
          return res.status(200).json({ message: 'Webhook received, but no matching user found' });
        }
        
        // Create new transaction record
        await onrampService.createTransaction({
          userId: userRecord.id,
          walletAddress,
          merchantRecognitionId,
          orderId,
          status: mappedStatus,
          statusCode,
          statusMessage: status,
          amount,
          txHash,
          metadata: {
            createdFromWebhook: true,
            webhookPayload: payload,
            createdAt: new Date().toISOString()
          }
        });
        
        log(`Created new transaction record for ${merchantRecognitionId} with status ${mappedStatus}`);
      }
      
      // Check if this is a subscription payment and activate/renew if successful
      const { onrampMerchantService } = await import('./onrampMerchant');
      const { subscriptionService } = await import('./subscriptionService');
      
      if (onrampMerchantService.isSubscriptionMerchantId(merchantRecognitionId)) {
        log(`📥 Processing subscription payment webhook: ${merchantRecognitionId}`, 'subscription');
        log(`Webhook payload: orderId=${orderId}, status=${status}, statusCode=${statusCode}`, 'subscription');
        log(`Payment amounts: fiat=${fiatAmount}, expected=${expectedCryptoAmount}, actual=${actualCryptoAmount}`, 'subscription');

        // Check if payment was successful
        if (onrampMerchantService.isSuccessStatus(statusCode, status)) {
          // Extract user ID from merchant recognition ID
          const userId = onrampMerchantService.extractUserIdFromMerchantId(merchantRecognitionId);
          
          if (userId) {
            // Validate treasury address if wallet address is provided
            if (walletAddress && !onrampMerchantService.validateTreasuryAddress(walletAddress)) {
              const expectedAddress = config.platformTreasuryAddressPolygon || config.platformTreasuryAddressXdc;
              log(`❌ REJECTED: Payment sent to incorrect treasury address for subscription ${merchantRecognitionId}`, 'subscription-ERROR');
              log(`Expected: ${expectedAddress}, Received: ${walletAddress}`, 'subscription-ERROR');

              // Do NOT activate subscription for payments to wrong address
              // Return 400 to indicate webhook processing failed
              return res.status(400).json({
                error: 'Payment sent to incorrect treasury address',
                details: {
                  merchantRecognitionId,
                  expectedAddress: expectedAddress,
                  receivedAddress: walletAddress
                }
              });
            }

            // Use actual crypto amount if available, otherwise use expected
            // This ensures we record the USDC amount received, not the fiat amount
            const cryptoAmount = actualCryptoAmount || expectedCryptoAmount || amount;
            const amountUsdc = typeof cryptoAmount === 'number' ? cryptoAmount.toString() : cryptoAmount;

            // Check for idempotency - prevent duplicate activations
            if (orderId) {
              const existingSubscription = await subscriptionService.getSubscriptionByOrderId(orderId);
              if (existingSubscription && existingSubscription.status === 'active') {
                log(`✅ Subscription already activated for order ${orderId} (user ${userId}), skipping duplicate activation`, 'subscription');
                return res.status(200).json({ message: 'Subscription already processed' });
              }
            }

            // Activate or renew subscription with error handling
            try {
              await subscriptionService.activateOrRenewSubscription(
                userId,
                'courses_yearly',
                orderId,
                txHash,
                amountUsdc
              );

              log(`✅ Activated/renewed subscription for user ${userId} via ${merchantRecognitionId}`, 'subscription');
              log(`Payment details: orderId=${orderId}, txHash=${txHash}, amount=${amountUsdc} USDC`, 'subscription');
            } catch (activationError) {
              // Log error but don't fail the webhook - return 200 to prevent retries
              const errorMsg = activationError instanceof Error ? activationError.message : String(activationError);
              log(`❌ CRITICAL: Failed to activate subscription for user ${userId}`, 'subscription-ERROR');
              log(`Error details: ${errorMsg}`, 'subscription-ERROR');
              log(`Payment info: merchantId=${merchantRecognitionId}, orderId=${orderId}, txHash=${txHash}, amount=${amountUsdc}`, 'subscription-ERROR');

              // Still return success to prevent webhook retries
              return res.status(200).json({
                message: 'Webhook received, but activation failed',
                error: errorMsg
              });
            }
          } else {
            log(`Failed to extract user ID from subscription merchant ID: ${merchantRecognitionId}`, 'subscription-ERROR');
            log(`Payment was successful but cannot identify user. Manual intervention required.`, 'subscription-ERROR');
            log(`Payment details: orderId=${orderId}, txHash=${txHash}, amount=${actualCryptoAmount || expectedCryptoAmount || amount}`, 'subscription-ERROR');
          }
        } else {
          log(`Subscription payment not successful: ${merchantRecognitionId}, status: ${status}`, 'subscription');
        }
      }
      
      // Acknowledge receipt of the webhook
      res.status(200).json({ message: 'Webhook received successfully' });
    } catch (error) {
      console.error('Error processing Onramp.money webhook:', error);
      log(`Error processing Onramp.money webhook: ${error}`);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  // Get onramp.money transactions for user wallet
  app.get('/api/wallet/onramp-transactions', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      // Get limit from query parameters or use default
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      
      // Get onramp transactions for the user
      const transactions = await onrampService.getUserTransactions(Number(user.id), limit);
      
      // Add cache control headers to prevent caching of sensitive financial data
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.json({ transactions });
    } catch (error) {
      console.error('Error fetching onramp transactions:', error);
      res.status(500).json({ error: 'Failed to fetch onramp transaction history' });
    }
  });
  
  // Subscription routes
  // Initialize merchant checkout for subscription
  app.post('/api/subscription/merchant/init', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      // Import subscription service
      const { onrampMerchantService } = await import('./onrampMerchant');
      const { onrampService } = await import('./onrampService');
      const { TransactionStatus } = await import('../shared/schema');

      // Get parameters from request body
      const fiatType = req.body.fiatType ? parseInt(req.body.fiatType) : undefined;
      const logoUrl = req.body.logoUrl;

      // Build merchant checkout config with user's selected currency
      const config = await onrampMerchantService.buildMerchantCheckoutConfig(
        user.id,
        fiatType,
        logoUrl
      );

      // Create a transaction record to track the payment
      await onrampService.createTransaction({
        userId: user.id,
        walletAddress: config.walletAddress,
        merchantRecognitionId: config.merchantRecognitionId,
        status: TransactionStatus.INITIATED,
        fiatCurrency: fiatType ? undefined : 'INR', // Use default if not specified
        metadata: {
          type: 'subscription',
          plan: 'courses_yearly',
          fiatType: fiatType || 1,
          timestamp: new Date().toISOString()
        }
      });

      log(`Generated merchant checkout config for user ${user.id} with fiatType ${fiatType || '1 (default)'}`, 'subscription');
      log(`Created transaction record: ${config.merchantRecognitionId}`, 'subscription');
      res.json(config);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error initializing merchant checkout:', error);
      log(`Error initializing merchant checkout: ${errorMessage}`, 'subscription-ERROR');
      log(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'subscription-ERROR');
      res.status(500).json({ 
        error: 'Failed to initialize merchant checkout',
        details: errorMessage 
      });
    }
  });

  // Initialize crypto payment (Crypto Merchant Widget)
  app.post('/api/subscription/crypto/init', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Import crypto service
      const { onrampCryptoService } = await import('./onrampCryptoService');

      // Get optional network selection (default to Polygon)
      const chainId = req.body.chainId || '3'; // Default to Polygon (chainId 3)
      const language = req.body.language || 'en';

      // Validate network
      if (!onrampCryptoService.isValidNetwork(chainId)) {
        return res.status(400).json({
          error: 'Invalid network selection',
          details: `Network ${chainId} is not supported`
        });
      }

      // Create crypto payment intent
      const intent = await onrampCryptoService.createCryptoIntent(
        user.id,
        chainId,
        language
      );

      log(`Generated crypto payment intent for user ${user.id}, Network: ${onrampCryptoService.getNetworkName(chainId)}`, 'subscription');
      res.json(intent);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error initializing crypto payment:', error);
      log(`Error initializing crypto payment: ${errorMessage}`, 'subscription-ERROR');
      log(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'subscription-ERROR');
      res.status(500).json({
        error: 'Failed to initialize crypto payment',
        details: errorMessage
      });
    }
  });

  // Get list of supported networks for crypto payment
  app.get('/api/subscription/crypto/networks', async (req, res) => {
    try {
      const { SUPPORTED_CRYPTO_NETWORKS } = await import('./onrampCryptoService');
      res.json(SUPPORTED_CRYPTO_NETWORKS);
    } catch (error) {
      console.error('Error fetching crypto networks:', error);
      res.status(500).json({ error: 'Failed to fetch crypto networks' });
    }
  });

  // Get list of supported currencies for subscription payment
  app.get('/api/subscription/currencies', async (req, res) => {
    try {
      const { getAllCurrencies, getPopularCurrencies } = await import('./currencyConfig');

      const allCurrencies = getAllCurrencies();
      const popularCurrencies = getPopularCurrencies();

      res.json({
        popular: popularCurrencies,
        all: allCurrencies,
      });
    } catch (error) {
      console.error('Error fetching currencies:', error);
      res.status(500).json({ error: 'Failed to fetch currencies' });
    }
  });

  // Get subscription status
  app.get('/api/subscription/status', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      // Import subscription service
      const { subscriptionService } = await import('./subscriptionService');
      
      // Get subscription status
      const status = await subscriptionService.getSubscriptionStatus(user.id);
      
      res.json({
        active: status.active,
        periodEnd: status.periodEnd,
        subscription: status.subscription ? {
          id: status.subscription.id,
          plan: status.subscription.plan,
          status: status.subscription.status,
          currentPeriodStart: status.subscription.currentPeriodStart,
          currentPeriodEnd: status.subscription.currentPeriodEnd,
        } : undefined,
      });
    } catch (error) {
      console.error('Error getting subscription status:', error);
      log(`Error getting subscription status: ${error}`, 'subscription-ERROR');
      res.status(500).json({ error: 'Failed to get subscription status' });
    }
  });

  // Manual payment verification endpoint
  app.post('/api/subscription/verify-payment', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Import verification service
      const { paymentVerificationService } = await import('./paymentVerificationService');

      // Get verification parameters
      const { orderId, txHash, referenceId, timestamp } = req.body;

      // Perform verification
      const result = await paymentVerificationService.verifyPayment(user.id, {
        orderId,
        txHash,
        referenceId,
        timestamp
      });

      // Return appropriate response
      if (result.success) {
        res.json({
          success: true,
          message: result.message,
          subscription: result.subscription
        });
      } else if (result.needsConfirmation) {
        res.json({
          success: false,
          needsConfirmation: true,
          transaction: result.transaction,
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.message,
          error: result.error
        });
      }
    } catch (error) {
      console.error('Error verifying payment:', error);
      log(`Error verifying payment: ${error}`, 'verification-ERROR');
      res.status(500).json({
        error: 'Failed to verify payment',
        message: 'An unexpected error occurred. Please try again or contact support.'
      });
    }
  });

  // Get user's pending payments
  app.get('/api/subscription/pending-payments', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Import verification service
      const { paymentVerificationService } = await import('./paymentVerificationService');

      // Get pending payments
      const pendingPayments = await paymentVerificationService.getUserPendingPayments(user.id);

      res.json({
        success: true,
        payments: pendingPayments
      });
    } catch (error) {
      console.error('Error getting pending payments:', error);
      log(`Error getting pending payments: ${error}`, 'verification-ERROR');
      res.status(500).json({
        error: 'Failed to get pending payments'
      });
    }
  });

  // Confirm payment verification (for timestamp-based verification)
  app.post('/api/subscription/confirm-verification', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { transactionId, confirm } = req.body;

      if (!confirm) {
        return res.json({
          success: false,
          message: 'Verification cancelled'
        });
      }

      // Import services
      const { db } = await import('./db');
      const { onrampTransactions } = await import('../shared/schema');
      const { eq } = await import('drizzle-orm');

      // Verify transaction belongs to user
      const transaction = await db.query.onrampTransactions.findFirst({
        where: eq(onrampTransactions.id, transactionId)
      });

      if (!transaction || transaction.userId !== user.id) {
        return res.status(403).json({
          error: 'Invalid transaction'
        });
      }

      // For confirmed timestamp verification, we need additional proof
      // User should provide either orderId or txHash
      const { orderId, txHash } = req.body;

      if (!orderId && !txHash) {
        return res.status(400).json({
          error: 'Please provide Order ID or Transaction Hash to confirm'
        });
      }

      // Re-verify with the additional proof
      const { paymentVerificationService } = await import('./paymentVerificationService');
      const result = await paymentVerificationService.verifyPayment(user.id, {
        orderId,
        txHash
      });

      res.json(result);
    } catch (error) {
      console.error('Error confirming verification:', error);
      log(`Error confirming verification: ${error}`, 'verification-ERROR');
      res.status(500).json({
        error: 'Failed to confirm verification'
      });
    }
  });

  // Admin: Get all pending subscription payments
  app.get('/api/admin/subscription/pending', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Check if user is admin (user ID 1 is the platform admin)
      if (user.id !== 1) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // Import services
      const { db } = await import('./db');
      const { onrampTransactions, TransactionStatus } = await import('../shared/schema');
      const { and, eq, sql, desc } = await import('drizzle-orm');

      // Get all pending subscription transactions
      const pending = await db.query.onrampTransactions.findMany({
        where: and(
          eq(onrampTransactions.status, TransactionStatus.INITIATED),
          sql`${onrampTransactions.metadata}->>'type' = 'subscription'`,
          sql`${onrampTransactions.createdAt} > NOW() - INTERVAL '7 days'`
        ),
        orderBy: [desc(onrampTransactions.createdAt)],
        limit: 100
      });

      res.json({
        success: true,
        count: pending.length,
        transactions: pending.map(t => ({
          id: t.id,
          userId: t.userId,
          merchantRecognitionId: t.merchantRecognitionId,
          status: t.status,
          createdAt: t.createdAt,
          metadata: t.metadata
        }))
      });
    } catch (error) {
      console.error('Error getting pending transactions:', error);
      log(`Admin error getting pending transactions: ${error}`, 'admin-ERROR');
      res.status(500).json({ error: 'Failed to get pending transactions' });
    }
  });

  // Admin: Manually verify a payment
  app.post('/api/admin/subscription/verify/:orderId', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Check admin access (user ID 1 is the platform admin)
      if (user.id !== 1) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { orderId } = req.params;
      const { userId: targetUserId } = req.body;

      if (!orderId || !targetUserId) {
        return res.status(400).json({ error: 'Order ID and User ID required' });
      }

      // Import verification service
      const { paymentVerificationService } = await import('./paymentVerificationService');

      // Verify payment for the target user
      const result = await paymentVerificationService.verifyPayment(targetUserId, {
        orderId
      });

      // Log admin action
      log(`Admin ${user.id} manually verified payment ${orderId} for user ${targetUserId}`, 'admin-action');

      res.json(result);
    } catch (error) {
      console.error('Error in admin verification:', error);
      log(`Admin verification error: ${error}`, 'admin-ERROR');
      res.status(500).json({ error: 'Failed to verify payment' });
    }
  });

  // Admin: Check Onramp order status
  app.get('/api/admin/onramp/order/:orderId', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Check admin access (user ID 1 is the platform admin)
      if (user.id !== 1) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { orderId } = req.params;

      // Import Onramp service
      const { onrampCryptoService } = await import('./onrampCryptoService');

      // Get order status from Onramp
      const orderStatus = await onrampCryptoService.getOrderStatus(orderId);

      if (!orderStatus) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Log admin action
      log(`Admin ${user.id} checked Onramp order ${orderId}`, 'admin-action');

      res.json({
        success: true,
        order: orderStatus
      });
    } catch (error) {
      console.error('Error checking Onramp order:', error);
      log(`Admin error checking Onramp order: ${error}`, 'admin-ERROR');
      res.status(500).json({ error: 'Failed to check order status' });
    }
  });

  // Admin: Get verification attempts log
  app.get('/api/admin/verification-log', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Check admin access (user ID 1 is the platform admin)
      if (user.id !== 1) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // For now, return a message about checking server logs
      // In production, you'd want to store verification attempts in a database table
      res.json({
        success: true,
        message: 'Check server logs for verification attempts. Search for "verification" tag.',
        note: 'Consider implementing verification_attempts table for better tracking.'
      });
    } catch (error) {
      console.error('Error getting verification log:', error);
      res.status(500).json({ error: 'Failed to get verification log' });
    }
  });

  // Get course videos with subscription gating
  app.get('/api/courses/:courseId/videos', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }
      
      const courseId = req.params.courseId;
      
      // Import services
      const { subscriptionService } = await import('./subscriptionService');
      const { getCourseVideoUrlsWithGating, isCourseValid } = await import('./azure-media');
      
      // Validate course ID
      if (!isCourseValid(courseId)) {
        return res.status(404).json({ error: 'Course not found' });
      }
      
      // Check subscription status
      const status = await subscriptionService.getSubscriptionStatus(user.id);
      
      // Get video URLs with gating
      const videoUrls = await getCourseVideoUrlsWithGating(courseId, status.active);
      
      // Add cache control headers
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      res.json(videoUrls);
    } catch (error) {
      console.error('Error getting course videos:', error);
      log(`Error getting course videos: ${error}`, 'subscription-ERROR');
      res.status(500).json({ error: 'Failed to get course videos' });
    }
  });

  // Get course resource URL (requires subscription)
  app.get('/api/courses/:courseId/resources/:resourceType', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { courseId, resourceType } = req.params;

      // Import services
      const { subscriptionService } = await import('./subscriptionService');
      const { getCourseResourceUrl, isCourseValid } = await import('./azure-media');

      // Validate course ID
      if (!isCourseValid(courseId)) {
        return res.status(404).json({ error: 'Course not found' });
      }

      // Check subscription status - REQUIRED for resource access
      const status = await subscriptionService.getSubscriptionStatus(user.id);

      if (!status.active) {
        return res.status(403).json({
          error: 'Subscription required',
          message: 'You need an active subscription to access course resources'
        });
      }

      // Generate SAS URL for resource
      const resourceUrl = await getCourseResourceUrl(courseId, resourceType as 'manual' | 'workbook');

      res.json({ url: resourceUrl });
    } catch (error) {
      console.error('Error getting course resource:', error);
      log(`Error getting course resource: ${error}`, 'courses-ERROR');
      res.status(500).json({ error: 'Failed to get course resource' });
    }
  });

  // Submit course assignment
  app.post('/api/submit-assignment', requireAuth, csrfProtection, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Validate request body
      const validationResult = submitAssignmentSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Invalid assignment data',
          details: validationResult.error.issues
        });
      }

      const { course, link } = validationResult.data;

      // Insert assignment into database
      const [assignment] = await db.insert(courseAssignments).values({
        userId: user.id,
        course: course,
        assignmentLink: link,
      }).returning();

      log(`User ${user.username} (ID: ${user.id}) submitted assignment for ${course}: ${link}`, 'assignment');

      res.status(201).json({
        success: true,
        message: 'Assignment submitted successfully',
        assignment: {
          id: assignment.id,
          course: assignment.course,
          submittedAt: assignment.submittedAt
        }
      });
    } catch (error) {
      console.error('Error submitting assignment:', error);
      log(`Error submitting assignment: ${error}`, 'assignment-ERROR');
      res.status(500).json({ error: 'Failed to submit assignment' });
    }
  });

  // Blockchain routes
  app.get('/api/blockchain/repository/:repoId', 
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    async (req, res) => {
    try {
      const repoId = parseInt(req.params.repoId);

      // Get repository info from blockchain (no authentication required)
      const repository = await blockchain.getRepository(repoId);
      res.json(repository); // Already formatted in blockchain service
    } catch (error) {
      console.error('Error fetching repository:', error);
      const blockchainError: BlockchainError = {
        error: 'Failed to fetch repository',
        details: error instanceof Error ? error.message : 'Unknown error'
      };
      res.status(500).json(blockchainError);
    }
  });

  // Get repository funding status
  app.get('/api/blockchain/repository/:repoId/funding-status', 
    requireAuth, 
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    async (req, res) => {
    try {
      const repoIdString = req.params.repoId;
      const repoIdNumber = parseInt(repoIdString, 10);
      
      if (isNaN(repoIdNumber)) {
        return res.status(400).json({ error: 'Invalid repository ID format.' });
      }
      
      // Get current funding status for this repository
      const fundingStatus = getRepositoryFundingStatus(repoIdNumber);
      
      return res.json({
        dailyLimit: REPOSITORY_FUNDING_DAILY_LIMIT,
        currentTotal: fundingStatus.currentTotal,
        remainingLimit: fundingStatus.remainingLimit,
        windowStartTime: fundingStatus.windowStartTime.toISOString(),
        windowEndTime: fundingStatus.windowEndTime.toISOString()
      });
    } catch (error) {
      console.error('Error getting repository funding status:', error);
      res.status(500).json({ error: 'Failed to get repository funding status' });
    }
  });

  // Modified funding route with stricter checks
  app.post('/api/blockchain/repository/:repoId/fund', requireAuth, csrfProtection, async (req, res) => {
    try {
      // Validate input: repoId from URL param, amountXdc and repositoryFullName from body
      const repoIdString = req.params.repoId; // repoId from GitHub, treat as string for consistency
      const { amountXdc, repositoryFullName } = req.body;

      // Explicit check for req.user after requireAuth for type safety / linter
      if (!req.user) {
        return res.status(401).json({ error: 'User not authenticated despite middleware check.' });
      }

      if (!repoIdString || !amountXdc || !repositoryFullName || typeof amountXdc !== 'string' || typeof repositoryFullName !== 'string') {
         return res.status(400).json({ error: 'Missing or invalid parameters (repoId, amountXdc, repositoryFullName)' });
      }

      // Validate amount format
      try {
        ethers.parseEther(amountXdc);
      } catch (error) {
        return res.status(400).json({ error: 'Invalid amount format for XDC' });
      }

      // Check user authentication and role (req.user is now guaranteed to exist)
      if (req.user.role !== 'poolmanager' || !req.user.githubAccessToken || !req.user.walletReferenceId) {
        return res.status(403).json({ error: 'Forbidden: User must be an authenticated Pool Manager with a connected wallet and GitHub token.' });
      }

      // Verify repository registration in our database for this user
      const registration = await storage.findRegisteredRepository(req.user.id, repoIdString);
      if (!registration) {
        return res.status(403).json({ error: 'Forbidden: Repository not registered by this user.' });
      }
      // Optionally check if registration.githubRepoFullName matches repositoryFullName from body for consistency
      if (registration.githubRepoFullName !== repositoryFullName) {
         log(`Warning: Full name mismatch during funding. DB: ${registration.githubRepoFullName}, Request: ${repositoryFullName}`, 'routes');
         // Decide whether to error out or proceed
         // return res.status(400).json({ error: 'Repository name mismatch.' });
      }

      // Extract owner/name for GitHub admin check
      const [owner, name] = repositoryFullName.split('/');
      if (!owner || !name) {
        return res.status(400).json({ error: 'Invalid repository name format in request body.' });
      }

      // Strictly verify admin permissions on GitHub
      log(`Verifying admin permissions for ${req.user.id} on ${repositoryFullName}`, 'routes');
      const isAdmin = await verifyUserIsRepoAdmin(req.user.githubAccessToken, owner, name);
      if (!isAdmin) {
        // If they were admin when registering but not now, forbid funding
        return res.status(403).json({ error: 'Forbidden: User no longer has admin rights on the GitHub repository.' });
      }

      // Log funding action with XDC
      log(`User ${req.user.id} funding registered repository ${repoIdString} with ${amountXdc} XDC`, 'routes');

      // Call blockchain service (passing repoId as number, amountXdc as string)
      const repoIdNumber = parseInt(repoIdString, 10);
      if (isNaN(repoIdNumber)) {
          return res.status(400).json({ error: 'Invalid repository ID format.'});
      }
      
      // Check daily funding limit for this repository
      const amountXdcNumber = parseFloat(amountXdc);
      const fundingCheck = checkRepositoryFundingLimit(repoIdNumber, amountXdcNumber);
      
      if (!fundingCheck.allowed) {
        const resetTimeStr = fundingCheck.limitResetTime ? fundingCheck.limitResetTime.toISOString() : 'unknown';
        log(`Funding rejected: Repository ${repoIdNumber} has reached daily limit of ${REPOSITORY_FUNDING_DAILY_LIMIT} XDC`, 'routes');
        return res.status(429).json({
          error: `Daily funding limit reached for this repository.`,
          details: {
            remainingLimit: fundingCheck.remainingLimit,
            dailyLimit: REPOSITORY_FUNDING_DAILY_LIMIT,
            limitResetTime: resetTimeStr
          }
        });
      }

      // Use addXDCFundToRepository for XDC funding
      const txResponse = await blockchain.addXDCFundToRepository( 
        repoIdNumber, 
        amountXdc,    
        req.user.id
      );
      
      // Record the successful funding transaction
      recordRepositoryFunding(repoIdNumber, amountXdcNumber);

      // Respond with transaction details using the correct 'res' object
      return res.json({ // Added return here
          message: 'Funding transaction submitted successfully.',
          transactionHash: txResponse.hash
      });

    } catch (error: any) {
      log(`Error funding repository ${req.params.repoId}: ${error}`, 'routes');
      // Provide more specific error messages if possible (e.g., from blockchain service)
      const errorMessage = error.message || 'Failed to fund repository';
      const status = errorMessage.includes('Insufficient') ? 400 : 500; // Basic error mapping
      res.status(status).json({ error: errorMessage });
    }
  });


  // Add endpoint to get rewards for multiple repositories (this needs to be updated for dual currency)
  app.post('/api/blockchain/repository-rewards', async (req: Request, res: Response) => { // Temporarily removed express.json() for diagnostics
    try {
      const { repoIds } = req.body; // repoIds is expected to be number[]
      
      if (!Array.isArray(repoIds) || !repoIds.every(id => typeof id === 'number')) {
        return res.status(400).json({ error: 'Invalid or empty repoIds array, must be numbers' });
      }
      
      // blockchain.getRepositoryRewards now takes a single repoId and returns {rewardsXDC, rewardsROXN}
      // To get for multiple, we'd loop or the service method needs to be adapted.
      // For now, let's assume we adapt this endpoint to fetch for one repoId at a time, or adjust service.
      // Simpler: This endpoint might be better served by client calling /api/blockchain/pool-info/:repoId for each.
      // Or, if batching is essential, blockchain.getRepositoryRewards needs to be a batch-supporting function.
      // Let's assume for now this endpoint is for a single repoId for simplicity, or it's deprecated by pool-info.
      // For now, I will comment it out as its current logic is incompatible with the refactored blockchain service.
      // If needed, it can be re-implemented to loop or call a new batch service method.
      /*
      const rewardsData = [];
      for (const repoId of repoIds) {
        const data = await blockchain.getRepositoryRewards(repoId); // This now returns {rewardsXDC, rewardsROXN}
        rewardsData.push({
          repoId,
          rewardsXDC: data.rewardsXDC,
          rewardsROXN: data.rewardsROXN
        });
      }
      res.json({ rewards: rewardsData });
      */
      return res.status(501).json({ error: "Endpoint /api/blockchain/repository-rewards needs reimplementation for dual currency."});

    } catch (error) {
      console.error('Error fetching repository rewards:', error);
      const blockchainError: BlockchainError = {
        error: 'Failed to fetch repository rewards',
        details: error instanceof Error ? error.message : 'Unknown error'
      };
      res.status(500).json(blockchainError);
    }
  });

  // --- Webhook Routes ---
  // Old user webhook (Commented out)
  // app.post('/webhook/github', webhookMiddleware, handleGitHubWebhook);
  // New GitHub App webhook endpoint
  app.post('/webhook/github/app', express.raw({ type: 'application/json' }), handleGitHubAppWebhook);

  // Cache for tracking wallet export requests (to implement rate limiting)
  const exportRequestCache = new Map<number, { timestamp: number, count: number }>();
  
  // In-memory OTP store: userId -> { code, expires }
  const otpStore = new Map<number, { code: string; expires: number }>();
  
  // 1. Endpoint to request an OTP
  app.post('/api/wallet/export-request', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Auth required' });
      
      const userId = req.user.id;
      const email = req.user.email;
      
      if (!email) return res.status(400).json({ error: 'No email on account' });
      
      // Generate 6-digit numeric code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = Date.now() + 5 * 60 * 1000; // 5 min
      
      otpStore.set(userId, { code, expires });
      
      // Send email via SES
      await sendOtpEmail(email, code);
      
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to send OTP' });
    }
  });

  // Middleware: require valid OTP in req.body.otp
  function requireOtp(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return res.status(401).json({ error: 'Auth required' });
    const record = otpStore.get(req.user.id);
    const otp = req.body?.otp;
    if (!record || record.code !== otp || Date.now() > record.expires) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    // Consume OTP so it cannot be reused
    otpStore.delete(req.user.id);
    next();
  }

  // Wallet export endpoint for MetaMask integration
  app.post('/api/wallet/export-data', requireAuth, csrfProtection, requireOtp, async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const userId = req.user.id;
      const userRole = req.user.role;
      
      // Role-based access control - this aligns with the application's role-based wallet functionality
      // We could restrict this to specific roles if needed
      if (!userRole) {
        log(`Unauthorized wallet export attempt by user ${userId} with no role`, 'security');
        return res.status(403).json({ error: 'Unauthorized access' });
      }
      
      // Implement rate limiting (max 3 requests per hour)
      const now = Date.now();
      const hourInMs = 60 * 60 * 1000;
      const userRequests = exportRequestCache.get(userId) || { timestamp: now, count: 0 };
      
      // Clear expired entries
      if (now - userRequests.timestamp > hourInMs) {
        userRequests.count = 0;
        userRequests.timestamp = now;
      }
      
      // Check if limit exceeded
      if (userRequests.count >= 3) {
        log(`Rate limit exceeded for wallet export by user ${userId}`, 'security');
        return res.status(429).json({ 
          error: 'Rate limit exceeded', 
          message: 'For security reasons, wallet export is limited to 3 attempts per hour' 
        });
      }
    
      // Increment request count
      userRequests.count++;
      exportRequestCache.set(userId, userRequests);
      
      // Enhanced security logging with IP address and user agent for audit trail
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      log(`Wallet export requested by user ${userId} (${userRole}) from IP ${clientIp}`, 'security');
      log(`User agent: ${userAgent}`, 'security');
      
      // Validate client ECDH public key
      const clientPubKey: string | undefined = req.body?.ephemeralPublicKey;
      if (!clientPubKey) {
        return res.status(400).json({ error: 'Missing client public key' });
      }
      
      // Get wallet data with private key (still in plaintext server-side)
      const walletService = new WalletService();
      const walletData = await walletService.getWalletDataForExport(userId);
      
      if (!walletData || !walletData.privateKey) {
        log('Invalid wallet data returned from service', 'wallet');
        return res.status(500).json({ 
          error: 'Wallet data retrieval failed',
          message: 'Unable to retrieve complete wallet data'
        });
      }
      
      // --- Envelope encryption using shared secret ---
      const { deriveSharedSecret, encryptWithSharedSecret, SERVER_PUBLIC_KEY_BASE64 } = await import('./ecdh');
      const sharedSecret = await deriveSharedSecret(clientPubKey);
      const { iv, cipherText } = await encryptWithSharedSecret(walletData.privateKey, sharedSecret);
      
      // Add network configuration for XDC
      // MetaMask requires specific formatting for chainId as a hex string
      const networkConfig = {
        chainId: '0x32', // 50 in decimal
        chainName: 'XDC Network',
        nativeCurrency: {
          name: 'XDC',
          symbol: 'XDC',
          decimals: 18
        },
        rpcUrls: ['https://rpc.xinfin.network'],
        blockExplorerUrls: ['https://explorer.xinfin.network']
      };
      
      // Set security headers to prevent caching of this sensitive response
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      
      // Log successful export attempt (without including the key)
      log(`Wallet export successful for user ${userId}`, 'wallet');
      
      // Return a consistent, well-structured response
      return res.status(200).json({
        success: true,
        address: walletData.address,
        cipherText,
        iv,
        serverPublicKey: SERVER_PUBLIC_KEY_BASE64,
        networkConfig
      });
    } catch (error: any) {
      log(`Error in wallet export: ${error.message}`, 'wallet');
      return res.status(500).json({ 
        error: 'Export failed', 
        message: error.message || 'Failed to export wallet'
      });
    }
  });

  // Token-specific endpoints
  app.get("/api/token/balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user || !user.xdcWalletAddress) {
        return res.status(400).json({ error: 'Wallet address not found' });
      }
      
      const userAddress = user.xdcWalletAddress;
      const balance = await blockchain.getTokenBalance(userAddress);
      res.json({ balance: balance.toString() });
    } catch (error) {
      log(`Error fetching token balance: ${error}`, 'blockchain');
      res.status(500).json({ error: 'Failed to fetch token balance' });
    }
  });

  // Social Engagement feature has been removed

  // --- VSCode AI Completion Endpoint ---

  // Helper function for cost estimation (initial rough version)
  // TODO: Refine this based on actual tokenomics and model pricing
  function estimateRequestCost(requestBody: any): number {
    // Rough estimation based on input length
    const inputLength = JSON.stringify(requestBody.messages).length;
    // Assuming ~4 chars per token for input and a conservative estimate for output
    const estimatedInputTokens = Math.ceil(inputLength / 4); 
    const estimatedOutputTokens = requestBody.max_tokens || 1000; // Use max_tokens if provided, else default
    
    // Example pricing (e.g., GPT-4o: $0.005 input, $0.015 output per 1K tokens)
    // These should come from a centralized configuration or pricing service eventually
    const inputPricePer1k = 0.005; // dollars
    const outputPricePer1k = 0.015; // dollars
    
    // Cost in "AI Credits" - assuming 1 credit = $0.001 (or 1000 credits = $1)
    // This conversion factor needs to be aligned with your AI credit system.
    const creditValue = 0.001; // 1 credit = $0.001

    const estimatedCostDollars = (estimatedInputTokens * inputPricePer1k / 1000) + (estimatedOutputTokens * outputPricePer1k / 1000);
    return Math.ceil(estimatedCostDollars / creditValue); // Return cost in AI Credits
  }

  // Helper function to calculate actual cost from usage (initial rough version)
  // TODO: Refine this based on actual tokenomics and model pricing
  function calculateTokenCost(inputTokens: number, outputTokens: number): number {
    // Example pricing (e.g., GPT-4o: $0.005 input, $0.015 output per 1K tokens)
    // These should come from a centralized configuration or pricing service eventually
    // Adding a small markup (e.g., 20%) as per the plan
    const inputPricePer1k = 0.005 * 1.2; 
    const outputPricePer1k = 0.015 * 1.2;
    
    const creditValue = 0.001; // 1 credit = $0.001

    const actualCostDollars = (inputTokens * inputPricePer1k / 1000) + (outputTokens * outputPricePer1k / 1000);
    return Math.ceil(actualCostDollars / creditValue); // Return cost in AI Credits
  }

  // Placeholder for deductAICredits function
  // TODO: Implement this to interact with your actual AI credit system in storage/db
  async function deductAICredits(userId: number, amount: number): Promise<void> {
    log(`Deducting ${amount} AI credits from user ${userId}`, 'vscode-ai');
    
    const user = await storage.getUserById(userId); // Corrected method
    if (user) {
      const currentPromptBalance = user.aiCredits || 0; // Removed @ts-ignore
      if (currentPromptBalance < amount) {
        // This check should ideally happen before calling the AI model,
        // but also good to have a safeguard here.
        log(`User ${userId} has insufficient credits (${currentPromptBalance}) for deduction of ${amount}`, 'vscode-ai');
        throw new Error('Insufficient AI credits for deduction.');
      }
      const newCredits = currentPromptBalance - amount;
      // Assuming 'aiCredits' is a valid field in your users table for updateProfile
      await storage.updateProfile(userId, { aiCredits: newCredits }); 
      log(`User ${userId} new AI credit balance: ${newCredits}`, 'vscode-ai');
    } else {
      log(`User ${userId} not found for AI credit deduction.`, 'vscode-ai');
      throw new Error(`User ${userId} not found for AI credit deduction.`);
    }
  }

  // Placeholder for logAIUsage function
  // TODO: Implement this to log AI usage to your analytics or database
  async function logAIUsage(userId: number, usageData: any): Promise<void> {
    log(`Logging AI usage for user ${userId}: ${JSON.stringify(usageData)}`, 'vscode-ai');
    // This would typically involve saving usage details to a database table.
    // Example: await db.insert(aiUsageLogs).values({ userId, ...usageData, timestamp: new Date() });
  }

  // Special exemption for VSCode API endpoints - disable CSRF to allow token-based auth
  // VSCode extension will include JWT token in Authorization header but not CSRF token
  app.post('/api/vscode/ai/completions', requireAuth, async (req: Request, res: Response) => {
    log('VSCode AI Completions request received', 'vscode-ai');
    try {
      const user = req.user;
      if (!user) {
        // requireAuth should handle this, but as a safeguard
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // 1. Estimate cost and check AI credits
      // Note: The plan suggests estimating before calling, but actual deduction after.
      // For simplicity in this stub, we'll do a preliminary check.
      // A more robust implementation might pre-authorize/hold credits.
      const estimatedCost = estimateRequestCost(req.body);
      log(`Estimated AI cost for user ${user.id}: ${estimatedCost} credits`, 'vscode-ai');
      
      // Fetch full user profile to get aiCredits, as req.user might be a partial object
      // However, requireAuth should populate req.user fully if deserializeUser does.
      // req.user type in auth.ts now includes aiCredits.
      // Using the narrowed 'user' variable which is guaranteed to be defined here.
      const currentPromptBalance = user.promptBalance || 0; 
      if (currentPromptBalance < estimatedCost) {
        log(`User ${user.id} has insufficient AI credits (${currentPromptBalance}) for estimated cost (${estimatedCost})`, 'vscode-ai');
        return res.status(402).json({ // 402 Payment Required
          error: "Insufficient AI credits",
          message: "Please top up your AI credits to continue.",
          currentBalance: currentPromptBalance,
          requiredEstimate: estimatedCost
        });
      }

      // 2. Call Azure OpenAI (or other configured cloud AI provider)
      // TODO: Replace with actual call to your AI service/proxy layer
      // This service should use config.azureOpenaiEndpoint, config.azureOpenaiKey etc.
      log(`Proxying AI request for user ${user.id} to Azure OpenAI`, 'vscode-ai');
      
      // Ensure environment variables are loaded and available in config
      if (!config.azureOpenaiEndpoint || !config.azureOpenaiKey || !config.azureOpenaiDeploymentName || !config.azureOpenaiApiVersion) {
        log('Azure OpenAI configuration (endpoint, key, deploymentName, apiVersion) is missing or incomplete on the backend.', 'vscode-ai');
        console.error('Azure OpenAI configuration is missing. Please check .env and server/config.ts');
        return res.status(500).json({ error: 'AI service backend not configured properly. Missing Azure OpenAI details.' });
      }
      
      const azureRequestBody = { ...req.body };
      // Ensure model is not passed if your endpoint implies a specific deployment
      // Or, map req.body.model to your Azure deployment names if you support multiple
      // For now, assuming req.body is directly compatible or your Azure endpoint handles it.

      const azureUrl = `${config.azureOpenaiEndpoint}/openai/deployments/${config.azureOpenaiDeploymentName}/chat/completions?api-version=${config.azureOpenaiApiVersion}`;
      log(`Azure request URL: ${azureUrl}`, 'vscode-ai');

      const aiServiceResponse = await fetch(azureUrl, {
        method: 'POST',
        headers: {
          'api-key': config.azureOpenaiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(azureRequestBody) // Send the original request body from VSCode
      });

      if (!aiServiceResponse.ok) {
        const errorBody = await aiServiceResponse.text();
        log(`Azure OpenAI request failed with status ${aiServiceResponse.status}: ${errorBody}`, 'vscode-ai');
        return res.status(aiServiceResponse.status).json({ 
          error: 'AI service request failed', 
          message: `Underlying AI service error: ${aiServiceResponse.statusText}`,
          details: errorBody 
        });
      }
      
      const responseData = await aiServiceResponse.json();

      // 3. Calculate actual cost from usage and deduct credits
      if (responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
        const actualCost = calculateTokenCost(
          responseData.usage.prompt_tokens,
          responseData.usage.completion_tokens
        );
        log(`Actual AI cost for user ${user.id}: ${actualCost} credits`, 'vscode-ai');
        try {
          await deductAICredits(user.id, actualCost);
        } catch (deductionError: any) {
          log(`Error deducting AI credits for user ${user.id}: ${deductionError.message}`, 'vscode-ai');
          // Decide how to handle this: still return response, or error?
          // For now, log and continue, but this could lead to free usage if deduction fails.
        }
        
        // 4. Log usage for analytics
        await logAIUsage(user.id, {
          service: 'vscode-ai',
          model: azureRequestBody.model || config.azureOpenaiDeploymentName,
          inputTokens: responseData.usage.prompt_tokens,
          outputTokens: responseData.usage.completion_tokens,
          costInCredits: actualCost
        });
      } else {
        log(`Could not determine token usage from AI response for user ${user.id}. Credits not deducted. Response keys: ${Object.keys(responseData).join(', ')}`, 'vscode-ai');
      }
      
      // 5. Return response to VSCode extension
      log(`Successfully processed AI request for user ${user.id}`, 'vscode-ai');
      res.json(responseData);
      
    } catch (error: any) {
      log(`VSCode AI request processing error: ${error.message}`, 'vscode-ai');
      console.error('VSCode AI request failed:', error); // Keep console.error for more detailed stack trace if needed
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'AI service temporarily unavailable',
          message: error.message 
        });
      }
    }
  });

  // JWT Debug route
  app.get('/api/debug/jwt', passport.authenticate('jwt', { session: false, failWithError: false }), (req: Request, res: Response) => {
    // Log full authorization header for debugging
    const authHeader = req.headers.authorization;
    log(`Debug JWT - Authorization Header: ${authHeader ? 'Present' : 'Not present'}`, 'jwt-debug');
    
    // Log user information
    if (req.user) {
      log(`Debug JWT - User found: ID=${req.user.id}, username=${req.user.username}`, 'jwt-debug');
      res.status(200).json({ 
        status: 'authenticated', 
        userId: req.user.id, 
        username: req.user.username,
        promptBalance: req.user.promptBalance ?? 0,
        tokenInfo: 'Valid JWT token'
      });
    } else {
      log(`Debug JWT - No user found in request`, 'jwt-debug');
      res.status(401).json({ status: 'unauthenticated', message: 'No valid JWT token found' });
    }
  });
  
  // Route without /api prefix for VSCode direct requests
  app.post('/vscode/ai/chat/completions', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
    log('VSCode AI Chat Completions request received (no /api prefix)', 'vscode-ai');
    // Use the new handler that supports streaming responses
    return handleVSCodeAIChatCompletions(req, res);
  });
  
  // Additional endpoint for OpenAI client which appends /chat/completions to the base URL
  // This matches the endpoint format that the OpenAI client expects
  app.post('/api/vscode/ai/chat/completions', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
    log('VSCode AI Chat Completions request received', 'vscode-ai');
    // Use the new handler that supports streaming responses
    return handleVSCodeAIChatCompletions(req, res);
  });

  // --- VSCode Profile & Balance Endpoints ---
  app.get('/api/vscode/profile', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
    log('VSCode Profile request received', 'vscode-profile');
    if (!req.user) {
      // This should ideally be caught by requireVSCodeAuth, but as a safeguard
      return res.status(401).json({ error: 'User not authenticated' });
    }
    // Construct the profile data expected by the VSCode extension
    const userProfileData = {
      id: req.user.id,
      username: req.user.username, // GitHub username
      name: req.user.name,         // Full name from GitHub
      email: req.user.email,
      avatarUrl: req.user.avatarUrl,
      promptBalance: req.user.promptBalance ?? 0, // Use promptBalance
      // Include other fields if the VSCode extension expects them from this endpoint
    };
    res.json({ user: userProfileData }); // Nest under 'user' key
  });

  app.get('/api/vscode/profile/balance', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
    log('VSCode Profile Balance request received', 'vscode-profile');
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    res.json({
      balance: req.user.promptBalance ?? 0, // Use promptBalance, key is 'balance'
      // Optionally, if ROXN token balance or XDC balance is also needed here:
      // roxnBalance: (await blockchain.getTokenBalance(req.user.xdcWalletAddress!)).toString(), // Example
      // xdcBalance: (await blockchain.getWalletInfo(req.user.id)).balance.toString(), // Example
    });
  });
  
  /* Original handlers below kept for reference */
  /* 
  app.post('/vscode/ai/chat/completions-old', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, async (req: Request, res: Response) => {
    log('VSCode AI Chat Completions request received (no /api prefix)', 'vscode-ai');
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // 1. Estimate cost and check AI credits
      const estimatedCost = estimateRequestCost(req.body);
      log(`Estimated AI cost for user ${user.id}: ${estimatedCost} credits`, 'vscode-ai');
      
      const currentPromptBalance = user.aiCredits || 0; 
      if (currentPromptBalance < estimatedCost) {
        log(`User ${user.id} has insufficient AI credits (${currentPromptBalance}) for estimated cost (${estimatedCost})`, 'vscode-ai');
        return res.status(402).json({
          error: "Insufficient AI credits",
          message: "Please top up your AI credits to continue.",
          currentBalance: currentPromptBalance,
          requiredEstimate: estimatedCost
        });
      }

      // 2. Call Azure OpenAI
      log(`Proxying AI request for user ${user.id} to Azure OpenAI`, 'vscode-ai');
      
      if (!config.azureOpenaiEndpoint || !config.azureOpenaiKey || !config.azureOpenaiDeploymentName || !config.azureOpenaiApiVersion) {
        log('Azure OpenAI configuration is missing or incomplete on the backend.', 'vscode-ai');
        return res.status(500).json({ error: 'AI service backend not configured properly.' });
      }
      
      const azureRequestBody = { ...req.body };

      const azureUrl = `${config.azureOpenaiEndpoint}/openai/deployments/${config.azureOpenaiDeploymentName}/chat/completions?api-version=${config.azureOpenaiApiVersion}`;
      log(`Azure request URL: ${azureUrl}`, 'vscode-ai');

      const aiServiceResponse = await fetch(azureUrl, {
        method: 'POST',
        headers: {
          'api-key': config.azureOpenaiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(azureRequestBody)
      });

      if (!aiServiceResponse.ok) {
        const errorBody = await aiServiceResponse.text();
        log(`Azure OpenAI request failed with status ${aiServiceResponse.status}: ${errorBody}`, 'vscode-ai');
        return res.status(aiServiceResponse.status).json({ 
          error: 'AI service request failed', 
          message: `Underlying AI service error: ${aiServiceResponse.statusText}`,
          details: errorBody 
        });
      }
      
      const responseData = await aiServiceResponse.json();

      // 3. Calculate actual cost from usage and deduct credits
      if (responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
        const actualCost = calculateTokenCost(
          responseData.usage.prompt_tokens,
          responseData.usage.completion_tokens
        );
        log(`Actual AI cost for user ${user.id}: ${actualCost} credits`, 'vscode-ai');
        try {
          await deductAICredits(user.id, actualCost);
        } catch (deductionError: any) {
          log(`Error deducting AI credits for user ${user.id}: ${deductionError.message || deductionError}`, 'vscode-ai');
        }
        
        // 4. Log usage for analytics
        await logAIUsage(user.id, {
          service: 'vscode-ai-chat',
          model: azureRequestBody.model || config.azureOpenaiDeploymentName,
          inputTokens: responseData.usage.prompt_tokens,
          outputTokens: responseData.usage.completion_tokens,
          costInCredits: actualCost
        });
      } else {
        log(`Could not determine token usage from AI response for user ${user.id}. Credits not deducted.`, 'vscode-ai');
      }
      
      // 5. Return response to VSCode extension
      log(`Successfully processed AI chat request for user ${user.id}`, 'vscode-ai');
      res.json(responseData);
      
    } catch (error: any) {
      log(`VSCode AI chat request processing error: ${error.message || error}`, 'vscode-ai');
      console.error('VSCode AI chat request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'AI service temporarily unavailable',
          message: error.message || 'Unknown error'
        });
      }
    }
  });

  // Additional endpoint for OpenAI client which appends /chat/completions to the base URL
  // This matches the endpoint format that the OpenAI client expects
  app.post('/api/vscode/ai/chat/completions', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, async (req: Request, res: Response) => {
    log('VSCode AI Chat Completions request received', 'vscode-ai');
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // 1. Estimate cost and check AI credits
      const estimatedCost = estimateRequestCost(req.body);
      log(`Estimated AI cost for user ${user.id}: ${estimatedCost} credits`, 'vscode-ai');
      
      const currentPromptBalance = user.aiCredits || 0; 
      if (currentPromptBalance < estimatedCost) {
        log(`User ${user.id} has insufficient AI credits (${currentPromptBalance}) for estimated cost (${estimatedCost})`, 'vscode-ai');
        return res.status(402).json({
          error: "Insufficient AI credits",
          message: "Please top up your AI credits to continue.",
          currentBalance: currentPromptBalance,
          requiredEstimate: estimatedCost
        });
      }

      // 2. Call Azure OpenAI
      log(`Proxying AI request for user ${user.id} to Azure OpenAI`, 'vscode-ai');
      
      if (!config.azureOpenaiEndpoint || !config.azureOpenaiKey || !config.azureOpenaiDeploymentName || !config.azureOpenaiApiVersion) {
        log('Azure OpenAI configuration is missing or incomplete on the backend.', 'vscode-ai');
        return res.status(500).json({ error: 'AI service backend not configured properly.' });
      }
      
      const azureRequestBody = { ...req.body };

      const azureUrl = `${config.azureOpenaiEndpoint}/openai/deployments/${config.azureOpenaiDeploymentName}/chat/completions?api-version=${config.azureOpenaiApiVersion}`;
      log(`Azure request URL: ${azureUrl}`, 'vscode-ai');

      const aiServiceResponse = await fetch(azureUrl, {
        method: 'POST',
        headers: {
          'api-key': config.azureOpenaiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(azureRequestBody)
      });

      if (!aiServiceResponse.ok) {
        const errorBody = await aiServiceResponse.text();
        log(`Azure OpenAI request failed with status ${aiServiceResponse.status}: ${errorBody}`, 'vscode-ai');
        return res.status(aiServiceResponse.status).json({ 
          error: 'AI service request failed', 
          message: `Underlying AI service error: ${aiServiceResponse.statusText}`,
          details: errorBody 
        });
      }
      
      const responseData = await aiServiceResponse.json();

      // 3. Calculate actual cost from usage and deduct credits
      if (responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
        const actualCost = calculateTokenCost(
          responseData.usage.prompt_tokens,
          responseData.usage.completion_tokens
        );
        log(`Actual AI cost for user ${user.id}: ${actualCost} credits`, 'vscode-ai');
        try {
          await deductAICredits(user.id, actualCost);
        } catch (deductionError) {
          log(`Error deducting AI credits for user ${user.id}: ${deductionError}`, 'vscode-ai');
        }
        
        // 4. Log usage for analytics
        await logAIUsage(user.id, {
          service: 'vscode-ai-chat',
          model: azureRequestBody.model || config.azureOpenaiDeploymentName,
          inputTokens: responseData.usage.prompt_tokens,
          outputTokens: responseData.usage.completion_tokens,
          costInCredits: actualCost
        });
      } else {
        log(`Could not determine token usage from AI response for user ${user.id}. Credits not deducted.`, 'vscode-ai');
      }
      
      // 5. Return response to VSCode extension
      log(`Successfully processed AI chat request for user ${user.id}`, 'vscode-ai');
      res.json(responseData);
      
    } catch (error: any) {
      log(`VSCode AI chat request processing error: ${error.message || error}`, 'vscode-ai');
      console.error('VSCode AI chat request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'AI service temporarily unavailable',
          message: error.message || 'Unknown error'
        });
      }
    }
  });
  */

  // Catch-all route for client-side routing
  // New route for VSCode onboarding finalization
  app.get('/api/auth/vscode/finalize-onboarding', requireAuth, (req: Request, res: Response) => {
    if (!req.user) {
      log('VSCode finalize: No user in session. Should have been caught by requireAuth.', 'auth-ERROR');
      return res.redirect(`${config.frontendUrl}/auth?error=session_expired_for_vscode_finalize`);
    }

    // Accessing session property correctly
    // Ensure SessionData in server/auth.ts includes isVscodeOnboarding
    if (!(req.session as any).isVscodeOnboarding) { 
      log(`VSCode finalize: Not a VSCode onboarding flow for user ${req.user.id} or session flag missing. Redirecting to web app.`, 'auth-WARN');
      if (req.session) {
           delete (req.session as any).isVscodeOnboarding;
      }
      // It's important to save the session if a property is deleted.
      req.session.save(err => {
        if (err) { log(`Error saving session after deleting isVscodeOnboarding flag: ${err}`, 'auth-ERROR'); }
        return res.redirect(`${config.frontendUrl}/repos`); 
      });
      return; // Ensure no further code execution after redirect
    }

    if (!req.user.isProfileComplete) {
      log(`VSCode finalize: User ${req.user.id} profile still not complete. Redirecting back to web onboarding.`, 'auth-ERROR');
      if (req.session) {
           delete (req.session as any).isVscodeOnboarding;
      }
      req.session.save(err => {
        if (err) { log(`Error saving session for profile incomplete redirect: ${err}`, 'auth-ERROR'); }
        return res.redirect(`${config.frontendUrl}/auth?registration=true&from_vscode=true&error=profile_incomplete_after_onboarding`);
      });
      return; // Ensure no further code execution
    }

    log(`VSCode finalize: User ${req.user.id} completed web onboarding. Generating JWT.`, 'auth');
    
    if (!req.user.githubAccessToken) {
      log('CRITICAL: githubAccessToken missing on req.user during VSCode JWT finalization.', 'auth-ERROR');
      if (req.session) {
           delete (req.session as any).isVscodeOnboarding;
      }
      req.session.save(err => {
        if (err) { log(`Error saving session for missing token data redirect: ${err}`, 'auth-ERROR'); }
        return res.redirect(`vscode://roxonn.roxonn-code/auth?error=missing_token_data_finalize`);
      });
      return; // Ensure no further code execution
    }
    
    const jwtPayload: Express.User = { // Using Express.User type
      id: req.user.id,
      githubId: req.user.githubId,
      username: req.user.username,
      githubUsername: req.user.githubUsername,
      email: req.user.email,
      avatarUrl: req.user.avatarUrl,
      role: req.user.role,
      xdcWalletAddress: req.user.xdcWalletAddress,
      promptBalance: req.user.promptBalance ?? 0,
      isProfileComplete: req.user.isProfileComplete, // Should be true
      githubAccessToken: req.user.githubAccessToken,
      name: req.user.name, 
      walletReferenceId: req.user.walletReferenceId,
    };

    if (!config.sessionSecret) {
      log('CRITICAL: JWT secret (config.sessionSecret) is not defined. Cannot issue token for VSCode finalize.', 'auth-ERROR');
      if (req.session) {
           delete (req.session as any).isVscodeOnboarding;
      }
      req.session.save(err => {
        if (err) { log(`Error saving session for jwt secret missing redirect: ${err}`, 'auth-ERROR'); }
        return res.redirect(`vscode://roxonn.roxonn-code/auth?error=jwt_secret_missing_finalize`);
      });
      return; // Ensure no further code execution
    }

    const tokenOptions: SignOptions = { 
      expiresIn: '30d' // Using hardcoded value that worked in auth.ts
    };
    const token = jwt.sign(jwtPayload as object, config.sessionSecret, tokenOptions); 
    
    if (req.session) {
        delete (req.session as any).isVscodeOnboarding;
    }

    req.session.save(err => {
      if (err) {
        log(`Error saving session before final VSCode redirect: ${err}`, 'auth-ERROR');
        // Even if session save fails, attempt to redirect the user as the token is generated.
        // However, the session might not be cleaned up properly on the server.
      }
      const vscodeRedirectUrl = `vscode://roxonn.roxonn-code/auth?token=${token}`;
      log(`Redirecting fully onboarded VSCode user to: ${vscodeRedirectUrl}`, 'auth');
      return res.redirect(vscodeRedirectUrl);
    });
  });

  // Catch-all route for client-side routing
  // --- Unified Dual Currency Rewards System Routes ---

  // Approve ROXN spending for the unified rewards contract
  app.post('/api/blockchain/approve-roxn', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { amount } = req.body; // Spender is always the main rewards contract now
        if (!req.user) return res.status(401).json({ error: "User not authenticated" });
        if (!amount || typeof amount !== 'string') {
            return res.status(400).json({ error: "Missing amount" });
        }
        
        const spenderAddress = config.repoRewardsContractAddress.replace('xdc','0x'); // Unified contract address

        log(`User ${req.user.id} approving ${amount} ROXN for spender ${spenderAddress} (Unified System)`, 'routes-unified');
        const txResponse = await blockchain.approveTokensForContract(amount, req.user.id, spenderAddress);
        
        if (txResponse && txResponse.hash) {
            return res.json({ message: 'ROXN approval transaction submitted.', transactionHash: txResponse.hash });
        } else {
            log(`Error in /new-roxn/approve: Approval call completed but no transaction hash returned. Response: ${JSON.stringify(txResponse)}`, 'routes-new-roxn-ERROR');
            return res.status(500).json({ error: 'Failed to approve ROXN tokens', details: 'Approval succeeded but no transaction hash was returned.' });
        }
    } catch (error: any) {
        log(`Error in /new-roxn/approve: ${error.message}`, 'routes-new-roxn-ERROR');
        if (!res.headersSent) { // Ensure headers haven't been sent by another error handler
            res.status(500).json({ error: 'Failed to approve ROXN tokens', details: error.message });
        }
    }
  });

  // Get ROXN allowance for the unified rewards contract
  app.get('/api/blockchain/roxn-allowance', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!req.user || !req.user.xdcWalletAddress) {
        return res.status(401).json({ error: "User not authenticated or wallet address missing" });
      }
      const ownerAddress = req.user.xdcWalletAddress;
      const spenderAddress = config.repoRewardsContractAddress; // The unified rewards contract

      log(`Fetching ROXN allowance for owner ${ownerAddress} and spender ${spenderAddress}`, 'routes-unified');
      const allowanceWei = await blockchain.getRoxnAllowance(ownerAddress, spenderAddress);
      
      res.json({ allowance: allowanceWei.toString() }); // Return allowance in wei as a string
    } catch (error: any) {
      log(`Error fetching ROXN allowance: ${error.message}`, 'routes-unified-ERROR');
      res.status(500).json({ error: 'Failed to fetch ROXN allowance', details: error.message });
    }
  });

  // Fund a repository with ROXN (Unified System)
  // Path changed from /api/blockchain/new-roxn/fund/:repoId
  app.post('/api/blockchain/fund-roxn/:repoId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { repoId } = req.params;
        const validationResult = fundRoxnRepoSchema.safeParse(req.body);
        if (!validationResult.success) {
            return res.status(400).json({ error: "Invalid ROXN funding data", details: validationResult.error.format() });
        }
        const { roxnAmount } = validationResult.data;

        if (!req.user) return res.status(401).json({ error: "User not authenticated" });
        if (req.user.role !== 'poolmanager') {
            return res.status(403).json({ error: 'Only pool managers can fund with ROXN' });
        }

        log(`User ${req.user.id} attempting to fund repository ${repoId} with ${roxnAmount} ROXN (Unified System)`, 'routes-unified');
        const txResponse = await blockchain.addROXNFundToRepository( // Corrected method name
            parseInt(repoId),
            roxnAmount,
            req.user.id
        );
        res.json({ message: 'ROXN funding transaction submitted successfully.', transactionHash: txResponse?.hash });
    } catch (error: any) {
        log(`Error funding repository ${req.params.repoId} with ROXN (Unified System): ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to fund repository with ROXN', details: error.message });
    }
  });

  // Fund a repository with USDC (Unified System)
  app.post('/api/blockchain/fund-usdc/:repoId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { repoId } = req.params;
        const validationResult = fundUsdcRepoSchema.safeParse(req.body);
        if (!validationResult.success) {
            return res.status(400).json({ error: "Invalid USDC funding data", details: validationResult.error.format() });
        }
        const { usdcAmount } = validationResult.data;

        if (!req.user) return res.status(401).json({ error: "User not authenticated" });
        if (req.user.role !== 'poolmanager') {
            return res.status(403).json({ error: 'Only pool managers can fund with USDC' });
        }

        log(`User ${req.user.id} attempting to fund repository ${repoId} with ${usdcAmount} USDC (Unified System)`, 'routes-unified');
        const txResponse = await blockchain.addUSDCFundToRepository(
            parseInt(repoId),
            usdcAmount,
            req.user.id
        );
        res.json({ message: 'USDC funding transaction submitted successfully.', transactionHash: txResponse?.hash });
    } catch (error: any) {
        log(`Error funding repository ${req.params.repoId} with USDC (Unified System): ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to fund repository with USDC', details: error.message });
    }
  });

  // Allocate a bounty (XDC, ROXN, or USDC) to an issue (Unified System)
  // This replaces old /api/blockchain/repository/:repoId/issue/:issueId/reward 
  // and old /api/blockchain/new-roxn/allocate/:repoId/:issueId
  app.post('/api/blockchain/allocate-bounty/:repoId/:issueId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { repoId, issueId } = req.params;
        const validationResult = allocateUnifiedBountySchema.safeParse(req.body); 
        if (!validationResult.success) {
            return res.status(400).json({ error: "Invalid bounty allocation data", details: validationResult.error.format() });
        }
        // Ensure all necessary fields from allocateUnifiedBountySchema are used
        const { bountyAmount, currencyType, githubRepoFullName, issueTitle, issueUrl } = validationResult.data;


        if (!req.user) return res.status(401).json({ error: "User not authenticated" });
        if (req.user.role !== 'poolmanager') {
            return res.status(403).json({ error: 'Only pool managers can allocate bounties' });
        }
        
        log(`User ${req.user.id} attempting to allocate ${bountyAmount} ${currencyType} to issue ${issueId} in repo ${repoId} (Unified System)`, 'routes-unified');
        
        const result = await blockchain.allocateIssueReward( // This method in blockchain.ts now takes currencyType
            parseInt(repoId),
            parseInt(issueId),
            bountyAmount,
            currencyType, 
            req.user.id
        );

        if (githubRepoFullName && issueTitle && issueUrl) {
            log(`Attempting to send bounty notification for ${githubRepoFullName}#${issueId}`, 'zoho');
            import('./zoho.js').then(zoho => {
              zoho.sendBountyNotification(githubRepoFullName, parseInt(issueId), issueTitle, bountyAmount, issueUrl, currencyType === 'ROXN')
                .catch(err => log(`Failed to send bounty notification: ${err.message}`, 'zoho'));
            }).catch(err => log(`Error importing zoho module: ${err.message}`, 'zoho'));
        } else {
            log(`Skipping Zoho notification due to missing data in request body for issue ${issueId}`, 'zoho');
        }

        res.json({ message: `${currencyType} bounty allocation transaction submitted.`, transactionHash: result?.transactionHash, blockNumber: result?.blockNumber });
    } catch (error: any) {
        log(`Error allocating bounty for ${req.params.repoId}/#${req.params.issueId} (Unified System): ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to allocate bounty', details: error.message });
    }
  });

  // Distribute a bounty (Unified System)
  // Path changed from /api/blockchain/new-roxn/distribute/:repoId/:issueId
  // and replaces old /api/blockchain/repository/:repoId/issue/:issueId/distribute
  app.post('/api/blockchain/distribute-bounty/:repoId/:issueId', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { repoId, issueId } = req.params;
        const { contributorAddress } = req.body; 

        if (!contributorAddress || typeof contributorAddress !== 'string') {
            return res.status(400).json({ error: "Missing or invalid contributorAddress" });
        }
        if (!req.user) return res.status(401).json({ error: "User not authenticated" });
        if (req.user.role !== 'poolmanager') {
            return res.status(403).json({ error: 'Only pool managers can distribute bounties' });
        }

        log(`User ${req.user.id} attempting to distribute bounty for issue ${issueId} in repo ${repoId} to ${contributorAddress} (Unified System)`, 'routes-unified');
        const receipt = await blockchain.distributeReward( // This method in blockchain.ts is now for unified contract
            parseInt(repoId),
            parseInt(issueId),
            contributorAddress,
            req.user.id
        );
        res.json({ message: 'Bounty distribution transaction submitted successfully.', transactionHash: receipt?.hash });
    } catch (error: any) {
        log(`Error distributing bounty for ${req.params.repoId}/#${req.params.issueId} (Unified System): ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to distribute bounty', details: error.message });
    }
  });

  // Get unified pool info for a repository (replaces GET /api/blockchain/new-roxn/pool/:repoId)
  // and also effectively replaces GET /api/blockchain/repository/:repoId for pool info
  // Made PUBLIC: Removed requireAuth
  app.get('/api/blockchain/pool-info/:repoId', async (req: Request, res: Response) => {
    try {
        const { repoId } = req.params;
        log(`Fetching unified pool info for repo ${repoId} (public access)`, 'routes-unified');
        const poolInfo = await blockchain.getRepository(parseInt(repoId)); // getRepository now returns unified info
        res.json(poolInfo);
    } catch (error: any) {
        log(`Error fetching unified pool info for repo ${req.params.repoId}: ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to fetch pool info', details: error.message });
    }
  });

  // Diagnostic endpoint to check repository initialization status
  app.get('/api/blockchain/repository/:repoId/status', 
    securityMiddlewares.repoRateLimiter,
    securityMiddlewares.securityMonitor,
    async (req: Request, res: Response) => {
    try {
        const { repoId } = req.params;
        log(`Checking initialization status for repository ${repoId}`, 'routes-diagnostic');
        
        const status = await blockchain.checkRepositoryInitialization(parseInt(repoId));
        
        res.json({
            repoId: parseInt(repoId),
            ...status,
            recommendation: status.isInitialized ? 
                "Repository is ready for operations" : 
                "Repository needs initialization. Either add a pool manager or fund the repository to auto-initialize."
        });
    } catch (error: any) {
        log(`Error checking repository status: ${error.message}`, 'routes-diagnostic-ERROR');
        res.status(500).json({ error: 'Failed to check repository status', details: error.message });
    }
  });

  // Initialize repository endpoint (for pool managers)
  app.post('/api/blockchain/repository/:repoId/initialize', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    try {
        const { repoId } = req.params;
        
        if (!req.user || req.user.role !== 'poolmanager') {
            return res.status(403).json({ error: 'Only pool managers can initialize repositories' });
        }
        
        const userAddress = req.user.xdcWalletAddress;
        if (!userAddress) {
            return res.status(400).json({ error: 'User wallet address not found' });
        }
        
        log(`User ${req.user.id} attempting to initialize repository ${repoId}`, 'routes-init');
        
        const receipt = await blockchain.initializeRepository(
            parseInt(repoId),
            userAddress,
            req.user.username,
            parseInt(req.user.githubId),
            req.user.id
        );
        
        if (receipt) {
            res.json({ 
                message: 'Repository initialized successfully', 
                transactionHash: receipt.hash,
                poolManager: userAddress
            });
        } else {
            res.status(500).json({ error: 'Failed to initialize repository' });
        }
    } catch (error: any) {
        log(`Error initializing repository ${req.params.repoId}: ${error.message}`, 'routes-init-ERROR');
        res.status(500).json({ error: 'Failed to initialize repository', details: error.message });
    }
  });

  // Get unified bounty details for a specific issue (replaces GET /api/blockchain/new-roxn/issue/:repoId/:issueId)
  app.get('/api/blockchain/issue-bounty/:repoId/:issueId', async (req: Request, res: Response) => {
    try {
        const { repoId, issueId } = req.params;
        log(`Fetching unified bounty details for issue ${issueId} in repo ${repoId} (public access)`, 'routes-unified');
        const issueDetailsArray = await blockchain.getIssueRewards(parseInt(repoId), [parseInt(issueId)]); // getIssueRewards now returns IssueBountyDetails[]
        if (issueDetailsArray.length > 0) {
            res.json(issueDetailsArray[0]);
        } else {
            // It's possible an issue exists but has no bounty, or the issue ID is wrong.
            // The contract's getIssueRewards returns an array of Issue structs. If an issueId is not found in mapping, it's a zeroed struct.
            // The blockchain service maps this to IssueBountyDetails. An empty rewardAmountFormatted might mean no bounty.
            // Consider if 404 is right or if an object with "0.0" reward is better.
            // For now, if the array is empty (e.g. if getIssueRewards filters out zeroed structs), 404 is okay.
            // If it returns a zeroed struct mapped to IssueBountyDetails, then a 200 with that data is fine.
            // Current blockchain.getIssueRewards returns IssueBountyDetails[], so an empty array means no matching issues found by contract.
            res.status(404).json({ error: 'Bounty details not found for this issue or issue ID is invalid.' });
        }
    } catch (error: any) {
        log(`Error fetching unified bounty details for ${req.params.repoId}/#${req.params.issueId}: ${error.message}`, 'routes-unified-ERROR');
        res.status(500).json({ error: 'Failed to fetch bounty details', details: error.message });
    }
  });

  // --- End Unified Dual Currency Rewards System Routes ---

  // AI Project Scoping Agent routes
  app.use('/api/ai-scoping', aiScopingAgentRouter);

  // Multi-Currency Wallet routes
  app.use('/api/wallet', multiCurrencyWalletRoutes);

  // Referral system routes
  app.use('/api/referral', referralRoutes);
  
  // Promotional Bounties API routes
  app.use('/api/promotional', promotionalBountiesRoutes);

  // User Activity API - aggregates activity from multiple sources
  app.get('/api/user/activity', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const limit = parseInt(req.query.limit as string) || 10;
      const cappedLimit = Math.min(Math.max(limit, 1), 50);

      const activities = await activityService.getRecentActivity(user.id, cappedLimit);

      res.setHeader('Cache-Control', 'private, max-age=60');
      res.json({ activities });
    } catch (error: any) {
      log(`Error fetching user activity: ${error.message}`, 'activity-ERROR');
      res.status(500).json({ error: 'Failed to fetch user activity' });
    }
  });

  // --- Proof of Compute V1 Routes ---
  app.post('/api/node/dispatch-task', requireAuth, async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: 'Missing prompt' });
      }
      const result = await dispatchTask(prompt);
      res.json(result);
    } catch (error: any) {
      log(`Error dispatching task: ${error.message}`, 'proof-of-compute-ERROR');
      res.status(500).json({ error: 'Failed to dispatch task', details: error.message });
    }
  });

  app.post('/api/node/heartbeat', express.json(), async (req, res) => {
    const { node_id, wallet_address, ip_address, port } = req.body;
    if (!node_id || !wallet_address || !ip_address || !port) {
        return res.status(400).json({ error: 'Missing node_id, wallet_address, ip_address, or port' });
    }
    try {
        await handleHeartbeat(node_id, wallet_address, ip_address, port);
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to process heartbeat' });
    }
  });

  app.get('/api/node/status', requireAuth, async (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.xdcWalletAddress) {
        return res.status(400).json({ error: 'User wallet address not found.' });
      }
      const status = await getNodeStatus(user.xdcWalletAddress);
      res.json(status);
    } catch (error: any) {
      log(`Error fetching node status: ${error.message}`, 'proof-of-compute-ERROR');
      res.status(500).json({ error: 'Failed to fetch node status' });
    }
  });

  app.get('/api/nodes/status', requireAuth, async (req, res) => {
    try {
      const statuses = await getAllNodeStatuses();
      res.json(statuses);
    } catch (error: any) {
      log(`Error fetching all node statuses: ${error.message}`, 'proof-of-compute-ERROR');
      res.status(500).json({ error: 'Failed to fetch all node statuses' });
    }
  });

  app.get('/api/node/check-registration', async (req, res) => {
    const { nodeId } = req.query;
    if (!nodeId || typeof nodeId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid nodeId' });
    }
    try {
      const isRegistered = await blockchain.checkNodeRegistration(nodeId);
      res.json({ isRegistered });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check node registration' });
    }
  });

  app.post('/api/node/register', express.json(), async (req, res) => {
    const { nodeId, walletAddress } = req.body;
    if (!nodeId || !walletAddress) {
      return res.status(400).json({ error: 'Missing nodeId or walletAddress' });
    }
    try {
      const tx = await blockchain.registerNode(nodeId, walletAddress);
      res.json({ success: true, transactionHash: tx.hash });
    } catch (error) {
      res.status(500).json({ error: 'Failed to register node' });
    }
  });

  app.get('/api/node/compute-units', requireAuth, async (req, res) => {
    try {
      if (!req.user || !req.user.xdcWalletAddress) {
        return res.status(401).json({ error: 'User not authenticated or wallet address missing' });
      }
      const units = await blockchain.getComputeUnits(req.user.xdcWalletAddress);
      res.json({ computeUnits: units });
    } catch (error: any) {
      log(`Error fetching compute units: ${error.message}`, 'proof-of-compute-ERROR');
      res.status(500).json({ error: 'Failed to fetch compute units' });
    }
  });

  app.get("*", (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith("/api")) {
      return next();
    }
    
    // In development, let Vite handle it
    if (config.nodeEnv !== "production") {
      return next();
    }
    
    // In production, serve the index.html
    res.sendFile(resolve(__dirname, "../dist/public/index.html"));
  });
}

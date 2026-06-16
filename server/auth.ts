import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'; // Added for JWT Strategy
import { Request, Response, NextFunction } from "express";
import session from "express-session";
import jwt, { SignOptions } from 'jsonwebtoken'; // Import SignOptions
import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import type { Application } from "express";
import type { Profile } from "passport-github2";
import { generateWallet } from "./tatum";
import { blockchain } from "./blockchain";
import { log } from './utils';
import { getWalletSecret, storeWalletSecret } from "./aws";
import { createZohoLead } from "./zoho";
import { config } from "./config";
import { DatabaseStorage } from "./storage";
import crypto from "crypto";

// Initialize the database storage to get the session store
const storage = new DatabaseStorage();

// Extend session with returnTo property and CSRF token
declare module 'express-session' {
  interface SessionData {
    returnTo?: string;
    csrfToken?: string;
    authSource?: string; // Added for VSCode auth flow
    isVscodeOnboarding?: boolean; // Added for VSCode onboarding flow state
    privateAuthUpgrade?: boolean; // Added for private repo access upgrade flow
    hasPrivateRepoAccess?: boolean; // Added for private repo access check
  }
}

declare global {
  namespace Express {
    interface User {
      id: number;
      githubId: string;
      username: string;
      name: string | null;
      email: string | null;
      avatarUrl: string | null;
      role: "contributor" | "poolmanager" | null;
      githubUsername: string;
      isProfileComplete: boolean | null;
      xdcWalletAddress: string | null;
      walletReferenceId: string | null;
      githubAccessToken: string;
      promptBalance: number; // Changed from aiCredits
      hasPrivateRepoAccess?: boolean | null; // Added for private repo access check
    }
  }
}

// Admin check middleware — SECURITY: fail-closed, username-list, no hardcoded fallback.
// Returns 401 when unauthenticated, 503 when ADMIN_USERNAMES unset, 403 when not in list.
// The server MUST NOT crash at boot over admin misconfig (single-box prod, D-04) — 503 only.
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const adminUsernames = process.env.ADMIN_USERNAMES;
  if (!adminUsernames) {
    log('SECURITY WARNING: ADMIN_USERNAMES env var not set', 'admin-SECURITY');
    return res.status(503).json({ error: 'Admin access not configured' });
  }

  const admins = adminUsernames.split(',').map(u => u.trim().toLowerCase());
  if (!admins.includes(req.user.username.toLowerCase())) {
    log(`Admin access denied for user: ${req.user.username}`, 'admin-SECURITY');
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

// Inline helper for mixed-access routes where route-level requireAdmin would block
// legitimate non-admin users (e.g., poolmanagers who own the resource).
// Returns true ONLY when req.user is set AND ADMIN_USERNAMES is configured AND username matches.
// Never throws — always returns boolean.
export function isAdminUser(req: Request): boolean {
  if (!req.user) return false;
  const adminUsernames = process.env.ADMIN_USERNAMES;
  if (!adminUsernames) return false;
  const admins = adminUsernames.split(',').map(u => u.trim().toLowerCase());
  return admins.includes(req.user.username.toLowerCase());
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // For JWT authenticated requests, githubAccessToken might not be needed for all operations.
  // Consider if this check is always necessary or if some API routes (like AI completions)
  // might only need the userId from the JWT.
  // For now, keeping it as per existing logic.
  if (!req.user.githubAccessToken) {
    log('requireAuth: GitHub access token missing from req.user. This might be an issue for JWT-only flows if the token is not in the JWT payload.', 'auth');
    return res.status(401).json({ error: "GitHub token not available" });
  }
  next();
};

/**
 * Special middleware for VSCode extension endpoints that only require user authentication
 * without checking for GitHub access token. This is used for AI completions and other
 * endpoints that only need the JWT token with user info.
 * 
 * This version directly verifies the JWT token instead of relying on Passport strategy.
 */
/**
 * Profile type constants for display purposes
 * Internal: "contributor" = Developer, "poolmanager" = Client
 */
export const PROFILE_TYPES = {
  DEVELOPER: 'contributor',
  CLIENT: 'poolmanager',
} as const;

export const PROFILE_DISPLAY_NAMES = {
  contributor: 'Developer',
  poolmanager: 'Client',
} as const;

/**
 * Middleware factory to require a specific profile type (role)
 *
 * SECURITY: Always verifies role from database, never trusts client-side data
 *
 * @param allowedRoles - Array of allowed roles ('contributor' for Developer, 'poolmanager' for Client)
 * @returns Express middleware that checks user's role
 *
 * Usage:
 *   - requireRole(['contributor']) - Developer only endpoints (submit bounties, claim)
 *   - requireRole(['poolmanager']) - Client only endpoints (create bounties, fund pools)
 *   - requireRole(['contributor', 'poolmanager']) - Both roles allowed
 */
export const requireRole = (allowedRoles: Array<'contributor' | 'poolmanager'>) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Must be authenticated first
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    // User must have completed profile registration (role assigned)
    if (!req.user.role) {
      return res.status(403).json({
        error: 'Profile registration incomplete. Please complete your profile setup first.',
        code: 'PROFILE_INCOMPLETE'
      });
    }

    // SECURITY: Verify role from database, don't trust the session/JWT alone
    const dbUser = await db.query.users.findFirst({
      where: eq(users.id, req.user.id),
    });

    if (!dbUser) {
      log(`requireRole: User ${req.user.id} not found in database`, 'auth-ERROR');
      return res.status(401).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    if (!dbUser.role) {
      log(`requireRole: User ${req.user.id} has no role assigned`, 'auth-ERROR');
      return res.status(403).json({
        error: 'Profile registration incomplete. Please complete your profile setup first.',
        code: 'PROFILE_INCOMPLETE'
      });
    }

    // Check if user's role is in the allowed roles
    if (!allowedRoles.includes(dbUser.role as 'contributor' | 'poolmanager')) {
      const userDisplayRole = PROFILE_DISPLAY_NAMES[dbUser.role as keyof typeof PROFILE_DISPLAY_NAMES] || dbUser.role;
      const allowedDisplayRoles = allowedRoles.map(r => PROFILE_DISPLAY_NAMES[r]).join(' or ');

      log(`requireRole: User ${req.user.id} with role '${dbUser.role}' attempted to access ${allowedRoles.join('/')} only endpoint: ${req.method} ${req.path}`, 'auth-SECURITY');

      return res.status(403).json({
        error: `This action is only available for ${allowedDisplayRoles} accounts. Your account type is ${userDisplayRole}.`,
        code: 'ROLE_NOT_ALLOWED',
        userRole: dbUser.role,
        allowedRoles: allowedRoles
      });
    }

    // Update req.user.role to match database (in case session is stale)
    req.user.role = dbUser.role as 'contributor' | 'poolmanager';

    next();
  };
};

/**
 * Convenience middleware: Require Developer (contributor) role
 * Use for: Claiming bounties, submitting to bounties, joining teams
 */
export const requireDeveloper = requireRole([PROFILE_TYPES.DEVELOPER]);

/**
 * Convenience middleware: Require Client (poolmanager) role
 * Use for: Creating bounties, funding pools, creating promotional bounties
 */
export const requireClient = requireRole([PROFILE_TYPES.CLIENT]);

export const requireVSCodeAuth = async (req: Request, res: Response, next: NextFunction) => {
  // First check if we already have a user from passport
  if (req.user) {
    log(`VSCode auth: User already authenticated via Passport: ${req.user.id}`, 'vscode-auth');
    return next();
  }

  // If no user, try to authenticate directly from the token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    log('requireVSCodeAuth: No Bearer token found in Authorization header', 'vscode-auth');
    return res.status(401).json({ error: "Unauthorized - No token provided" });
  }

  // Extract token
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify the token
    const decoded = jwt.verify(token, config.sessionSecret!) as any; // Decoded payload will have 'id'
    log(`VSCode direct auth: Token verified for user ID: ${decoded.id}`, 'vscode-auth'); // Use decoded.id

    // Get user from database
    const user = await db.query.users.findFirst({
      where: eq(users.id, decoded.id), // Use decoded.id
    });

    if (!user) {
      log(`VSCode direct auth: User not found for ID: ${decoded.id}`, 'vscode-auth'); // Use decoded.id
      return res.status(401).json({ error: "Unauthorized - User not found" });
    }

    // Create authenticated user object and attach to request
    const authenticatedUser: Express.User = {
      id: user.id,
      githubId: user.githubId,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role as Express.User['role'],
      githubUsername: user.githubUsername,
      isProfileComplete: user.isProfileComplete,
      xdcWalletAddress: user.xdcWalletAddress,
      walletReferenceId: user.walletReferenceId,
      githubAccessToken: decoded.githubAccessToken,
      promptBalance: user.promptBalance ?? 0, // Use promptBalance, default to 0 if null/undefined
    };

    // Attach to request
    req.user = authenticatedUser;
    log(`VSCode direct auth successful for user ID: ${user.id}`, 'vscode-auth');

    // Continue
    next();
  } catch (error) {
    // Handle error with proper type checking
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`VSCode direct auth: JWT verification failed: ${errorMessage}`, 'vscode-auth');
    return res.status(401).json({ error: "Unauthorized - Invalid token" });
  }
};

// Generate a CSRF token
function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// CSRF protection middleware
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip CSRF check for authentication routes
  if (req.path.startsWith('/api/auth/github') || req.path.startsWith('/api/vscode/ai/completions')) { // Also skip for VSCode API if it uses Bearer token
    return next();
  }

  // For API requests that modify data, check the CSRF token
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const sessionToken = req.session.csrfToken;
    const requestToken = req.headers['x-csrf-token'] as string ||
      req.body._csrf as string;

    if (!sessionToken || !requestToken || sessionToken !== requestToken) {
      log(`CSRF token validation failed: ${req.method} ${req.path}`, 'auth');
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
  }

  next();
}

export function setupAuth(app: Application) {
  // D-04: One-time boot warning when ADMIN_USERNAMES is unset.
  // Admin endpoints will return 503 until the env var is configured, but the server stays up.
  if (!process.env.ADMIN_USERNAMES) {
    log('SECURITY WARNING: ADMIN_USERNAMES is not set — all admin endpoints are disabled until it is configured', 'admin-SECURITY');
  }

  // Session middleware
  app.use(
    session({
      secret: config.sessionSecret as string,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: true, // Always use secure cookies for HTTPS
        sameSite: 'none', // More secure default for non-production
        maxAge: 24 * 60 * 60 * 1000, // Reduced to 24 hours from 7 days for better security
        httpOnly: true,
        domain: config.cookieDomain, // Use the domain from config
        path: '/',
      },
      proxy: true, // Trust proxy in production
      store: storage.sessionStore, // Use PostgreSQL session store instead of MemoryStore
    })
  );

  // Initialize passport and session
  app.use(passport.initialize());
  app.use(passport.session());

  // Ensure CSRF tokens are generated for all authenticated sessions
  // This provides protection against CSRF attacks for session-based routes
  app.use((req, res, next) => {
    // Generate CSRF token for authenticated sessions that don't have one
    if (req.session && req.isAuthenticated && req.isAuthenticated() && !req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
      log(`Generated CSRF token for authenticated session`, 'auth');
    }
    next();
  });

  // Configure JWT Strategy for API authentication (e.g., for VSCode extension)
  const jwtOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: config.sessionSecret!, // Use the same secret as session and JWT signing
    passReqToCallback: true, // Pass request to callback for debugging
  };

  // Add a middleware to extract the raw token for debugging
  app.use((req, res, next) => {
    // Only debug JWT for VSCode endpoints and our debug route
    if (req.path.includes('/vscode/') || req.path.includes('/api/vscode/') || req.path.includes('/api/debug/jwt')) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7); // Remove 'Bearer ' prefix
        const tokenStart = token.substring(0, 20); // Get start of token for logging

        try {
          // Attempt to decode without verification for debugging
          const decoded = jwt.decode(token);
          log(`JWT debug - Token detected. Start: ${tokenStart}...`, 'jwt-debug');
          log(`JWT debug - Decoded payload: ${JSON.stringify(decoded)}`, 'jwt-debug');

          // Store raw token in request for debugging
          (req as any).rawJwtToken = token;
        } catch (e) {
          // Handle error with proper type checking
          const errorMessage = e instanceof Error ? e.message : String(e);
          log(`JWT debug - Failed to decode token: ${errorMessage}`, 'jwt-debug');
        }
      } else {
        log(`JWT debug - No Bearer token found in Authorization header`, 'jwt-debug');
      }
    }
    next();
  });

  passport.use(new JwtStrategy(jwtOptions as any, async (req: Request, jwt_payload: any, done: any) => {
    try {
      // jwt_payload will have 'id' from the token
      log(`JWT auth attempt with payload: id=${jwt_payload.id}`, 'auth');
      log(`JWT request path: ${req.path}`, 'jwt-debug');

      // jwt_payload contains the decoded JWT payload (id, email, etc.)
      const user = await db.query.users.findFirst({
        where: eq(users.id, jwt_payload.id), // Use jwt_payload.id
      });

      if (user) {
        log(`JWT auth: User found for id ${jwt_payload.id}`, 'auth'); // Use jwt_payload.id
        // Attach the full user object to req.user, similar to deserializeUser
        // Ensure the user object structure matches Express.User
        const authenticatedUser: Express.User = {
          id: user.id,
          githubId: user.githubId,
          username: user.username,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          role: user.role as Express.User['role'], // Cast role if necessary
          githubUsername: user.githubUsername,
          isProfileComplete: user.isProfileComplete,
          xdcWalletAddress: user.xdcWalletAddress,
          walletReferenceId: user.walletReferenceId,
          githubAccessToken: jwt_payload.githubAccessToken, // Get from JWT payload
          promptBalance: user.promptBalance ?? 0, // Use promptBalance, default to 0
        };
        return done(null, authenticatedUser);
      } else {
        log(`JWT auth: User not found for id ${jwt_payload.id}`, 'auth');
        return done(null, false);
      }
    } catch (error) {
      log(`JWT auth error: ${error}`, 'auth');
      return done(error, false);
    }
  }));

  // Passport serialization
  passport.serializeUser((user: Express.User, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, id),
      });
      if (!user) {
        return done(new Error("User not found"));
      }
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  // GitHub strategy
  passport.use(
    new GitHubStrategy(
      {
        clientID: config.githubClientId!,
        clientSecret: config.githubClientSecret!,
        callbackURL: config.githubCallbackUrl!,
      },
      async (
        accessToken: string,
        refreshToken: string,
        profile: Profile,
        done: (error: any, user?: Express.User | false) => void
      ) => {
        log(`GitHubStrategy: Processing profile for GitHub ID: ${profile.id}, Username: ${profile.username}`, 'auth-github-strategy');
        try {
          // Get user email from GitHub API if not available in profile
          let email = profile.emails?.[0]?.value || null;

          if (!email) {
            log(`GitHubStrategy: Email not in profile for ${profile.id}. Fetching from API...`, 'auth-github-strategy');
            try {
              const response = await fetch('https://api.github.com/user/emails', {
                headers: {
                  'Authorization': `token ${accessToken}`,
                  'Accept': 'application/json'
                }
              });
              log(`GitHubStrategy: Email API response status for ${profile.id}: ${response.status}`, 'auth-github-strategy');
              if (response.ok) {
                const emails = await response.json();
                const primaryEmail = emails.find((e: any) => e.primary);
                if (primaryEmail) {
                  email = primaryEmail.email;
                  log(`GitHubStrategy: Found primary email from API for ${profile.id}: ${email}`, 'auth-github-strategy');
                } else if (emails.length > 0) {
                  email = emails[0].email;
                  log(`GitHubStrategy: Using first email from API for ${profile.id}: ${email}`, 'auth-github-strategy');
                } else {
                  log(`GitHubStrategy: No emails returned from API for ${profile.id}`, 'auth-github-strategy');
                }
              } else {
                log(`GitHubStrategy: Failed to fetch emails from API for ${profile.id}: ${response.status}`, 'auth-github-strategy');
              }
            } catch (emailError: any) {
              log(`GitHubStrategy: Error fetching emails from API for ${profile.id}: ${emailError.message}`, 'auth-github-strategy');
              // Potentially return done(emailError) here if email is critical and fetch failed
            }
          } else {
            log(`GitHubStrategy: Email found in profile for ${profile.id}: ${email}`, 'auth-github-strategy');
          }

          log(`GitHubStrategy: Searching for existing user with GitHub ID: ${profile.id}`, 'auth-github-strategy');
          const existingUser = await db.query.users.findFirst({
            where: eq(users.githubId, profile.id),
          });

          if (existingUser) {
            log(`GitHubStrategy: Found existing user ID ${existingUser.id} for GitHub ID ${profile.id}. Updating...`, 'auth-github-strategy');
            const [updatedUser] = await db
              .update(users)
              .set({
                githubAccessToken: accessToken,
                name: profile.displayName || null,
                email: email, // Use fetched/profile email
                avatarUrl: profile.photos?.[0]?.value || null,
              })
              .where(eq(users.githubId, profile.id))
              .returning();
            log(`GitHubStrategy: User ID ${existingUser.id} updated.`, 'auth-github-strategy');

            // Ensure promptBalance are preserved or initialized if undefined on updatedUser
            let finalUser = updatedUser;
            // The schema now has `promptBalance` as notNull with default 0, so direct check for undefined might not be needed
            // if the DB record is always created correctly. However, good to be safe if old records might exist or for type consistency.
            if (finalUser && (finalUser.promptBalance === null || typeof finalUser.promptBalance === 'undefined')) {
              log(`GitHubStrategy: promptBalance is null/undefined for updated user ${finalUser.id}, ensuring it's set from existingUser.promptBalance (${existingUser.promptBalance}) or default 0.`, 'auth-github-strategy');
              const [userWithPromptBalance] = await db.update(users)
                .set({ promptBalance: existingUser.promptBalance ?? 0 })
                .where(eq(users.id, finalUser.id))
                .returning();
              finalUser = userWithPromptBalance;
            }
            log(`GitHubStrategy: Returning updated user ID ${finalUser.id} to Passport.`, 'auth-github-strategy');
            return done(null, finalUser);
          }

          log(`GitHubStrategy: No existing user for GitHub ID ${profile.id}. Creating new user...`, 'auth-github-strategy');
          const initialPrompts = config.newUserTrialPrompts || 0; // Assuming a config for trial prompts, or just 0
          log(`GitHubStrategy: Creating new user ${profile.username} with ${initialPrompts} initial prompts.`, 'auth-github-strategy');
          const [newUser] = await db
            .insert(users)
            .values({
              githubId: profile.id,
              username: profile.username || profile.displayName || `user${profile.id}`,
              name: profile.displayName || null,
              email: email, // Use fetched/profile email
              avatarUrl: profile.photos?.[0]?.value || null,
              githubUsername: profile.username || "",
              githubAccessToken: accessToken,
              isProfileComplete: false,
              role: null,
              promptBalance: initialPrompts, // Initialize promptBalance
            })
            .returning();
          log(`GitHubStrategy: New user created with ID ${newUser.id}. Returning to Passport.`, 'auth-github-strategy');
          return done(null, newUser);
        } catch (error: any) {
          log(`GitHubStrategy: ERROR during profile processing for GitHub ID ${profile.id}: ${error.message}`, 'auth-github-strategy-ERROR');
          log(`GitHubStrategy: Error stack: ${error.stack}`, 'auth-github-strategy-ERROR');
          return done(error); // Pass the error to Passport
        }
      }
    )
  );

  // Auth routes
  /**
   * @openapi
   * /api/auth/github:
   *   get:
   *     summary: Initiate GitHub authentication
   *     tags: [Authentication]
   *     parameters:
   *       - in: query
   *         name: returnTo
   *         schema: { type: string }
   *         description: URL to redirect to after successful login
   *       - in: query
   *         name: source
   *         schema: { type: string }
   *         description: Source of the auth request (e.g., 'vscode')
   *     responses:
   *       302:
   *         description: Redirect to GitHub
   */
  app.get("/api/auth/github", (req, res, next) => {
    // Safely extract and validate query parameters to prevent type confusion attacks
    // Express query params can be arrays if passed multiple times, so we ensure they're strings
    const rawReturnTo = req.query.returnTo;
    const rawSource = req.query.source;

    // Only accept string values, reject arrays or other types
    const returnTo = typeof rawReturnTo === 'string' ? rawReturnTo : undefined;
    const source = typeof rawSource === 'string' ? rawSource : undefined;

    // Create state for VSCode to maintain context through redirects without relying on session
    let state: string | undefined;

    if (source === 'vscode') {
      // For VSCode, use a stateless approach with a signed state parameter
      // Create a state object with source and returnTo
      const stateObj = { source, returnTo: returnTo || '/repos', timestamp: Date.now() };

      // Sign the state to prevent tampering
      if (config.sessionSecret) {
        state = jwt.sign(stateObj, config.sessionSecret, { expiresIn: '5m' });
        log(`VSCode auth: Using stateless flow with signed state`, 'auth');
      } else {
        log('CRITICAL: JWT secret is missing for state signing', 'auth');
      }

      // Still set session variables as backup
      req.session.authSource = source;
      log(`Auth initiated with source: ${source}`, 'auth');
    } else if (source) {
      // For non-VSCode sources, use session as before
      req.session.authSource = source;
      log(`Auth initiated with source: ${source}`, 'auth');
    } else {
      delete req.session.authSource;
    }

    if (returnTo) {
      const normalizedReturnTo = returnTo.startsWith('/') ? returnTo : `/${returnTo}`;
      if (normalizedReturnTo.includes('://') || normalizedReturnTo.startsWith('//')) {
        log(`Rejected potentially malicious returnTo URL: ${normalizedReturnTo}`, 'auth');
        req.session.returnTo = '/repos';
      } else {
        req.session.returnTo = normalizedReturnTo;
        log(`GitHub auth initiated with return URL: ${normalizedReturnTo}`, 'auth');
      }
    } else {
      req.session.returnTo = '/repos';
      log('GitHub auth initiated with default return URL: /repos', 'auth');
    }

    log(`GitHub auth config: clientID=${config.githubClientId}, callbackURL=${config.githubCallbackUrl}, BASE_URL=${config.baseUrl}`, 'auth');
    log(`Full GitHub callback URL: ${config.githubCallbackUrl}`, 'auth');
    log(`Request origin: ${req.headers.origin || 'unknown'}`, 'auth');
    log(`Request referer: ${req.headers.referer || 'unknown'}`, 'auth');

    // Add state parameter to GitHub authentication if available
    const authOptions: any = {
      scope: ["user:email", "public_repo", "read:org"]
    };

    if (state) {
      authOptions.state = state;
    }

    passport.authenticate("github", authOptions)(req, res, next);
  });

  app.get('/api/auth/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.get(
    "/api/auth/callback/github",
    passport.authenticate("github", {
      failureRedirect: `${config.frontendUrl}/auth?error=authentication_failed`,
      failureMessage: true
    }),
    async (req: Request, res: Response) => { // Added async here
      // --- START MODIFIED SECTION ---
      if (!req.user) {
        log('GitHub callback: User not authenticated by Passport. Redirecting to error.', 'auth-ERROR');
        return res.redirect(`${config.frontendUrl}/auth?error=authentication_failed`);
      }

      let actualSource: string | undefined;
      let stateDataFromJwt: any = null;
      const stateQueryParam = req.query.state as string;

      if (stateQueryParam && config.sessionSecret) {
        try {
          stateDataFromJwt = jwt.verify(stateQueryParam, config.sessionSecret) as any;
          if (stateDataFromJwt && stateDataFromJwt.source) {
            actualSource = stateDataFromJwt.source;
            log(`Using source from JWT state parameter: ${actualSource}`, 'auth');
          }
        } catch (err: any) {
          log(`Invalid or expired state JWT parameter: ${err.message}. State: ${stateQueryParam}`, 'auth');
          // If state verification fails for VSCode flow, it's a problem.
          // Check if the original source (from JWT or session) was 'vscode'.
          const tempSource = req.session.authSource || (stateDataFromJwt && stateDataFromJwt.source);
          if (tempSource === 'vscode') {
            log('Error verifying state JWT for VSCode flow. Redirecting to web error page.', 'auth');
            // Redirect to a web error page instead of vscode:// to show a message
            return res.redirect(`${config.frontendUrl}/auth?error=invalid_state&message=${encodeURIComponent(err.message)}`);
          }
          // For web flow, can be less strict or simply fall back to session source.
        }
      }

      if (!actualSource && req.session.authSource) {
        actualSource = req.session.authSource;
        log(`Using source from session: ${actualSource}`, 'auth');
      }

      // Defer deleting req.session.authSource until after routing logic if it's not 'vscode'

      if (!req.user.githubAccessToken) {
        log('CRITICAL: githubAccessToken missing on req.user. Auth flow issue.', 'auth-ERROR');
        return res.redirect(`${config.frontendUrl}/auth?error=missing_token_data`);
      }

      // Handle private repository access upgrade
      if (req.session.privateAuthUpgrade) {
        log(`Upgrading user ${req.user.id} to private repo access`, 'auth');

        try {
          await db.update(users)
            .set({
              hasPrivateRepoAccess: true,
              githubPrivateAccessToken: req.user.githubAccessToken
            })
            .where(eq(users.id, req.user.id));

          log(`Successfully upgraded user ${req.user.id} to private repo access`, 'auth');

          const returnTo = req.session.returnTo || '/repositories?upgraded=true';
          delete req.session.privateAuthUpgrade;
          delete req.session.returnTo;

          req.session.save((err) => {
            if (err) {
              log(`Error saving session after private upgrade: ${err}`, 'auth-ERROR');
            }
            return res.redirect(`${config.frontendUrl}${returnTo}`);
          });
          return;
        } catch (error) {
          log(`Error upgrading user ${req.user.id} to private access: ${error}`, 'auth-ERROR');
          return res.redirect(`${config.frontendUrl}/repositories?error=upgrade_failed`);
        }
      }

      if (actualSource === 'vscode') {
        if (!req.user.isProfileComplete) {
          log(`New VSCode user ${req.user.id} needs onboarding. Redirecting to web.`, 'auth');
          req.session.isVscodeOnboarding = true;
          // req.session.vscodeOriginalReturnTo = stateDataFromJwt?.returnTo; // Optional: if you need to pass original returnTo from VSCode
          req.session.save(err => {
            if (err) {
              log(`Error saving session for VSCode web onboarding redirect: ${err}`, 'auth-ERROR');
              return res.redirect(`${config.frontendUrl}/auth?error=session_error_vscode_onboarding`);
            }
            const webOnboardingUrl = `${config.frontendUrl}/auth?registration=true&from_vscode=true`;
            log(`Redirecting new VSCode user to web onboarding: ${webOnboardingUrl}`, 'auth');
            return res.redirect(webOnboardingUrl);
          });
        } else {
          // Existing, fully onboarded VSCode user
          log(`Existing VSCode user ${req.user.id} is fully onboarded. Generating JWT.`, 'auth');
          const jwtPayload: Express.User = { // Using Express.User type
            id: req.user.id, // Corrected from userId to id
            githubId: req.user.githubId,
            username: req.user.username,
            githubUsername: req.user.githubUsername,
            email: req.user.email,
            avatarUrl: req.user.avatarUrl,
            role: req.user.role,
            xdcWalletAddress: req.user.xdcWalletAddress,
            promptBalance: req.user.promptBalance ?? 0,
            isProfileComplete: req.user.isProfileComplete,
            githubAccessToken: req.user.githubAccessToken,
            name: req.user.name, // Ensure all fields from Express.User are present
            walletReferenceId: req.user.walletReferenceId,
          };

          if (!config.sessionSecret) {
            log('CRITICAL: JWT secret (config.sessionSecret) is not defined. Cannot issue token for VSCode.', 'auth-ERROR');
            // Clean up session flags before redirecting to an error state
            delete req.session.isVscodeOnboarding;
            delete req.session.authSource;
            req.session.save(saveErr => {
              if (saveErr) { log(`Error saving session during JWT secret missing error: ${saveErr}`, 'auth-ERROR'); }
              return res.redirect(`vscode://roxonn.roxonn-code/auth?error=jwt_secret_missing_config`);
            });
            return; // Important to return after starting a response
          }

          // Ensure jwtPayload is treated as a plain object for jwt.sign
          const plainPayload = { ...jwtPayload };
          const tokenOptions: SignOptions = {
            expiresIn: '30d' // Hardcode for testing, was config.jwtExpiresInVSCode 
          };
          const token = jwt.sign(plainPayload, config.sessionSecret, tokenOptions); // Use checked config.sessionSecret and typed options
          const vscodeRedirectUrl = `vscode://roxonn.roxonn-code/auth?token=${token}`;
          log(`Redirecting existing VSCode user to: ${vscodeRedirectUrl}`, 'auth');
          delete req.session.isVscodeOnboarding; // Clean up if somehow set
          delete req.session.authSource; // Clean up session authSource
          req.session.save(err => {
            if (err) { log(`Error saving session for VSCode JWT redirect: ${err}`, 'auth-ERROR'); }
            return res.redirect(vscodeRedirectUrl);
          });
        }
      } else {
        // Standard web flow
        let returnTo = req.session.returnTo || '/repos';
        delete req.session.returnTo;
        delete req.session.authSource; // Clean up session authSource for web flow

        log(`GitHub callback for web flow. User: ${req.user.username}, Profile Complete: ${req.user.isProfileComplete}. Redirecting to: ${returnTo}`, 'auth');

        if (!returnTo.startsWith('/')) returnTo = `/${returnTo}`;
        if (returnTo.includes('://') || returnTo.startsWith('//')) returnTo = '/repos'; // Security check

        if (!req.user.isProfileComplete) {
          const webOnboardingUrl = `${config.frontendUrl}/auth?registration=true`;
          log(`Redirecting new web user to onboarding: ${webOnboardingUrl}`, 'auth');
          return res.redirect(webOnboardingUrl);
        }

        const finalRedirectUrl = `${config.frontendUrl}${returnTo}`;
        log(`Redirecting web user to: ${finalRedirectUrl}`, 'auth');
        // Cookies for web app
        res.cookie('connect.sid.check', 'authenticated', { domain: config.cookieDomain, path: '/', secure: true, sameSite: 'none', maxAge: 24 * 60 * 60 * 1000, httpOnly: false });
        res.cookie('auth_success', 'true', { domain: config.cookieDomain, path: '/', secure: true, sameSite: 'none', maxAge: 60 * 60 * 1000 });
        if (!req.session.csrfToken) req.session.csrfToken = generateCsrfToken(); // Ensure CSRF token

        req.session.save((err) => {
          if (err) { log(`Error saving session for web redirect: ${err}`, 'auth-ERROR'); }
          return res.redirect(finalRedirectUrl);
        });
      }
      // --- END MODIFIED SECTION ---
    }
  );

  function sanitizeUserData(user: any) { // Moved sanitizeUserData here to be within scope if not already global
    if (!user) return null;
    const { xdcWalletMnemonic, xdcPrivateKey, encryptedPrivateKey, encryptedMnemonic, githubAccessToken, ...sanitizedUser } = user;
    return sanitizedUser;
  }

  /**
   * @openapi
   * /api/auth/user:
   *   get:
   *     summary: Get current authenticated user
   *     tags: [Authentication]
   *     security:
   *       - cookieAuth: []
   *     responses:
   *       200:
   *         description: User profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/User'
   *       401:
   *         description: Unauthorized
   */
  app.get("/api/auth/user", (req: Request, res: Response) => {
    res.cookie('session_test', 'true', {
      secure: true,
      sameSite: 'none',
      domain: config.cookieDomain,
      maxAge: 60 * 60 * 1000,
    });

    log(`Auth user request - Session ID: ${req.sessionID || 'none'}`, 'auth');
    log(`Auth user request - User: ${req.user ? 'authenticated' : 'not authenticated'}`, 'auth');
    log(`Auth user request - Cookies: ${JSON.stringify(req.cookies)}`, 'auth');
    log(`Auth user request - Origin: ${req.headers.origin}`, 'auth');
    log(`Auth user request - CORS headers: ${JSON.stringify({
      'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Credentials': res.getHeader('Access-Control-Allow-Credentials'),
    })}`, 'auth');

    res.json(sanitizeUserData(req.user) || null);
  });

  app.get("/api/auth/session", (req: Request, res: Response) => {
    log(`Session debug - Session ID: ${req.sessionID || 'none'}`, 'auth');
    log(`Session debug - User: ${req.user ? 'authenticated' : 'not authenticated'}`, 'auth');
    log(`Session debug - Cookies: ${JSON.stringify(req.cookies)}`, 'auth');

    res.json({
      sessionId: req.sessionID || null,
      isAuthenticated: !!req.user,
      cookies: req.cookies,
    });
  });

  /**
   * @openapi
   * /api/auth/logout:
   *   post:
   *     summary: Logout user
   *     tags: [Authentication]
   *     security:
   *       - cookieAuth: []
   *     responses:
   *       200:
   *         description: Logout successful
   */
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.logout(() => {
      res.json({ success: true });
    });
  });

  // Private repository access upgrade endpoints
  app.get("/api/auth/private-access-status", requireAuth, (req: Request, res: Response) => {
    res.json({
      hasPrivateAccess: req.user?.hasPrivateRepoAccess || false
    });
  });

  app.get("/api/auth/github/upgrade-private", requireAuth, (req, res, next) => {
    // Store return URL in session
    const returnTo = req.query.returnTo as string;
    req.session.privateAuthUpgrade = true;
    req.session.returnTo = returnTo || '/repositories?upgraded=true';

    log(`Private repo upgrade initiated for user: ${req.user?.username}`, 'auth');

    // Request expanded scope for private repo access
    const privateAuthOptions = {
      scope: ["user:email", "repo", "read:org"]
    };

    passport.authenticate("github", privateAuthOptions)(req, res, next);
  });

  app.post("/api/auth/register", requireAuth, async (req, res) => {
    try {
      const { role, email: submittedEmail } = req.body;

      if (!role || !["contributor", "poolmanager"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      const email = submittedEmail || req.user?.email;

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: "Valid email address is required" });
      }

      if (req.user && req.user.xdcWalletAddress) {
        return res.status(400).json({
          error: "User already has a wallet",
          address: req.user.xdcWalletAddress
        });
      }

      log("Creating XDC wallet for user...", "auth");
      let wallet;
      try {
        wallet = await generateWallet();
        log("Wallet created successfully", "auth");
      } catch (walletError: any) {
        log(`Failed to create wallet: ${walletError.message}`, "auth");
        return res.status(500).json({
          error: "Failed to create wallet",
          details: walletError.message
        });
      }

      log("Registering user on blockchain...", "auth");
      try {
        if (req.user) {
          await blockchain.registerUser(
            req.user.githubUsername,
            parseInt(req.user.githubId),
            role,
            wallet.address
          );
        }
        log("User registered on blockchain successfully", "auth");

      } catch (blockchainError: any) { // This catch block is for the original blockchain.registerUser
        log(`Blockchain registration failed (XDC System): ${blockchainError.message}`, "auth");
        return res.status(500).json({
          error: "Failed to register on XDC blockchain system",
          details: blockchainError.message
        });
      }

      try {
        if (req.user) {
          const [updatedUser] = await db
            .update(users)
            .set({
              role,
              email,
              xdcWalletAddress: wallet.address,
              walletReferenceId: wallet.referenceId,
              isProfileComplete: true,
            })
            .where(eq(users.id, req.user.id))
            .returning();

          req.user.role = role;
          req.user.email = email;
          req.user.isProfileComplete = true;
          req.user.xdcWalletAddress = wallet.address;
          req.user.walletReferenceId = wallet.referenceId;

          try {
            const walletData = await getWalletSecret(wallet.referenceId);
            if (walletData) {
              await storeWalletSecret(wallet.referenceId, walletData);
              log("Wallet data properly stored in user record", "auth");
            }
          } catch (walletStorageError) {
            log(`Warning: Failed to ensure wallet data storage: ${walletStorageError}`, "auth");
          }

          log("User registration completed successfully with email: " + email, "auth");

          try {
            createZohoLead({
              username: req.user.username,
              name: req.user.name,
              email: email,
              githubId: req.user.githubId,
              role: role,
              xdcWalletAddress: wallet.address
            }).catch(error => {
              log(`Error sending user data to Zoho CRM: ${error}`, "auth");
            });
          } catch (error) {
            log(`Failed to initialize Zoho lead creation: ${error}`, "auth");
          }

          res.json({
            success: true,
            user: {
              ...req.user,
              role,
              email,
              isProfileComplete: true,
              xdcWalletAddress: wallet.address,
              walletReferenceId: wallet.referenceId,
            },
          });
        }
      } catch (dbError: any) {
        log(`Database update failed: ${dbError.message}`, "auth");
        return res.status(500).json({
          error: "Failed to update user data",
          details: dbError.message
        });
      }
    } catch (error: any) {
      log(`Registration error: ${error.message}`, "auth");
      res.status(500).json({
        error: "Registration failed",
        details: error.message,
      });
    }
  });
}

import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import helmet from 'helmet';

// Get directory path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Always use server/.env regardless of environment
const envPath = resolve(process.cwd(), 'server/.env');

dotenvConfig({ path: envPath });

import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import passport from "passport";
import { registerRoutes } from "./routes";
import { setupVite } from "./vite";
import { serveStatic, log } from "./utils";
// swagger-ui-express not used - serving custom HTML with CDN assets instead
import { swaggerSpec } from './swagger';
import { setupAuth, requireAuth } from './auth';
import { generateWallet } from './tatum';
import { db, users } from './db';
import { eq } from 'drizzle-orm';
import { createServer } from 'http';
import { walletService } from './walletService';
import cookieParser from 'cookie-parser';
import { config, initializeConfig, validateConfig } from './config';
import rateLimit from 'express-rate-limit';
import { updateOfflineNodes } from './services/exoNodeService';
import { verifyAndSecureContainers } from './azure-media';
import { startCommunityBountyRelayer } from './communityBountyRelayer';

// Initialize the app but don't start it yet
const app = express();
const server = createServer(app);

// Trust proxy - needed for X-Forwarded-For headers when behind Nginx
// Use 1 to trust first proxy (nginx) - more secure than 'true'
app.set('trust proxy', 1);

// Add helmet middleware with CSP configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "connect-src": ["'self'", "https://api.roxonn.com", "https://salesiq.zohopublic.in", "https://rpc.ankr.com"], // Allow self, API, Zoho, and Ankr XDC RPC
      // Allow GTM, inline scripts, Zoho scripts, and Onramp SDK
      "script-src": ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://salesiq.zohopublic.in", "https://js.zohocdn.com", "https://static.zohocdn.com", "https://cdn.skypack.dev", "https://unpkg.com"],
      // Allow inline styles, Google Fonts, Zoho styles, and Video.js CDN
      "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'", "https://css.zohocdn.com", "https://static.zohocdn.com", "https://vjs.zencdn.net", "https://api.fontshare.com", "https://unpkg.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "https://css.zohocdn.com", "https://static.zohocdn.com", "https://vjs.zencdn.net"], // Allow Google Fonts, Zoho fonts, and Video.js fonts
      // Allow images from self, data URLs, and GitHub avatars
      "img-src": ["'self'", "data:", "https://avatars.githubusercontent.com", "https://images.pexels.com", "https://api.dicebear.com", "https://static.zohocdn.com", "https://css.zohocdn.com", "https://images.unsplash.com"],
      // Allow media files from Zoho and Azure Blob Storage for course videos
      "media-src": ["'self'", "https://static.zohocdn.com", "https://blobvideohostcoursepage.blob.core.windows.net"],
      // Allow iframes from Onramp.money for payment widget
      "frame-src": ["'self'", "https://onramp.money", "https://*.onramp.money"]
    }
  }
}));

// Create a safer header handling middleware
app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;

  // Create a safer wrapper for setHeader that handles errors gracefully
  res.setHeader = function (name, value) {
    try {
      // Try to set the header
      const result = originalSetHeader.call(this, name, value);

      // Log successful CORS header setting
      if (name.toLowerCase().startsWith('access-control')) {
        log(`Set header successfully: ${name}=${value}`, 'cors-debug');
      }

      return result;
    } catch (error) {
      // Log the error but don't throw it
      log(`Warning: Unable to set header ${name}=${value}: ${error}`, 'cors-debug');

      // Return this to maintain chaining
      return this;
    }
  };

  next();
});

// Enhanced header debugging middleware
app.use((req, res, next) => {
  // Log headers before any CORS processing
  log(`[BEFORE] Request to ${req.method} ${req.path} from origin: ${req.headers.origin}`, 'cors-debug');

  // Original end override
  const originalEnd = res.end;
  // @ts-ignore - Overriding the end method to log headers
  res.end = function (chunk, encoding, callback) {
    // Log all headers before sending response
    const headers = res.getHeaders();
    log(`[FINAL] Response headers for ${req.method} ${req.path}: ${JSON.stringify(headers)}`, 'cors-debug');

    if (headers['access-control-allow-origin']) {
      log(`CORS Origin header value: ${headers['access-control-allow-origin']}`, 'cors-debug');
    }

    return originalEnd.call(this, chunk, encoding, callback);
  };

  next();
});

// Add middleware to prevent duplicate CORS headers
app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;

  // @ts-ignore - Overriding the setHeader method to prevent duplicate CORS headers
  res.setHeader = function (name, value) {
    const lowerCaseName = name.toLowerCase();

    // If it's a CORS header and it's already set, don't set it again
    if (lowerCaseName.startsWith('access-control-') && res.getHeader(name)) {
      log(`BLOCKED duplicate CORS header: ${name} = ${value}`, 'cors-debug');
      log(`Existing value: ${res.getHeader(name)}`, 'cors-debug');
      return this;
    }

    return originalSetHeader.call(this, name, value);
  };

  next();
});

// Configure Express
app.use(cors({
  // Use a function for origin to handle undefined origins (common with VSCode extensions)
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, VSCode extensions)
    if (!origin) {
      log(`Allowing request with no origin (VSCode extension request)`, 'cors-debug');
      return callback(null, true);
    }

    // Check against allowed origins
    const allowedOrigins = [
      'https://app.roxonn.com',  // Web app
      /^vscode-webview:\/\/.*/,  // VSCode webviews (using regex for wildcard)
      /^vscode-file:\/\/.*/     // VSCode file protocol
    ];

    // Check if the origin matches any of the allowed origins (including regex patterns)
    const allowed = allowedOrigins.some(allowedOrigin => {
      if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return allowedOrigin === origin;
    });

    if (allowed) {
      log(`Allowing request from origin: ${origin}`, 'cors-debug');
      return callback(null, origin);
    } else {
      log(`Blocking request from unauthorized origin: ${origin}`, 'cors-debug');
      return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature', 'X-Hub-Signature-256', 'X-CSRF-Token', 'Origin', 'Accept'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // Cache preflight requests for 1 day
}));

// Special middleware for handling OPTIONS requests (preflight) without origin headers
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    log(`Processing OPTIONS request for path: ${req.path}`, 'cors-debug');
    // Ensure CORS headers are set for OPTIONS requests even without origin
    if (!req.headers.origin && req.path.includes('/vscode/') || req.path.includes('/api/vscode/')) {
      log(`Setting CORS headers for VSCode OPTIONS request without origin`, 'cors-debug');
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Max-Age', '86400');
      return res.status(204).send();
    }
  }
  next();
});

// Use cookie-parser middleware
app.use(cookieParser());

// Add CORS debugging middleware
app.use((req, res, next) => {
  // Log CORS-related headers
  const corsDebug = {
    origin: req.headers.origin,
    method: req.method,
    path: req.path,
    corsHeaders: {
      'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
      'Access-Control-Allow-Credentials': res.getHeader('Access-Control-Allow-Credentials'),
      'Access-Control-Allow-Methods': res.getHeader('Access-Control-Allow-Methods'),
      'Access-Control-Allow-Headers': res.getHeader('Access-Control-Allow-Headers')
    }
  };

  log(`CORS Debug: ${JSON.stringify(corsDebug)}`, 'cors');

  // Continue with the request
  next();
});

// Handle webhook routes before any body parsing
app.use((req, res, next) => {
  if (req.path.includes('/webhook')) {
    return next();
  }
  express.json()(req, res, next);
});

app.use(express.urlencoded({ extended: true }));

// Add cookie debugging middleware
app.use((req, res, next) => {
  log(`Request path: ${req.path}`, 'cookies');
  log(`Request cookies: ${JSON.stringify(req.cookies)}`, 'cookies');
  log(`Request session ID: ${req.sessionID || 'none'}`, 'cookies');
  log(`Request user: ${req.user ? 'authenticated' : 'not authenticated'}`, 'cookies');

  next();
});

// Add JWT token debugging middleware
app.use((req, res, next) => {
  // Only log for VSCode endpoints
  if (req.path.includes('/vscode/') || req.path.includes('/api/vscode/')) {
    log(`JWT Debug - Path: ${req.path}`, 'jwt-debug');

    // Log Authorization header safely (obfuscate the actual token)
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2) {
        const [scheme, token] = parts;
        const tokenLength = token.length;
        const obfuscatedToken = `${token.substring(0, 10)}...${token.substring(tokenLength - 10)}`;
        log(`JWT Debug - Auth header present. Scheme: ${scheme}, Token length: ${tokenLength}`, 'jwt-debug');
        log(`JWT Debug - Token prefix: ${obfuscatedToken}`, 'jwt-debug');
      } else {
        log(`JWT Debug - Malformed Authorization header: ${authHeader}`, 'jwt-debug');
      }
    } else {
      log(`JWT Debug - No Authorization header present`, 'jwt-debug');
    }
  }

  next();
});

// Setup auth (must be after express.json and cors)
// setupAuth(app) is called after config initialization, but ensure we have passport initialized
// Add this here so that even before full auth setup, we have passport initialized for JWT
app.use(passport.initialize());

// Logging middleware for API routes
app.use("/api", (req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
    if (capturedJsonResponse) {
      logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
    }

    if (logLine.length > 80) {
      logLine = logLine.slice(0, 79) + "…";
    }

    log(logLine);
  });

  next();
});

// Protected API routes middleware
app.use('/api/profile', requireAuth);
// NOTE: Registration route is handled in auth.ts with proper middleware

// Configure rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 50 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests from this IP, please try again after 15 minutes'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply rate limiting to auth endpoints
app.use('/api/auth/', authLimiter);

// Stricter rate limiting for blockchain operations
const blockchainLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // Limit each IP to 20 blockchain requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many blockchain operations, please try again after 5 minutes'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply blockchain rate limiting
app.use('/api/blockchain/', blockchainLimiter);

// Rate limiting for VSCode API endpoints
const vscodeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests from this IP, please try again after 1 minute'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply VSCode rate limiting (both with and without /api prefix)
app.use('/api/vscode/', vscodeLimiter);
app.use('/vscode/', vscodeLimiter);

// Rate limiting for node/compute API endpoints
const nodeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many node API requests, please try again after 1 minute'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply node rate limiting
app.use('/api/node/', nodeLimiter);

// Rate limiting for subscription/payment endpoints (stricter to prevent abuse)
const subscriptionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many subscription requests, please try again later'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply subscription rate limiting
app.use('/api/subscription/', subscriptionLimiter);

// Rate limiting for admin endpoints
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many admin requests, please try again later'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply admin rate limiting
app.use('/api/admin/', adminLimiter);

// Rate limiting for webhook endpoints (prevent abuse while allowing legitimate traffic)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute (webhooks can be bursty)
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many webhook requests, please try again later'
    });
  },
  skip: (req) => config.nodeEnv === 'development', // Skip rate limiting in development
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply webhook rate limiting
app.use('/webhook/', webhookLimiter);

// Rate limiting for static assets and catch-all routes (lenient)
const staticLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // Limit each IP to 300 requests per minute for static assets
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later'
    });
  },
  skip: (req) => {
    // Skip for API routes (they have their own rate limiters)
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/') || req.path.startsWith('/vscode/')) {
      return true;
    }
    // Skip in development
    return config.nodeEnv === 'development';
  },
  keyGenerator: (req) => req.ip as string, // Use req.ip with 'trust proxy'
});

// Apply static/catch-all rate limiting (must be before catch-all routes)
app.use(staticLimiter);

// Health check endpoint for ALB
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Register API routes
// registerRoutes(app);  // Will be called after config initialization

// Swagger UI is set up inside startServer() to ensure proper route order

// Configure Vite middleware for development if not in production
// ... existing code ...

// Start the server asynchronously to allow for config initialization
async function startServer() {
  try {
    // Initialize configuration from Parameter Store
    await initializeConfig();

    // Validate configuration if using environment variables
    validateConfig();

    // Verify and secure Azure blob containers for course videos
    if (config.azureStorageAccount && config.azureStorageKey) {
      try {
        await verifyAndSecureContainers();
        log('Azure container security verification completed successfully', 'server');
      } catch (error) {
        log(`⚠️  Azure container security verification failed: ${error}`, 'server-WARN');
        log('Server will continue but video access may be insecure!', 'server-WARN');
        // Don't throw - allow server to start but log the warning
      }
    } else {
      log('Azure storage not configured - skipping container verification', 'server');
    }

    // Log configuration info
    log(`Using AWS region: ${config.awsRegion || 'not set'}`, 'server');
    log(`Environment: ${config.nodeEnv}`, 'server');

    // Setup authentication with the initialized config
    setupAuth(app);

    // Register API routes
    registerRoutes(app);

    // Swagger UI - custom endpoints to avoid esbuild bundling issues with swagger-ui-express
    // Serve swagger spec as JSON
    app.get('/api/docs/swagger.json', (req, res) => {
      res.json(swaggerSpec);
    });

    // Serve custom HTML that loads swagger-ui from CDN
    app.get('/api/docs', (req, res) => {
      res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Roxonn API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/swagger.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout'
    });
  </script>
</body>
</html>`);
    });

    // Configure Vite or static file serving
    if (config.nodeEnv !== 'production') {
      // Set up Vite middleware for development
      await setupVite(app, server);
    } else {
      // Serve static files in production
      serveStatic(app);
    }

    // Start listening on port
    const PORT = config.port;
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      log(`Server listening on port ${PORT}`, 'server');
      log(`Base URL: ${config.baseUrl}`, 'server');
      log(`Frontend URL: ${config.frontendUrl}`, 'server');
    });

    // Schedule the job to update offline nodes every minute
    setInterval(async () => {
      try {
        await updateOfflineNodes();
        log('Successfully updated offline nodes.', 'cron');
      } catch (error) {
        log(`Error updating offline nodes: ${error}`, 'cron-ERROR');
      }
    }, 60 * 1000);

    // Start community bounty relayer service (processes claimed bounties)
    // WHY: Verifies PR merges and completes bounty payouts on-chain
    // Now runs every 5 minutes as backup (webhooks are primary)
    startCommunityBountyRelayer();

    // Start gas monitoring service
    // WHY: Monitors relayer wallet balance and sends email alerts when low
    // Checks every 5 minutes, alerts at 10 XDC (warning) and 5 XDC (critical)
    const { gasMonitor } = await import('./services/gasMonitor');
    const { FEATURE_FLAGS } = await import('./config');
    if (FEATURE_FLAGS.GAS_MONITORING_ENABLED) {
      gasMonitor.startMonitoring();
      log('Gas monitoring service started', 'blockchain');
    }

    // Handle graceful shutdown
    setupShutdownHandlers();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Call the async function to start the server
startServer();

// Setup shutdown handlers
function setupShutdownHandlers() {
  // ... existing shutdown code ...

  // Handle shutdown signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Graceful shutdown function
async function shutdown(signal: string) {
  log(`Received ${signal}. Shutting down gracefully...`);

  // Close the HTTP server
  server.close(() => {
    log('HTTP server closed.');
  });

  try {
    // Stop gas monitoring service
    const { gasMonitor } = await import('./services/gasMonitor');
    gasMonitor.stopMonitoring();
    log('Gas monitoring service stopped');

    // Close any database connections or other resources
    await walletService.destroy();
    log('Resources closed.');

    // Exit the process
    process.exit(0);
  } catch (error) {
    log(`Error during shutdown: ${error}`);
    process.exit(1);
  }
}

import { Router, Request, Response } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { log } from '../utils';
import { config } from '../config';
import { blockchain } from '../blockchain';
import { db } from '../db';
import { courseAssignments } from '../../shared/schema';
import { submitAssignmentSchema } from '@shared/schema';
import { activityService } from '../services/activityService';
import { exchangeCodeForRefreshToken, getZohoAuthUrl, isZohoConfigured } from '../zoho';
import { storage } from '../storage';

const router = Router();

// Health check endpoint for AWS ALB
router.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Zoho CRM Integration Routes
router.get("/api/zoho/auth", (req, res) => {
  if (!isZohoConfigured()) {
    return res.status(500).json({ error: "Zoho CRM is not configured" });
  }

  // Redirect to Zoho authorization page
  const authUrl = getZohoAuthUrl();
  res.redirect(authUrl);
});

// Zoho OAuth callback handler
router.get("/api/zoho/auth/callback", async (req, res) => {
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

// Get course videos with subscription gating
router.get('/api/courses/:courseId/videos', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const courseId = req.params.courseId;

    // Import services
    const { subscriptionService } = await import('../subscriptionService');
    const { getCourseVideoUrlsWithGating, isCourseValid } = await import('../azure-media');

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
router.get('/api/courses/:courseId/resources/:resourceType', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { courseId, resourceType } = req.params;

    // Import services
    const { subscriptionService } = await import('../subscriptionService');
    const { getCourseResourceUrl, isCourseValid } = await import('../azure-media');

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
router.post('/api/submit-assignment', requireAuth, csrfProtection, async (req, res) => {
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

// Token-specific endpoints
router.get("/api/token/balance", requireAuth, async (req: Request, res: Response) => {
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

// User Activity API - aggregates activity from multiple sources
router.get('/api/user/activity', requireAuth, async (req: Request, res: Response) => {
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

// Protected profile routes
router.patch("/api/profile", requireAuth, csrfProtection, async (req, res) => {
  const { updateProfileSchema } = await import('@shared/schema');
  const { storage } = await import('../storage');
  
  const result = updateProfileSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid profile data" });
  }

  try {
    // Since this route uses requireAuth middleware, we know req.user exists
    const updatedUser = await storage.updateProfile(req.user!.id, result.data);
    
    // Sanitize user data to remove sensitive information
    function sanitizeUserData(user: any) {
      if (!user) return null;
      const { xdcWalletMnemonic, xdcPrivateKey, encryptedPrivateKey, encryptedMnemonic, githubAccessToken, ...sanitizedUser } = user;
      return sanitizedUser;
    }
    
    // Sanitize user data before sending to client
    res.json(sanitizeUserData(updatedUser));
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(400).json({ error: "Failed to update profile" });
  }
});

export default router;


import { Router } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { storage } from '../storage';
import { log } from '../utils';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { users } from '../../shared/schema';
import { db } from '../db';

const router = Router();

// Rate limiter for account deletion (1 request per hour in production, 10 per hour in development)
// Uses per-user rate limiting instead of IP to handle multiple users behind same IP (VPNs, corporate networks)
const deleteAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'production' ? 1 : 10, // Limit to 1 request per hour in prod, 10 in dev
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID as the key for per-user rate limiting
    // If for any reason the user is not authenticated, throw an error
    // since rate limiting is only needed for authenticated users
    if (!req.user?.id) {
      throw new Error('Rate limiter called for unauthenticated user');
    }
    return req.user.id.toString();
  },
  message: {
    error: 'Too many account deletion requests, please try again after an hour'
  }
});

// Rate limiter for email preferences updates (30 requests per hour per user in production, 60 in development)
const emailPreferencesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'production' ? 30 : 60, // Limit to 30 email preference changes per hour in prod, 60 in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many email preference update requests, please try again after an hour'
  }
});

// POST /api/user/delete-account - Delete user account
router.post('/delete-account', deleteAccountLimiter, requireAuth, csrfProtection, async (req, res) => {
  try {
    const { confirmUsername } = req.body;
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!confirmUsername) {
      return res.status(400).json({ error: 'Username confirmation is required' });
    }

    // Get the current user's username for comparison
    const currentUser = await storage.getUserById(userId);
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify that the provided username matches the current user's username
    if (!currentUser.username || confirmUsername.toLowerCase() !== currentUser.username.toLowerCase()) {
      return res.status(400).json({ error: 'Username confirmation does not match' });
    }

    // First, delete the user account (this will cascade delete related data)
    // Will throw an error if user has wallet assets (prevents accidental fund loss)
    try {
      const success = await storage.deleteUser(userId);

      if (!success) {
        return res.status(404).json({ error: 'User not found' });
      }

      // After successful user deletion, clean up the session
      // Note: We prioritize account deletion over session cleanup. Even if session cleanup fails,
      // the account is permanently deleted and subsequent authentication attempts will fail.
      // This approach prevents leaving users in a state where their account is deleted but
      // they're still logged in with an active session.
      let logoutError: Error | null = null;
      await new Promise<void>((resolve) => {
        req.logout((err) => {
          if (err) {
            logoutError = err as Error;
            log(`Error logging out user after account deletion: ${err}`, 'session');
            // Continue with session destruction even if logout fails - account deletion is prioritized
          }
          resolve();
        });
      });

      // Then destroy the session to completely log out the user
      let sessionDestroyError: Error | null = null;
      await new Promise<void>((resolve) => {
        req.session.destroy((err) => {
          if (err) {
            sessionDestroyError = err as Error;
            log(`Error destroying session after account deletion: ${err}`, 'session');
            // Continue anyway despite session destruction error - account deletion is prioritized
          }
          resolve();
        });
      });

      // Log any session cleanup issues but continue since account deletion succeeded
      if (logoutError && sessionDestroyError) {
        log(`WARNING: Both logout and session destruction failed for user ${userId} after deletion. User may remain logged in until session expires.`, 'session');
      } else if (logoutError) {
        log(`WARNING: Logout failed for user ${userId} after deletion. Session may remain active until expiration.`, 'session');
      } else if (sessionDestroyError) {
        log(`WARNING: Session destruction failed for user ${userId} after deletion. User may remain logged in until session expires.`, 'session');
      }

      log(`User account deleted and session cleared successfully: ${userId}`, 'user-deletion');
      res.json({ success: true, message: 'Account deleted successfully' });
    } catch (error) {
      // Handle cases where user has wallet assets
      log(`Error deleting user account: ${error instanceof Error ? error.message : String(error)}`, 'user-deletion');
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Error deleting account'
      });
    }
  } catch (error) {
    log(`Error deleting user account: ${error instanceof Error ? error.message : String(error)}`, 'user-deletion');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/user/email-preferences - Update email preferences
router.patch('/email-preferences', emailPreferencesLimiter, requireAuth, csrfProtection, async (req, res) => {
  try {
    const { optOut } = req.body;
    const userId = req.user?.id;
    
    if (userId === undefined) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (optOut === undefined) {
      return res.status(400).json({ error: 'optOut field is required' });
    }

    if (typeof optOut !== 'boolean') {
      return res.status(400).json({ error: 'optOut must be a boolean value' });
    }

    // Update the user's email_opt_out preference
    const [updatedUser] = await db.update(users)
      .set({ emailOptOut: optOut })
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'Email preferences updated successfully',
      optOut: updatedUser.emailOptOut
    });
  } catch (error) {
    log(`Error updating user email preferences: ${error instanceof Error ? error.message : String(error)}`, 'email-preferences');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/user/email-preferences - Get email preferences
router.get('/email-preferences', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (userId === undefined) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get the user's email_opt_out preference
    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ 
      optOut: user.emailOptOut || false 
    });
  } catch (error) {
    log(`Error getting user email preferences: ${error instanceof Error ? error.message : String(error)}`, 'email-preferences');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
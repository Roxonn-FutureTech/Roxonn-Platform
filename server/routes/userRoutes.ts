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
const deleteAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'production' ? 1 : 10, // Limit to 1 request per hour in prod, 10 in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many account deletion requests, please try again after an hour'
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
    if (confirmUsername.toLowerCase() !== currentUser.username.toLowerCase()) {
      return res.status(400).json({ error: 'Username confirmation does not match' });
    }

    // Delete the user account (this will cascade delete related data)
    // Will throw an error if user has wallet assets (prevents accidental fund loss)
    try {
      const success = await storage.deleteUser(userId);

      if (!success) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Clear the user's session first
      req.logout((err) => {
        if (err) {
          log(`Error logging out user after account deletion: ${err}`, 'session');
          // Continue with session destruction even if logout fails
        }

        // Destroy the session and send response only after session is destroyed
        req.session.destroy((err) => {
          if (err) {
            log(`Error destroying session after account deletion: ${err}`, 'session');
            // Still send success response even if session destruction fails
          }

          log(`User account deleted successfully: ${userId}`, 'user-deletion');
          res.json({ success: true, message: 'Account deleted successfully' });
        });
      });
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
router.patch('/email-preferences', requireAuth, async (req, res) => {
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
      emailOptOut: updatedUser.emailOptOut
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
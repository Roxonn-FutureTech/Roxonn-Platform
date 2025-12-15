import { Router, Request, Response } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { log } from '../utils';

const router = Router();

// Admin user ID constant - platform admin
const ADMIN_USER_ID = 1;

// Admin: Get all pending subscription payments
router.get('/admin/subscription/pending', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check if user is admin (user ID 1 is the platform admin)
    if (user.id !== ADMIN_USER_ID) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Import services
    const { db } = await import('../db');
    const { onrampTransactions, TransactionStatus } = await import('../../shared/schema');
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
router.post('/admin/subscription/verify/:orderId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check admin access (user ID 1 is the platform admin)
    if (user.id !== ADMIN_USER_ID) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { orderId } = req.params;
    const { userId: targetUserId } = req.body;

    if (!orderId || !targetUserId) {
      return res.status(400).json({ error: 'Order ID and User ID required' });
    }

    // Import verification service
    const { paymentVerificationService } = await import('../paymentVerificationService');

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
router.get('/admin/onramp/order/:orderId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check admin access (user ID 1 is the platform admin)
    if (user.id !== ADMIN_USER_ID) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { orderId } = req.params;

    // Import Onramp service
    const { onrampCryptoService } = await import('../onrampCryptoService');

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
router.get('/admin/verification-log', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check admin access (user ID 1 is the platform admin)
    if (user.id !== ADMIN_USER_ID) {
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

export default router;


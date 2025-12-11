import { Router, Request, Response } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { log } from '../utils';
import { onrampService } from '../onrampService';
import { TransactionStatus } from '../../shared/schema';
import { db } from '../db';
import { onrampTransactions } from '../../shared/schema';
import { eq } from 'drizzle-orm';

const router = Router();

// Initialize merchant payment (Tatum Onramp Merchant Widget)
router.post('/merchant/init', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Import subscription service
    const { onrampMerchantService } = await import('../onrampMerchant');
    const { onrampService } = await import('../onrampService');
    const { TransactionStatus } = await import('../../shared/schema');

    // Get parameters from request body
    const fiatType = req.body.fiatType ? parseInt(req.body.fiatType) : undefined;
    const logoUrl = req.body.logoUrl;

    // Build merchant checkout config with user's selected currency
    const config = await onrampMerchantService.buildMerchantCheckoutConfig(user.id, fiatType, logoUrl);

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
        timestamp: new Date().toISOString(),
      },
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
      details: errorMessage,
    });
  }
});

/**
 * @openapi
 * /api/subscription/crypto/init:
 *   post:
 *     summary: Initialize crypto payment for subscription
 *     tags: [Subscriptions]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chainId: { type: string }
 *               language: { type: string }
 *     responses:
 *       200:
 *         description: Crypto payment intent
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       401:
 *         description: Unauthorized
 */
router.post('/crypto/init', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Import crypto service
    const { onrampCryptoService } = await import('../onrampCryptoService');

    // Get optional network selection (default to Polygon)
    const chainId = req.body.chainId || '3'; // Default to Polygon (chainId 3)
    const language = req.body.language || 'en';

    // Validate network
    if (!onrampCryptoService.isValidNetwork(chainId)) {
      return res.status(400).json({
        error: 'Invalid network selection',
        details: `Network ${chainId} is not supported`,
      });
    }

    // Create crypto payment intent
    const intent = await onrampCryptoService.createCryptoIntent(user.id, chainId, language);

    log(`Generated crypto payment intent for user ${user.id}, Network: ${onrampCryptoService.getNetworkName(chainId)}`, 'subscription');
    res.json(intent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error initializing crypto payment:', error);
    log(`Error initializing crypto payment: ${errorMessage}`, 'subscription-ERROR');
    log(`Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'subscription-ERROR');
    res.status(500).json({
      error: 'Failed to initialize crypto payment',
      details: errorMessage,
    });
  }
});

// Get list of supported networks for crypto payment
router.get('/crypto/networks', async (req, res) => {
  try {
    const { SUPPORTED_CRYPTO_NETWORKS } = await import('../onrampCryptoService');
    res.json(SUPPORTED_CRYPTO_NETWORKS);
  } catch (error) {
    console.error('Error fetching crypto networks:', error);
    res.status(500).json({ error: 'Failed to fetch crypto networks' });
  }
});

// Get list of supported currencies for subscription payment
router.get('/currencies', async (req, res) => {
  try {
    const { getAllCurrencies, getPopularCurrencies } = await import('../currencyConfig');

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

/**
 * @openapi
 * /api/subscription/status:
 *   get:
 *     summary: Get current subscription status
 *     tags: [Subscriptions]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Subscription status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Subscription'
 *       401:
 *         description: Unauthorized
 */
router.get('/status', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Import subscription service
    const { subscriptionService } = await import('../subscriptionService');

    // Get subscription status
    const status = await subscriptionService.getSubscriptionStatus(user.id);

    res.json({
      active: status.active,
      periodEnd: status.periodEnd,
      subscription: status.subscription
        ? {
            id: status.subscription.id,
            plan: status.subscription.plan,
            status: status.subscription.status,
            currentPeriodStart: status.subscription.currentPeriodStart,
            currentPeriodEnd: status.subscription.currentPeriodEnd,
          }
        : undefined,
    });
  } catch (error) {
    console.error('Error getting subscription status:', error);
    log(`Error getting subscription status: ${error}`, 'subscription-ERROR');
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Manual payment verification endpoint
router.post('/verify-payment', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Import verification service
    const { paymentVerificationService } = await import('../paymentVerificationService');

    // Get verification parameters
    const { orderId, txHash, referenceId, timestamp } = req.body;

    // Perform verification
    const result = await paymentVerificationService.verifyPayment(user.id, {
      orderId,
      txHash,
      referenceId,
      timestamp,
    });

    // Return appropriate response
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        subscription: result.subscription,
      });
    } else if (result.needsConfirmation) {
      res.json({
        success: false,
        needsConfirmation: true,
        transaction: result.transaction,
        message: result.message,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    log(`Error verifying payment: ${error}`, 'verification-ERROR');
    res.status(500).json({
      error: 'Failed to verify payment',
      message: 'An unexpected error occurred. Please try again or contact support.',
    });
  }
});

// Get user's pending payments
router.get('/pending-payments', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Import verification service
    const { paymentVerificationService } = await import('../paymentVerificationService');

    // Get pending payments
    const pendingPayments = await paymentVerificationService.getUserPendingPayments(user.id);

    res.json({
      success: true,
      payments: pendingPayments,
    });
  } catch (error) {
    console.error('Error getting pending payments:', error);
    log(`Error getting pending payments: ${error}`, 'verification-ERROR');
    res.status(500).json({
      error: 'Failed to get pending payments',
    });
  }
});

// Confirm payment verification (for timestamp-based verification)
router.post('/confirm-verification', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { transactionId, confirm } = req.body;

    if (!confirm) {
      return res.json({
        success: false,
        message: 'Verification cancelled',
      });
    }

    // Import services
    const { db } = await import('../db');
    const { onrampTransactions } = await import('../../shared/schema');
    const { eq } = await import('drizzle-orm');

    // Verify transaction belongs to user
    const transaction = await db.query.onrampTransactions.findFirst({
      where: eq(onrampTransactions.id, transactionId),
    });

    if (!transaction || transaction.userId !== user.id) {
      return res.status(403).json({
        error: 'Invalid transaction',
      });
    }

    // For confirmed timestamp verification, we need additional proof
    // User should provide either orderId or txHash
    const { orderId, txHash } = req.body;

    if (!orderId && !txHash) {
      return res.status(400).json({
        error: 'Please provide Order ID or Transaction Hash to confirm',
      });
    }

    // Re-verify with the additional proof
    const { paymentVerificationService } = await import('../paymentVerificationService');
    const result = await paymentVerificationService.verifyPayment(user.id, {
      orderId,
      txHash,
    });

    res.json(result);
  } catch (error) {
    console.error('Error confirming verification:', error);
    log(`Error confirming verification: ${error}`, 'verification-ERROR');
    res.status(500).json({
      error: 'Failed to confirm verification',
    });
  }
});

export default router;


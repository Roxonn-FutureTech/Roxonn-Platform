import { Router, Request, Response } from 'express';
import express from 'express';
import { IncomingMessage } from 'http';
import crypto from 'crypto';
import { Webhooks } from '@octokit/webhooks';
import { config } from '../config';
import { log } from '../utils';
import { storage } from '../storage';
import { db } from '../db';
import { onrampService } from '../onrampService';
import {
  parseBountyCommand,
  handleBountyCommand,
  handleIssueClosed,
} from '../github';

const router = Router();

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
      const installationId = (payload as any).installation?.id;
      log(`Installation event received: ${payload.action}, installation ${installationId}`, 'webhook-app');
      // TODO: Implement storage.upsert/remove for installation tracking
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

// Webhook endpoint for Onramp.money transaction updates
router.post('/api/webhook/onramp-money', express.json({
  verify: (req: IncomingMessage, res, buf) => {
    // Store the raw body for signature verification
    (req as any).rawBody = buf;
  }
}), async (req, res) => {
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
        log(`No user found for Onramp.money transaction (merchantId: ${merchantRecognitionId})`);
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
    const { onrampMerchantService } = await import('../onrampMerchant');
    const { subscriptionService } = await import('../subscriptionService');

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
            // Log error and return error status to allow webhook retries
            const errorMsg = activationError instanceof Error ? activationError.message : String(activationError);
            log(`❌ CRITICAL: Failed to activate subscription for user ${userId}`, 'subscription-ERROR');
            log(`Error details: ${errorMsg}`, 'subscription-ERROR');
            log(`Payment info: merchantId=${merchantRecognitionId}, orderId=${orderId}, txHash=${txHash}, amount=${amountUsdc}`, 'subscription-ERROR');

            // Return 500 to indicate failure and allow webhook provider to retry
            return res.status(500).json({
              error: 'Subscription activation failed',
              message: errorMsg,
              merchantRecognitionId,
              orderId
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

// New GitHub App webhook endpoint
router.post('/webhook/github/app', express.raw({ type: 'application/json' }), handleGitHubAppWebhook);

export default router;


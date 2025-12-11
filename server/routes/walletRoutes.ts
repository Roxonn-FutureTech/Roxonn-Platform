import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { IncomingMessage } from 'http';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { requireAuth, csrfProtection } from '../auth';
import { blockchain } from '../blockchain';
import { config } from '../config';
import { log } from '../utils';
import { onrampService } from '../onrampService';
import { TransactionStatus } from '../../shared/schema';
import { WalletService } from '../walletService';
import { transferLimits, DAILY_TRANSFER_LIMIT } from '../transfer-limits';
import { encryptWithSharedSecret, deriveSharedSecret, getServerPublicKey } from '../ecdh';
import { sendOtpEmail } from '../email';
import { db } from '../db';

const router = Router();

// Cache for tracking wallet export requests (to implement rate limiting)
const exportRequestCache = new Map<number, { timestamp: number, count: number }>();

// In-memory OTP store: userId -> { code, expires }
const otpStore = new Map<number, { code: string; expires: number }>();

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

/**
 * @openapi
 * /api/wallet/info:
 *   get:
 *     summary: Get wallet information
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Wallet information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WalletInfo'
 *       401:
 *         description: Unauthorized
 */
router.get('/info', requireAuth, csrfProtection, async (req, res) => {
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

/**
 * @openapi
 * /api/wallet/limits:
 *   get:
 *     summary: Get wallet transfer limits
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Transfer limits
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usedAmount: { type: number }
 *                 remainingLimit: { type: number }
 *                 dailyLimit: { type: number }
 *                 resetTime: { type: string, format: date-time }
 *       401:
 *         description: Unauthorized
 */
router.get('/limits', requireAuth, csrfProtection, async (req, res) => {
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

/**
 * @openapi
 * /api/wallet/transactions:
 *   get:
 *     summary: Get recent wallet transactions
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: List of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Transaction'
 *       401:
 *         description: Unauthorized
 */
router.get('/transactions', requireAuth, csrfProtection, async (req, res) => {
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

/**
 * @openapi
 * /api/wallet/buy-xdc-url:
 *   get:
 *     summary: Generate Onramp.money URL for buying USDC on XDC
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Onramp URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *       401:
 *         description: Unauthorized
 */
router.get('/buy-xdc-url', requireAuth, csrfProtection, async (req, res) => {
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

/**
 * @openapi
 * /api/wallet/sell-xdc-url:
 *   get:
 *     summary: Generate Onramp.money URL for selling USDC on XDC
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Offramp URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *       401:
 *         description: Unauthorized
 */
router.get('/sell-xdc-url', requireAuth, csrfProtection, async (req, res) => {
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

// Get onramp.money transactions for user wallet
router.get('/onramp-transactions', requireAuth, csrfProtection, async (req, res) => {
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

// Endpoint to request an OTP for wallet export
router.post('/export-request', requireAuth, csrfProtection, async (req: Request, res: Response) => {
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

// Wallet export endpoint for MetaMask integration
router.post('/export-data', requireAuth, csrfProtection, requireOtp, async (req: Request, res: Response) => {
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
      serverPublicKey: await getServerPublicKey(),
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

/**
 * @openapi
 * /api/wallet/send:
 *   post:
 *     summary: Send XDC funds to another address
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - toAddress
 *               - amount
 *             properties:
 *               toAddress: { type: string }
 *               amount: { type: string }
 *     responses:
 *       200:
 *         description: Transaction submitted successfully
 *       400:
 *         description: Invalid input or insufficient funds
 *       401:
 *         description: Unauthorized
 */
router.post('/send', requireAuth, csrfProtection, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { toAddress, amount } = req.body;

    if (!toAddress || !amount) {
      return res.status(400).json({ error: 'Recipient address and amount are required' });
    }

    // Robust address validation (Checksum)
    let checksumAddress: string;
    try {
      // Normalize 'xdc' prefix to '0x' for ethers compatibility
      let addressToValidate = toAddress;
      if (addressToValidate.toLowerCase().startsWith('xdc')) {
        addressToValidate = '0x' + addressToValidate.substring(3);
      }
      checksumAddress = ethers.getAddress(addressToValidate);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid recipient address format' });
    }

    // Parse amount
    let sendAmount: bigint;
    try { // Check transfer limits
      sendAmount = ethers.parseEther(amount.toString());
      if (sendAmount <= BigInt(0)) {
        throw new Error('Amount must be positive');
      }
    } catch (e) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check transfer limits
    const limitCheck = transferLimits.checkTransferLimit(user.id.toString(), parseFloat(ethers.formatEther(sendAmount)));
    if (!limitCheck.allowed) {
      return res.status(400).json({ error: limitCheck.reason || 'Transfer limit exceeded' });
    }

    log(`User ${user.id} initiating send of ${ethers.formatEther(sendAmount)} XDC`, 'routes'); // Log without PII (recipient)

    // Send funds using blockchain service
    // Note: blockchain service expects 0x address, checksumAddress is 0x prefixed
    const tx = await blockchain.sendFunds(user.id, checksumAddress, sendAmount);

    // Record transfer for limits
    transferLimits.recordTransfer(user.id.toString(), parseFloat(ethers.formatEther(sendAmount)));

    res.json({
      success: true,
      txHash: tx.hash,
      message: 'Transaction submitted successfully'
    });

  } catch (error: any) {
    // Log safe error message internally
    log(`Error sending funds for user ${req.user?.id}: ${error?.message || 'Unknown error'}`, 'routes');

    const errorMessage = error.message || 'Failed to send funds';

    // Handle insufficient funds specifically but generic message
    if (errorMessage.includes('Insufficient') || errorMessage.includes('gas')) {
      return res.status(400).json({ error: 'Insufficient funds or gas for transaction' });
    }

    // Generic error for client
    res.status(500).json({ error: 'Transaction failed. Please try again later.' });
  }
});

export default router;



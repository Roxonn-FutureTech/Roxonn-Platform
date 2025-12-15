import { Router } from 'express';
import { requireAuth } from '../auth';
import { log } from '../utils';
import { walletService } from '../walletService';
import { db } from '../db';
import { users } from '../../shared/schema';
import { eq } from 'drizzle-orm';
// Import security patches
import { validateRepoPayload, repoRateLimiter, sanitizeRepoPayload, securityMonitor } from '../security/patches';

const router = Router();

// Apply security middleware to all routes
router.use(securityMonitor);
router.use(repoRateLimiter);
router.use(sanitizeRepoPayload);

interface WalletBalance {
  currency: string;
  network: string;
  balance: string;
  usdValue?: string;
  address: string;
}

/**
 * Get single XDC wallet balances for a user
 * GET /api/wallet/multi-currency-balances/:userId
 */
/**
 * @openapi
 * /api/wallet/multi-currency-balances/{userId}:
 *   get:
 *     summary: Get single XDC wallet balances for a user
 *     tags: [Wallet]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of wallet balances
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/WalletBalance'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Access denied
 *       404:
 *         description: User not found
 */
router.get('/multi-currency-balances/:userId', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    // Verify user can access this data (either themselves or a pool manager checking their contributors)
    if (req.user?.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    log(`Fetching XDC wallet balances for user ${userId}`, 'wallet-api');

    // Get user's XDC wallet address
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        xdcWalletAddress: true,
        walletReferenceId: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const balances: WalletBalance[] = [];

    // XDC Network balances (XDC, ROXN, and USDC)
    if (user.xdcWalletAddress) {
      try {
        // Get XDC balance
        const xdcBalance = await walletService.getNetworkBalance(user.xdcWalletAddress, 'xdc');
        balances.push({
          currency: 'XDC',
          network: 'XDC',
          balance: xdcBalance,
          address: user.xdcWalletAddress
        });

        // Get ROXN balance (if applicable)
        const roxnBalance = await walletService.getTokenBalance('xdc', user.xdcWalletAddress, 'ROXN');
        if (roxnBalance) {
          balances.push({
            currency: 'ROXN',
            network: 'XDC',
            balance: roxnBalance,
            address: user.xdcWalletAddress
          });
        }

        // Get USDC balance on XDC
        const usdcBalance = await walletService.getUSDCBalance(user.xdcWalletAddress);
        if (usdcBalance) {
          balances.push({
            currency: 'USDC',
            network: 'XDC',
            balance: usdcBalance,
            address: user.xdcWalletAddress
          });
        }
      } catch (error) {
        log(`Error fetching XDC balances: ${error}`, 'wallet-api');
      }
    }

    log(`Retrieved ${balances.length} balances for user ${userId}`, 'wallet-api');
    res.json(balances);

  } catch (error) {
    log(`Error fetching XDC wallet balances: ${error}`, 'wallet-api');
    res.status(500).json({ error: 'Failed to fetch wallet balances' });
  }
});

/**
 * Get supported currencies and networks
 * GET /api/wallet/supported-currencies
 */
/**
 * @openapi
 * /api/wallet/supported-currencies:
 *   get:
 *     summary: Get supported currencies and networks
 *     tags: [Wallet]
 *     responses:
 *       200:
 *         description: Supported currencies configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 currencies:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       network: { type: string }
 *                       chainId: { type: integer }
 *                       nativeCurrency: { type: object }
 *                 supportedTokens:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       symbol: { type: string }
 *                       address: { type: string }
 *                       decimals: { type: integer }
 */
router.get('/supported-currencies', async (req, res) => {
  try {
    const supportedNetworks = walletService.getSupportedNetworks();

    const currencies = Object.entries(supportedNetworks).map(([networkKey, config]) => ({
      network: networkKey,
      networkName: config.name,
      chainId: config.chainId,
      nativeCurrency: config.nativeCurrency,
      usdcSupported: walletService.isUSDCSupported(networkKey),
      usdcContractAddress: config.usdcContractAddress
    }));

    res.json({
      currencies,
      supportedTokens: ['XDC', 'ROXN', 'USDC', 'ETH', 'MATIC', 'BNB']
    });

  } catch (error) {
    log(`Error fetching supported currencies: ${error}`, 'wallet-api');
    res.status(500).json({ error: 'Failed to fetch supported currencies' });
  }
});

export default router;
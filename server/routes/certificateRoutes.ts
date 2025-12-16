import { Router } from 'express';
import { requireAuth, csrfProtection } from '../auth';
import { blockchain } from '../blockchain';
import { log } from '../utils';
import { ethers } from 'ethers';

// Admin user ID constant - platform admin (reused from adminRoutes)
const ADMIN_USER_ID = 1;

const router = Router();

/**
 * @swagger
 * /api/certificates/issue:
 *   post:
 *     summary: Issue a new Contribution Certificate
 *     description: Issue a Soulbound Token (Certificate) to a user for their contribution. Restricted to internal/admin use.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *               - metadataUri
 *             properties:
 *               userAddress:
 *                 type: string
 *               metadataUri:
 *                 type: string
 *     responses:
 *       200:
 *         description: Certificate issued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 txHash:
 *                   type: string
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       403:
 *         description: Forbidden - Admin access required
 *       500:
 *         description: Server error - failed to issue certificate
 */
router.post('/issue', requireAuth, csrfProtection, async (req, res) => {
    const user = req.user;
    if (!user) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    // Check if user is admin (user ID 1 is the platform admin)
    if (user.id !== ADMIN_USER_ID) {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const { userAddress, metadataUri } = req.body;

    if (!userAddress || !metadataUri) {
        return res.status(400).json({ error: 'Missing userAddress or metadataUri' });
    }

    // Validate address format
    const normalizedAddress = userAddress.replace('xdc', '0x');
    if (!ethers.isAddress(normalizedAddress)) {
        return res.status(400).json({ error: 'Invalid userAddress format' });
    }

    try {
        const txHash = await blockchain.issueCertificate(userAddress, metadataUri);
        res.json({ status: 'success', txHash });
    } catch (error: any) {
        log(`Error issuing certificate: ${error.message}`, 'error');
        res.status(500).json({ error: 'Failed to issue certificate' });
    }
});

// Implementation for getting user certificates could be added here if needed,
// but for now we rely on blockchain explorers or existing NFT fetchers.

export default router;

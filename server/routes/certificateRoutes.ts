import { Router } from 'express';
import { blockchain } from '../blockchain';
import { log } from '../utils';

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
 */
router.post('/issue', async (req, res) => {
    const { userAddress, metadataUri } = req.body;

    if (!userAddress || !metadataUri) {
        return res.status(400).json({ error: 'Missing userAddress or metadataUri' });
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

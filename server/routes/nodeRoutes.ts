import { Router, Request, Response } from 'express';
import express from 'express';
import { requireAuth } from '../auth';
import { log } from '../utils';
import { blockchain } from '../blockchain';
import { dispatchTask } from '../services/proofOfComputeService';
import { handleHeartbeat, getNodeStatus, getAllNodeStatuses } from '../services/exoNodeService';

const router = Router();

// --- Proof of Compute V1 Routes ---
/**
 * @openapi
 * /node/dispatch-task:
 *   post:
 *     summary: Endpoint for POST /node/dispatch-task
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/node/dispatch-task', requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }
    const result = await dispatchTask(prompt);
    res.json(result);
  } catch (error: any) {
    log(`Error dispatching task: ${error.message}`, 'proof-of-compute-ERROR');
    res.status(500).json({ error: 'Failed to dispatch task', details: error.message });
  }
});

/**
 * @openapi
 * /node/heartbeat:
 *   post:
 *     summary: Endpoint for POST /node/heartbeat
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/node/heartbeat', express.json(), async (req, res) => {
  const { node_id, wallet_address, ip_address, port } = req.body;
  if (!node_id || !wallet_address || !ip_address || !port) {
    return res.status(400).json({ error: 'Missing node_id, wallet_address, ip_address, or port' });
  }
  try {
    await handleHeartbeat(node_id, wallet_address, ip_address, port);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

/**
 * @openapi
 * /node/status:
 *   get:
 *     summary: Endpoint for GET /node/status
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/node/status', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.xdcWalletAddress) {
      return res.status(400).json({ error: 'User wallet address not found.' });
    }
    const status = await getNodeStatus(user.xdcWalletAddress);
    res.json(status);
  } catch (error: any) {
    log(`Error fetching node status: ${error.message}`, 'proof-of-compute-ERROR');
    res.status(500).json({ error: 'Failed to fetch node status' });
  }
});

/**
 * @openapi
 * /nodes/status:
 *   get:
 *     summary: Endpoint for GET /nodes/status
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/nodes/status', requireAuth, async (req, res) => {
  try {
    const statuses = await getAllNodeStatuses();
    res.json(statuses);
  } catch (error: any) {
    log(`Error fetching all node statuses: ${error.message}`, 'proof-of-compute-ERROR');
    res.status(500).json({ error: 'Failed to fetch all node statuses' });
  }
});

/**
 * @openapi
 * /node/check-registration:
 *   get:
 *     summary: Endpoint for GET /node/check-registration
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/node/check-registration', async (req, res) => {
  const { nodeId } = req.query;
  if (!nodeId || typeof nodeId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid nodeId' });
  }
  try {
    const isRegistered = await blockchain.checkNodeRegistration(nodeId);
    res.json({ isRegistered });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check node registration' });
  }
});

/**
 * @openapi
 * /node/register:
 *   post:
 *     summary: Endpoint for POST /node/register
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/node/register', express.json(), async (req, res) => {
  const { nodeId, walletAddress } = req.body;
  if (!nodeId || !walletAddress) {
    return res.status(400).json({ error: 'Missing nodeId or walletAddress' });
  }
  try {
    const tx = await blockchain.registerNode(nodeId, walletAddress);
    res.json({ success: true, transactionHash: tx.hash });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register node' });
  }
});

/**
 * @openapi
 * /node/compute-units:
 *   get:
 *     summary: Endpoint for GET /node/compute-units
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema: { type: object }
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/node/compute-units', requireAuth, async (req, res) => {
  try {
    if (!req.user || !req.user.xdcWalletAddress) {
      return res.status(401).json({ error: 'User not authenticated or wallet address missing' });
    }
    const units = await blockchain.getComputeUnits(req.user.xdcWalletAddress);
    res.json({ computeUnits: units });
  } catch (error: any) {
    log(`Error fetching compute units: ${error.message}`, 'proof-of-compute-ERROR');
    res.status(500).json({ error: 'Failed to fetch compute units' });
  }
});

export default router;


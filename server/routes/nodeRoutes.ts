import { Router, Request, Response } from 'express';
import express from 'express';
import { requireAuth } from '../auth';
import { log } from '../utils';
import { blockchain } from '../blockchain';
import { dispatchTask } from '../services/proofOfComputeService';
import { handleHeartbeat, getNodeStatus, getAllNodeStatuses } from '../services/exoNodeService';

const router = Router();

// --- Proof of Compute V1 Routes ---
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

router.get('/nodes/status', requireAuth, async (req, res) => {
  try {
    const statuses = await getAllNodeStatuses();
    res.json(statuses);
  } catch (error: any) {
    log(`Error fetching all node statuses: ${error.message}`, 'proof-of-compute-ERROR');
    res.status(500).json({ error: 'Failed to fetch all node statuses' });
  }
});

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


import { Router } from 'express';
import multer from 'multer';
import { processDocument } from '../services/aiScopingService';
import { requireAuth } from '../auth';

const router = Router();
const upload = multer({ dest: 'uploads/' });

// In-memory store for job status and results
const jobStore = new Map<string, { status: string; result: any }>();

/**
 * @route POST /api/ai-scoping/upload
 * @desc Upload a document for AI analysis
 * @access Private (Enterprise)
 */
/**
 * @openapi
 * /upload:
 *   post:
 *     summary: Endpoint for POST /upload
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
router.post('/upload', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No document uploaded.' });
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  jobStore.set(jobId, { status: 'pending', result: null });

  res.status(202).json({ jobId });

  // Process the document asynchronously
  try {
    const result = await processDocument(req.file.path);
    jobStore.set(jobId, { status: 'completed', result });
  } catch (error) {
    console.error(`[AI Scoping Agent] Error processing job ${jobId}:`, error);
    jobStore.set(jobId, { status: 'failed', result: { error: 'Failed to process document.' } });
  }
});

/**
 * @route GET /api/ai-scoping/results/:jobId
 * @desc Poll for the results of an analysis job
 * @access Private (Enterprise)
 */
/**
 * @openapi
 * /results/{jobId}:
 *   get:
 *     summary: Endpoint for GET /results/{jobId}
 *     tags: [General]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
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
router.get('/results/:jobId', requireAuth, (req, res) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  if (job.status === 'pending') {
    return res.status(200).json({ status: 'pending' });
  }

  // Once the job is done, return the result and remove it from the store
  jobStore.delete(jobId);
  res.status(200).json(job);
});

export default router;

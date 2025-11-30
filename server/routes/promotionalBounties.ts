import { Router, type Request, Response } from 'express';
import { db, users } from '../db';
import { requireAuth } from '../auth';
import { eq, and, desc, sql, inArray, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  registeredRepositories,
  promotionalBounties,
  promotionalSubmissions,
  createPromotionalBountySchema,
  createPromotionalSubmissionSchema,
  type CreatePromotionalBountyInput,
  type CreatePromotionalSubmissionInput,
} from '../../shared/schema';
import { log } from '../utils';
import rateLimit from 'express-rate-limit';

// Custom error class for business logic errors
class BusinessError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'BusinessError';
  }
}

// Rate limiters for promotional bounties endpoints
const submissionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 submissions per 15 minutes
  message: 'Too many submission requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const reviewRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Max 20 reviews per 15 minutes
  message: 'Too many review requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const createBountyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Max 20 bounties per hour
  message: 'Too many bounty creation requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

// parse JSON fields if they come as strings
const transformBounty = (bounty: any) => {
  if (bounty.promotionalChannels && typeof bounty.promotionalChannels === 'string') {
    try {
      bounty.promotionalChannels = JSON.parse(bounty.promotionalChannels);
    } catch {
      bounty.promotionalChannels = [];
    }
  }
  return bounty;
};

const transformSubmission = (submission: any) => {
  if (submission.proofLinks && typeof submission.proofLinks === 'string') {
    try {
      submission.proofLinks = JSON.parse(submission.proofLinks);
    } catch {
      submission.proofLinks = [];
    }
  }
  return submission;
};

// Get user's registered repos
router.get('/repositories', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const repos = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.userId, userId))
      .orderBy(desc(registeredRepositories.registeredAt));
    
    res.json(repos);
  } catch (error: any) {
    log(`Error fetching repositories: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Get all bounties
router.get('/bounties', async (req: Request, res: Response) => {
  try {
    const { type, status, repoId, channel } = req.query;
    
    const conditions = [];
    if (type) {
      conditions.push(eq(promotionalBounties.type, type as string));
    }
    if (status) {
      conditions.push(eq(promotionalBounties.status, status as string));
    }
    if (repoId) {
      const repoIdNum = parseInt(repoId as string, 10);
      if (isNaN(repoIdNum)) {
        return res.status(400).json({ error: 'Invalid repoId parameter' });
      }
      conditions.push(eq(promotionalBounties.repoId, repoIdNum));
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const results = await db.select({
      bounty: promotionalBounties,
      repository: registeredRepositories,
    })
      .from(promotionalBounties)
      .leftJoin(registeredRepositories, eq(promotionalBounties.repoId, registeredRepositories.id))
      .where(whereClause)
      .orderBy(desc(promotionalBounties.createdAt));
    
    let transformedBounties = results.map((r: any) => ({
      ...transformBounty(r.bounty),
      repository: r.repository,
    }));
    
    if (channel && type === 'PROMOTIONAL') {
      transformedBounties = transformedBounties.filter((b: any) =>
        b.promotionalChannels?.includes(channel as string)
      );
    }
    
    res.json(transformedBounties);
  } catch (error: any) {
    log(`Error fetching bounties: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Get only promotional bounties
router.get('/bounties/promotional', async (req: Request, res: Response) => {
  try {
    const { status, channel, repoId } = req.query;
    
    const conditions = [eq(promotionalBounties.type, 'PROMOTIONAL')];
    
    if (status) {
      conditions.push(eq(promotionalBounties.status, status as string));
    } else {
      conditions.push(eq(promotionalBounties.status, 'ACTIVE'));
    }
    
    if (repoId) {
      const repoIdNum = parseInt(repoId as string, 10);
      if (isNaN(repoIdNum)) {
        return res.status(400).json({ error: 'Invalid repoId parameter' });
      }
      conditions.push(eq(promotionalBounties.repoId, repoIdNum));
    }
    
    const results = await db.select({
      bounty: promotionalBounties,
      repository: registeredRepositories,
    })
      .from(promotionalBounties)
      .leftJoin(registeredRepositories, eq(promotionalBounties.repoId, registeredRepositories.id))
      .where(and(...conditions))
      .orderBy(desc(promotionalBounties.createdAt));
    
    let transformedBounties = results.map((r: any) => ({
      ...transformBounty(r.bounty),
      repository: r.repository,
    }));
    
    if (channel) {
      transformedBounties = transformedBounties.filter((b: any) =>
        b.promotionalChannels?.includes(channel as string)
      );
    }
    
    res.json(transformedBounties);
  } catch (error: any) {
    log(`Error fetching promotional bounties: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Get bounty by ID
router.get('/bounties/:id', async (req: Request, res: Response) => {
  try {
    const bountyId = parseInt(req.params.id, 10);
    if (isNaN(bountyId)) {
      return res.status(400).json({ error: 'Invalid bounty ID' });
    }
    
    const [result] = await db
      .select({
        bounty: promotionalBounties,
        repository: registeredRepositories,
      })
      .from(promotionalBounties)
      .leftJoin(registeredRepositories, eq(promotionalBounties.repoId, registeredRepositories.id))
      .where(eq(promotionalBounties.id, bountyId))
      .limit(1);
    
    if (!result) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    const submissions = await db
      .select()
      .from(promotionalSubmissions)
      .where(eq(promotionalSubmissions.bountyId, bountyId))
      .orderBy(desc(promotionalSubmissions.createdAt));
    
    const transformedBounty = transformBounty(result.bounty);
    transformedBounty.submissions = submissions.map(transformSubmission);
    transformedBounty.repository = result.repository;
    
    res.json(transformedBounty);
  } catch (error: any) {
    log(`Error fetching bounty: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Create bounty - pool managers only
router.post('/bounties', requireAuth, createBountyRateLimiter, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validatedData = createPromotionalBountySchema.parse(req.body);
    
    // check repo exists and user owns it
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, validatedData.repoId))
      .limit(1);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    if (repo.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to create bounties for this repository' });
    }
    
    if (validatedData.type === 'PROMOTIONAL') {
      if (!validatedData.promotionalChannels || validatedData.promotionalChannels.length === 0) {
        return res.status(400).json({ error: 'Promotional channels are required for promotional bounties' });
      }
      if (!validatedData.requiredDeliverable) {
        return res.status(400).json({ error: 'Required deliverable is required for promotional bounties' });
      }
    }
    
    const [newBounty] = await db.insert(promotionalBounties).values({
      repoId: validatedData.repoId,
      creatorId: userId,
      type: validatedData.type,
      status: 'DRAFT',
      title: validatedData.title,
      description: validatedData.description,
      promotionalChannels: validatedData.promotionalChannels || [],
      requiredDeliverable: validatedData.requiredDeliverable,
      rewardAmount: validatedData.rewardAmount,
      rewardType: validatedData.rewardType,
      maxSubmissions: validatedData.maxSubmissions,
      totalRewardPool: validatedData.totalRewardPool,
      expiresAt: validatedData.expiresAt ? new Date(validatedData.expiresAt) : null,
    }).returning();
    
    res.status(201).json(transformBounty(newBounty));
  } catch (error: any) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    log(`Error creating bounty: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Update bounty status
router.patch('/bounties/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const bountyId = parseInt(req.params.id, 10);
    if (isNaN(bountyId)) {
      return res.status(400).json({ error: 'Invalid bounty ID' });
    }
    const userId = (req as any).user?.id;
    const { status } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validStatuses = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const [bounty] = await db.select().from(promotionalBounties).where(eq(promotionalBounties.id, bountyId)).limit(1);
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, bounty.repoId))
      .limit(1);
    
    if (!repo) {
      return res.status(404).json({ error: 'Associated repository not found' });
    }
    
    if (repo.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to update this bounty' });
    }
    
    const [updatedBounty] = await db
      .update(promotionalBounties)
      .set({ status, updatedAt: new Date() })
      .where(eq(promotionalBounties.id, bountyId))
      .returning();
    
    res.json(transformBounty(updatedBounty));
  } catch (error: any) {
    log(`Error updating bounty status: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Submissions
router.get('/submissions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { bountyId, status, contributorId } = req.query;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const conditions = [];
    
    if (bountyId) {
      const bountyIdNum = parseInt(bountyId as string, 10);
      if (isNaN(bountyIdNum)) {
        return res.status(400).json({ error: 'Invalid bountyId parameter' });
      }
      conditions.push(eq(promotionalSubmissions.bountyId, bountyIdNum));
    }
    
    if (status) {
      conditions.push(eq(promotionalSubmissions.status, status as string));
    }
    
    if (contributorId) {
      const contributorIdNum = parseInt(contributorId as string, 10);
      if (isNaN(contributorIdNum)) {
        return res.status(400).json({ error: 'Invalid contributorId parameter' });
      }
      conditions.push(eq(promotionalSubmissions.contributorId, contributorIdNum));
    }
    
    // filter by user's own submissions or bounties they manage (unless admin)
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user?.role !== 'admin') {
      const userRepos = await db
        .select()
        .from(registeredRepositories)
        .where(eq(registeredRepositories.userId, userId));
      const repoIds = userRepos.map(r => r.id);
      
      if (repoIds.length > 0) {
        const userBounties = await db
          .select()
          .from(promotionalBounties)
          .where(inArray(promotionalBounties.repoId, repoIds));
        const bountyIds = userBounties.map(b => b.id);
        
        if (bountyIds.length > 0) {
          conditions.push(
            or(
              eq(promotionalSubmissions.contributorId, userId),
              inArray(promotionalSubmissions.bountyId, bountyIds)
            )
          );
        } else {
          conditions.push(eq(promotionalSubmissions.contributorId, userId));
        }
      } else {
        conditions.push(eq(promotionalSubmissions.contributorId, userId));
      }
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const submissions = await db.select()
      .from(promotionalSubmissions)
      .where(whereClause)
      .orderBy(desc(promotionalSubmissions.createdAt));
    
    res.json(submissions.map(transformSubmission));
  } catch (error: any) {
    log(`Error fetching submissions: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Get submission by ID
router.get('/submissions/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const submissionId = parseInt(req.params.id, 10);
    if (isNaN(submissionId)) {
      return res.status(400).json({ error: 'Invalid submission ID' });
    }
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const [submission] = await db
      .select()
      .from(promotionalSubmissions)
      .where(eq(promotionalSubmissions.id, submissionId))
      .limit(1);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    const isContributor = submission.contributorId === userId;
    const [bounty] = await db
      .select()
      .from(promotionalBounties)
      .where(eq(promotionalBounties.id, submission.bountyId))
      .limit(1);
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, bounty.repoId))
      .limit(1);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const isPoolManager = repo.userId === userId;
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const isAdmin = user?.role === 'admin';
    
    if (!isContributor && !isPoolManager && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to view this submission' });
    }
    
    res.json(transformSubmission(submission));
  } catch (error: any) {
    log(`Error fetching submission: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Create submission
router.post('/submissions', requireAuth, submissionRateLimiter, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validatedData = createPromotionalSubmissionSchema.parse(req.body);
    
    // Use transaction with row-level locking to prevent race condition
    const newSubmission = await db.transaction(async (tx) => {
      // Lock the bounty row using FOR UPDATE to prevent concurrent submissions
      const lockedBountyResult = await tx.execute(
        sql`SELECT * FROM promotional_bounties WHERE id = ${validatedData.bountyId} FOR UPDATE LIMIT 1`
      );
      
      if (!lockedBountyResult.rows || lockedBountyResult.rows.length === 0) {
        throw new BusinessError('Bounty not found', 404);
      }
      
      const lockedBounty = lockedBountyResult.rows[0] as any;
      
      if (lockedBounty.status !== 'ACTIVE') {
        throw new BusinessError('Bounty is not active', 400);
      }
      
      if (lockedBounty.expires_at && new Date(lockedBounty.expires_at) < new Date()) {
        throw new BusinessError('Bounty has expired', 400);
      }
      
      // Check max submissions with locked bounty (within transaction)
      if (lockedBounty.max_submissions) {
        const submissionCountResult = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(promotionalSubmissions)
          .where(eq(promotionalSubmissions.bountyId, validatedData.bountyId));
        
        const count = submissionCountResult[0]?.count || 0;
        if (count >= lockedBounty.max_submissions) {
          throw new BusinessError('Maximum submissions reached for this bounty', 400);
        }
      }
      
      // Insert submission within transaction
      const [submission] = await tx.insert(promotionalSubmissions).values({
        bountyId: validatedData.bountyId,
        contributorId: userId,
        proofLinks: validatedData.proofLinks,
        description: validatedData.description,
      }).returning();
      
      return submission;
    });
    
    res.status(201).json(transformSubmission(newSubmission));
  } catch (error: any) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    if (error instanceof BusinessError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    log(`Error creating submission: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Review submission - pool managers only
router.patch('/submissions/:id/review', requireAuth, reviewRateLimiter, async (req: Request, res: Response) => {
  try {
    const submissionId = parseInt(req.params.id, 10);
    if (isNaN(submissionId)) {
      return res.status(400).json({ error: 'Invalid submission ID' });
    }
    const userId = (req as any).user?.id;
    const { status, reviewNotes } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const [submission] = await db
      .select()
      .from(promotionalSubmissions)
      .where(eq(promotionalSubmissions.id, submissionId))
      .limit(1);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    const [bounty] = await db.select().from(promotionalBounties).where(eq(promotionalBounties.id, submission.bountyId)).limit(1);
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, bounty.repoId))
      .limit(1);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const isPoolManager = repo.userId === userId;
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const isAdmin = user?.role === 'admin';
    
    if (!isPoolManager && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to review this submission' });
    }
    
    if (submission.status !== 'PENDING' && !isAdmin) {
      return res.status(400).json({ error: 'Submission has already been reviewed' });
    }
    
    const [updatedSubmission] = await db
      .update(promotionalSubmissions)
      .set({
        status,
        reviewNotes,
        reviewedAt: new Date(),
        reviewedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(promotionalSubmissions.id, submissionId))
      .returning();
    
    res.json(transformSubmission(updatedSubmission));
  } catch (error: any) {
    log(`Error reviewing submission: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

export default router;


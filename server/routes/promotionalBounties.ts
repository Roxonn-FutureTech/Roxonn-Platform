import { Router, type Request, Response } from 'express';
import { db, users } from '../db';
import { requireAuth } from '../auth';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
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

const router = Router();

// Helper to transform bounty data (handle JSON fields)
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

// Helper to transform submission data
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

// ==================== PROJECTS ====================

// ==================== REPOSITORIES ====================
// Note: Promotional bounties are associated with registered repositories
// Pool Managers use their existing registered repositories

// Get repositories for current user (Pool Manager)
router.get('/repositories', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get user's registered repositories
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

// ==================== BOUNTIES ====================

// Get all bounties (with filters)
router.get('/bounties', async (req: Request, res: Response) => {
  try {
    const { type, status, projectId, channel } = req.query;
    
    const conditions = [];
    if (type) {
      conditions.push(eq(promotionalBounties.type, type as string));
    }
    if (status) {
      conditions.push(eq(promotionalBounties.status, status as string));
    }
    if (projectId) {
      conditions.push(eq(promotionalBounties.projectId, parseInt(projectId as string)));
    }
    
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    
    const results = await db.select({
      bounty: promotionalBounties,
      project: projects,
    })
      .from(promotionalBounties)
      .leftJoin(projects, eq(promotionalBounties.projectId, projects.id))
      .where(whereClause)
      .orderBy(desc(promotionalBounties.createdAt));
    
    // Transform and filter by channel if needed
    let transformedBounties = results.map((r: any) => ({
      ...transformBounty(r.bounty),
      project: r.project,
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

// Get promotional bounties specifically
router.get('/bounties/promotional', async (req: Request, res: Response) => {
  try {
    const { status, channel, projectId } = req.query;
    
    const conditions = [eq(promotionalBounties.type, 'PROMOTIONAL')];
    
    if (status) {
      conditions.push(eq(promotionalBounties.status, status as string));
    } else {
      conditions.push(eq(promotionalBounties.status, 'ACTIVE'));
    }
    
    if (projectId) {
      conditions.push(eq(promotionalBounties.projectId, parseInt(projectId as string)));
    }
    
    const results = await db.select({
      bounty: promotionalBounties,
      project: projects,
    })
      .from(promotionalBounties)
      .leftJoin(projects, eq(promotionalBounties.projectId, projects.id))
      .where(and(...conditions))
      .orderBy(desc(promotionalBounties.createdAt));
    
    let transformedBounties = results.map((r: any) => ({
      ...transformBounty(r.bounty),
      project: r.project,
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
    const bountyId = parseInt(req.params.id);
    
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
    
    // Get submissions
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

// Create bounty (Pool Manager only)
router.post('/bounties', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Validate input
    const validatedData = createPromotionalBountySchema.parse(req.body);
    
    // Verify repository exists and user is the pool manager (owner)
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
    
    // Validate promotional-specific fields (per issue requirements)
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
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log(`Error creating bounty: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Update bounty status
router.patch('/bounties/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const bountyId = parseInt(req.params.id);
    const userId = (req as any).user?.id;
    const { status } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validStatuses = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Check authorization
    const [bounty] = await db.select().from(promotionalBounties).where(eq(promotionalBounties.id, bountyId)).limit(1);
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, bounty.repoId))
      .limit(1);
    
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

// ==================== SUBMISSIONS ====================

// Get all submissions
router.get('/submissions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { bountyId, status, contributorId } = req.query;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const conditions = [];
    
    if (bountyId) {
      conditions.push(eq(promotionalSubmissions.bountyId, parseInt(bountyId as string)));
    }
    
    if (status) {
      conditions.push(eq(promotionalSubmissions.status, status as string));
    }
    
    if (contributorId) {
      conditions.push(eq(promotionalSubmissions.contributorId, parseInt(contributorId as string)));
    }
    
    // If not admin, filter by user's submissions or their bounties
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user?.role !== 'admin') {
      // Get user's repositories (as pool manager)
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
            sql`${promotionalSubmissions.contributorId} = ${userId} OR ${promotionalSubmissions.bountyId} IN ${sql.raw(`(${bountyIds.join(',')})`)}`
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
    const submissionId = parseInt(req.params.id);
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
    
    // Check authorization
    const isContributor = submission.contributorId === userId;
    const [bounty] = await db
      .select()
      .from(promotionalBounties)
      .where(eq(promotionalBounties.id, submission.bountyId))
      .limit(1);
    const [repo] = await db
      .select()
      .from(registeredRepositories)
      .where(eq(registeredRepositories.id, bounty.repoId))
      .limit(1);
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
router.post('/submissions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const validatedData = createPromotionalSubmissionSchema.parse(req.body);
    
    // Verify bounty exists and is active
    const [bounty] = await db
      .select()
      .from(promotionalBounties)
      .where(eq(promotionalBounties.id, validatedData.bountyId))
      .limit(1);
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    if (bounty.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Bounty is not active' });
    }
    
    // Check max submissions
    if (bounty.maxSubmissions) {
      const submissionCountResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(promotionalSubmissions)
        .where(eq(promotionalSubmissions.bountyId, validatedData.bountyId));
      
      const count = submissionCountResult[0]?.count || 0;
      if (count >= bounty.maxSubmissions) {
        return res.status(400).json({ error: 'Maximum submissions reached for this bounty' });
      }
    }
    
    const [newSubmission] = await db.insert(promotionalSubmissions).values({
      bountyId: validatedData.bountyId,
      contributorId: userId,
      proofLinks: validatedData.proofLinks,
      description: validatedData.description,
    }).returning();
    
    res.status(201).json(transformSubmission(newSubmission));
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log(`Error creating submission: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Review submission (Pool Manager only)
router.patch('/submissions/:id/review', requireAuth, async (req: Request, res: Response) => {
  try {
    const submissionId = parseInt(req.params.id);
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
    
    // Check authorization
    const [bounty] = await db.select().from(promotionalBounties).where(eq(promotionalBounties.id, submission.bountyId)).limit(1);
    const [project] = await db.select().from(projects).where(eq(projects.id, bounty.projectId)).limit(1);
    const isPoolManager = project.poolManagerId === userId;
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


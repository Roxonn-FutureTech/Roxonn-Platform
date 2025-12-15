import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { getTopContributors, getTopProjects } from '../services/leaderboardService';
import { log } from '../utils';

const router = Router();

/**
 * @openapi
 * /api/leaderboard/contributors:
 *   get:
 *     summary: Get top contributors
 *     tags: [Leaderboard]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of top contributors
 */
router.get('/contributors', requireAuth, async (req: Request, res: Response) => {
    try {
        const contributors = await getTopContributors();
        res.json(contributors);
    } catch (error) {
        log(`Error fetching contributors leaderboard: ${error}`, 'leaderboard');
        res.status(500).json({ error: 'Failed to fetch contributors leaderboard' });
    }
});

/**
 * @openapi
 * /api/leaderboard/projects:
 *   get:
 *     summary: Get top projects
 *     tags: [Leaderboard]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: List of top projects
 */
router.get('/projects', requireAuth, async (req: Request, res: Response) => {
    try {
        const formattedProjects = await getTopProjects();
        res.json(formattedProjects);
    } catch (error) {
        log(`Error fetching projects leaderboard: ${error}`, 'leaderboard');
        res.status(500).json({ error: 'Failed to fetch projects leaderboard' });
    }
});

export default router;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { getTopContributors, getTopProjects } from '../../services/leaderboardService';
import leaderboardRoutes from '../leaderboardRoutes';
// Using supertest to test the actual router instead of mocking handlers
import express from 'express';
import request from 'supertest';

// Mock the service
vi.mock('../../services/leaderboardService', () => ({
    getTopContributors: vi.fn(),
    getTopProjects: vi.fn(),
}));

// Mock auth middleware
vi.mock('../../auth', () => ({
    requireAuth: (req: Request, res: Response, next: any) => next(),
    csrfProtection: (req: Request, res: Response, next: any) => next(), // Even if removed, good to mock just in case
}));

describe('Leaderboard Routes', () => {
    let app: express.Express;

    beforeEach(() => {
        vi.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/leaderboard', leaderboardRoutes);
    });

    describe('GET /api/leaderboard/contributors', () => {
        it('should return contributors list', async () => {
            const mockData = [{ rank: 1, id: 1, username: 'test', avatarUrl: 'url', roxnEarned: '10', usdcEarned: '5' }];
            vi.mocked(getTopContributors).mockResolvedValue(mockData);

            const response = await request(app).get('/api/leaderboard/contributors');

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockData);
            expect(getTopContributors).toHaveBeenCalled();
        });

        it('should handle errors', async () => {
            vi.mocked(getTopContributors).mockRejectedValue(new Error('Database error'));

            const response = await request(app).get('/api/leaderboard/contributors');

            expect(response.status).toBe(500);
            expect(response.body).toHaveProperty('error');
        });
    });

    describe('GET /api/leaderboard/projects', () => {
        it('should return projects list', async () => {
            const mockData = [{ rank: 1, id: 1, name: 'repo', bountiesCount: 5, avatarUrl: 'url' }];
            vi.mocked(getTopProjects).mockResolvedValue(mockData);

            const response = await request(app).get('/api/leaderboard/projects');

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockData);
            expect(getTopProjects).toHaveBeenCalled();
        });

        it('should handle errors', async () => {
            vi.mocked(getTopProjects).mockRejectedValue(new Error('Database error'));

            const response = await request(app).get('/api/leaderboard/projects');

            expect(response.status).toBe(500);
            expect(response.body).toHaveProperty('error');
        });
    });
});

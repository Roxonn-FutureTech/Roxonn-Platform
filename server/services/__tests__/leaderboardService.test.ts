import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTopContributors, getTopProjects } from '../leaderboardService';
import { db } from '../../db';

// Mock database
vi.mock('../../db', () => ({
    db: {
        select: vi.fn(),
    },
}));

describe('Leaderboard Service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getTopContributors', () => {
        it('should fetch and format top contributors correctly', async () => {
            // Mock db response
            const mockContributors = [
                {
                    id: 1,
                    username: 'user1',
                    avatarUrl: 'https://github.com/user1.png',
                    totalRoxnEarned: '100.50000000',
                    totalUsdcEarned: '50.000000',
                },
                {
                    id: 2,
                    username: 'user2',
                    avatarUrl: null,
                    totalRoxnEarned: '0',
                    totalUsdcEarned: '10.000000',
                },
            ];

            const mockQueryBuilder = {
                from: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue(mockContributors),
            };

            vi.mocked(db.select).mockReturnValue(mockQueryBuilder as any);

            const result = await getTopContributors(10);

            expect(db.select).toHaveBeenCalled();
            expect(mockQueryBuilder.limit).toHaveBeenCalledWith(10);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                rank: 1,
                id: 1,
                username: 'user1',
                avatarUrl: 'https://github.com/user1.png',
                roxnEarned: '100.50',
                usdcEarned: '50.00',
            });
            expect(result[1]).toEqual({
                rank: 2,
                id: 2,
                username: 'user2',
                avatarUrl: null,
                roxnEarned: '0.00',
                usdcEarned: '10.00',
            });
        });
    });

    describe('getTopProjects', () => {
        it('should fetch and format top projects correctly', async () => {
            // Mock db response
            const mockProjects = [
                {
                    id: 101,
                    githubRepoFullName: 'owner/repo1',
                    totalBounties: 5,
                },
                {
                    id: 102,
                    githubRepoFullName: 'owner/repo2',
                    totalBounties: 3,
                },
            ];

            const mockQueryBuilder = {
                from: vi.fn().mockReturnThis(),
                leftJoin: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                groupBy: vi.fn().mockReturnThis(),
                orderBy: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue(mockProjects),
            };

            vi.mocked(db.select).mockReturnValue(mockQueryBuilder as any);

            const result = await getTopProjects(5);

            expect(db.select).toHaveBeenCalled();
            expect(mockQueryBuilder.limit).toHaveBeenCalledWith(5);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                rank: 1,
                id: 101,
                name: 'owner/repo1',
                bountiesCount: 5,
                avatarUrl: 'https://github.com/owner.png',
            });
        });
    });
});

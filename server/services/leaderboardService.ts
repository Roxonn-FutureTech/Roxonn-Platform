import { db } from '../db';
import { users, registeredRepositories, multiCurrencyBounties } from '../../shared/schema';
import { desc, sql, eq } from 'drizzle-orm';

export interface Contributor {
    rank: number;
    id: number;
    username: string;
    avatarUrl: string | null;
    roxnEarned: string;
    usdcEarned: string;
}

export interface Project {
    rank: number;
    id: number;
    name: string;
    bountiesCount: number;
    avatarUrl: string;
}

export async function getTopContributors(limit: number = 50): Promise<Contributor[]> {
    const topContributors = await db.select({
        id: users.id,
        username: users.username,
        avatarUrl: users.avatarUrl,
        totalRoxnEarned: users.totalRoxnEarned,
        totalUsdcEarned: users.totalUsdcEarned,
    })
        .from(users)
        .where(sql`${users.totalRoxnEarned} > 0 OR ${users.totalUsdcEarned} > 0`)
        .orderBy(desc(users.totalRoxnEarned), desc(users.totalUsdcEarned))
        .limit(limit);

    return topContributors.map((c, index) => ({
        rank: index + 1,
        id: c.id,
        username: c.username,
        avatarUrl: c.avatarUrl,
        roxnEarned: parseFloat(c.totalRoxnEarned || '0').toFixed(2),
        usdcEarned: parseFloat(c.totalUsdcEarned || '0').toFixed(2),
    }));
}

export async function getTopProjects(limit: number = 50): Promise<Project[]> {
    const projectRankings = await db.select({
        id: registeredRepositories.id,
        githubRepoFullName: registeredRepositories.githubRepoFullName,
        totalBounties: sql<number>`count(${multiCurrencyBounties.id})`.as('total_bounties'),
    })
        .from(registeredRepositories)
        .leftJoin(multiCurrencyBounties, eq(registeredRepositories.githubRepoId, multiCurrencyBounties.repoId))
        .where(eq(registeredRepositories.isActive, true))
        .groupBy(registeredRepositories.id, registeredRepositories.githubRepoFullName)
        .orderBy(desc(sql`total_bounties`))
        .limit(limit);

    return projectRankings.map((p, index) => {
        // Validate and clean repo name for avatar URL
        const [owner] = p.githubRepoFullName.split('/');
        return {
            rank: index + 1,
            id: p.id,
            name: p.githubRepoFullName,
            bountiesCount: Number(p.totalBounties),
            avatarUrl: owner ? `https://github.com/${owner}.png` : ''
        };
    });
}

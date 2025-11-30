import { db } from '../db';
import {
  multiCurrencyBounties,
  subscriptions,
  referrals,
  subscriptionEvents,
  users,
  registeredRepositories
} from '../../shared/schema';
import { eq, desc, and, or } from 'drizzle-orm';
import { log } from '../utils';

// Activity item interface matching the frontend schema
export interface ActivityItem {
  id: string;
  type: 'reward' | 'contribution' | 'subscription' | 'referral';
  title: string;
  description: string;
  timestamp: string;
  metadata?: {
    amount?: string;
    currency?: 'XDC' | 'ROXN' | 'USDC';
    repoName?: string;
    txHash?: string;
    issueId?: number;
  };
}

export class ActivityService {
  /**
   * Get aggregated recent activity for a user
   * Combines data from multiple sources:
   * 1. Reward distributions (multi_currency_bounties)
   * 2. Subscription events
   * 3. Referral conversions
   * 4. PR/Contribution activities (bounties allocated to user)
   */
  async getRecentActivity(userId: number, limit: number = 10): Promise<ActivityItem[]> {
    const activities: ActivityItem[] = [];

    try {
      const rewards = await this.getRewardActivities(userId, limit);
      activities.push(...rewards);

      const subscriptionActivities = await this.getSubscriptionActivities(userId, limit);
      activities.push(...subscriptionActivities);

      const referralActivities = await this.getReferralActivities(userId, limit);
      activities.push(...referralActivities);

      const contributionActivities = await this.getContributionActivities(userId, limit);
      activities.push(...contributionActivities);

      activities.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      return activities.slice(0, limit);
    } catch (error: any) {
      log(`Error fetching user activity: ${error.message}`, 'activity-ERROR');
      return [];
    }
  }

  /**
   * Get reward-related activities (bounties distributed to user)
   */
  private async getRewardActivities(userId: number, limit: number): Promise<ActivityItem[]> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { xdcWalletAddress: true }
      });

      if (!user?.xdcWalletAddress) {
        return [];
      }

      const bounties = await db
        .select({
          id: multiCurrencyBounties.id,
          repoId: multiCurrencyBounties.repoId,
          issueId: multiCurrencyBounties.issueId,
          currencyType: multiCurrencyBounties.currencyType,
          amount: multiCurrencyBounties.amount,
          status: multiCurrencyBounties.status,
          transactionHash: multiCurrencyBounties.transactionHash,
          updatedAt: multiCurrencyBounties.updatedAt,
          repoFullName: registeredRepositories.githubRepoFullName
        })
        .from(multiCurrencyBounties)
        .leftJoin(
          registeredRepositories,
          eq(multiCurrencyBounties.repoId, registeredRepositories.githubRepoId)
        )
        .where(
          and(
            eq(multiCurrencyBounties.contributorAddress, user.xdcWalletAddress),
            eq(multiCurrencyBounties.status, 'distributed')
          )
        )
        .orderBy(desc(multiCurrencyBounties.updatedAt))
        .limit(limit);

      return bounties.map(bounty => ({
        id: `reward-${bounty.id}`,
        type: 'reward' as const,
        title: 'Bounty Received',
        description: bounty.repoFullName 
          ? `Completed bounty on ${bounty.repoFullName}${bounty.issueId ? ` #${bounty.issueId}` : ''}`
          : `Bounty reward distributed`,
        timestamp: bounty.updatedAt?.toISOString() || new Date().toISOString(),
        metadata: {
          amount: bounty.amount,
          currency: bounty.currencyType as 'XDC' | 'ROXN' | 'USDC',
          repoName: bounty.repoFullName || undefined,
          txHash: bounty.transactionHash || undefined,
          issueId: bounty.issueId || undefined
        }
      }));
    } catch (error: any) {
      log(`Error fetching reward activities: ${error.message}`, 'activity-ERROR');
      return [];
    }
  }

  /**
   * Get subscription-related activities
   */
  private async getSubscriptionActivities(userId: number, limit: number): Promise<ActivityItem[]> {
    try {
      const events = await db
        .select({
          eventId: subscriptionEvents.id,
          eventType: subscriptionEvents.eventType,
          createdAt: subscriptionEvents.createdAt,
          subscriptionPlan: subscriptions.plan,
          amountUsdc: subscriptions.amountUsdc
        })
        .from(subscriptionEvents)
        .innerJoin(subscriptions, eq(subscriptionEvents.subscriptionId, subscriptions.id))
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptionEvents.createdAt))
        .limit(limit);

      return events.map(event => {
        let title: string;
        let description: string;

        switch (event.eventType) {
          case 'created':
            title = 'Subscription Activated';
            description = 'Premium membership activated';
            break;
          case 'renewed':
            title = 'Subscription Renewed';
            description = 'Premium membership renewed for another year';
            break;
          case 'canceled':
            title = 'Subscription Canceled';
            description = 'Premium membership was canceled';
            break;
          case 'expired':
            title = 'Subscription Expired';
            description = 'Premium membership has expired';
            break;
          default:
            title = 'Subscription Update';
            description = 'Subscription status changed';
        }

        return {
          id: `subscription-${event.eventId}`,
          type: 'subscription' as const,
          title,
          description,
          timestamp: event.createdAt?.toISOString() || new Date().toISOString(),
          metadata: event.amountUsdc ? {
            amount: event.amountUsdc,
            currency: 'USDC' as const
          } : undefined
        };
      });
    } catch (error: any) {
      log(`Error fetching subscription activities: ${error.message}`, 'activity-ERROR');
      return [];
    }
  }

  /**
   * Get referral-related activities (as referrer)
   */
  private async getReferralActivities(userId: number, limit: number): Promise<ActivityItem[]> {
    try {
      const userReferrals = await db
        .select({
          id: referrals.id,
          status: referrals.status,
          usdcReward: referrals.usdcReward,
          roxnReward: referrals.roxnReward,
          convertedAt: referrals.convertedAt,
          rewardedAt: referrals.rewardedAt,
          referredUsername: users.username
        })
        .from(referrals)
        .innerJoin(users, eq(referrals.referredId, users.id))
        .where(
          and(
            eq(referrals.referrerId, userId),
            or(
              eq(referrals.status, 'converted'),
              eq(referrals.status, 'rewarded')
            )
          )
        )
        .orderBy(desc(referrals.convertedAt))
        .limit(limit);

      return userReferrals.map(referral => {
        const isRewarded = referral.status === 'rewarded';
        const timestamp = (isRewarded ? referral.rewardedAt : referral.convertedAt) || new Date();
        
        const maskedUsername = referral.referredUsername
          ? `${referral.referredUsername.substring(0, 3)}***`
          : 'a friend';

        return {
          id: `referral-${referral.id}`,
          type: 'referral' as const,
          title: isRewarded ? 'Referral Reward Received' : 'Referral Converted',
          description: isRewarded
            ? `Earned rewards from ${maskedUsername}'s subscription`
            : `${maskedUsername} subscribed through your referral`,
          timestamp: timestamp.toISOString(),
          metadata: {
            amount: referral.usdcReward || undefined,
            currency: 'USDC' as const
          }
        };
      });
    } catch (error: any) {
      log(`Error fetching referral activities: ${error.message}`, 'activity-ERROR');
      return [];
    }
  }

  /**
   * Get PR/contribution-related activities (bounties allocated to user - PR in progress)
   * This tracks when a user has been assigned to work on a bounty (PR created/in progress)
   */
  private async getContributionActivities(userId: number, limit: number): Promise<ActivityItem[]> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { xdcWalletAddress: true }
      });

      if (!user?.xdcWalletAddress) {
        return [];
      }

      const allocatedBounties = await db
        .select({
          id: multiCurrencyBounties.id,
          repoId: multiCurrencyBounties.repoId,
          issueId: multiCurrencyBounties.issueId,
          currencyType: multiCurrencyBounties.currencyType,
          amount: multiCurrencyBounties.amount,
          status: multiCurrencyBounties.status,
          createdAt: multiCurrencyBounties.createdAt,
          updatedAt: multiCurrencyBounties.updatedAt,
          repoFullName: registeredRepositories.githubRepoFullName
        })
        .from(multiCurrencyBounties)
        .leftJoin(
          registeredRepositories,
          eq(multiCurrencyBounties.repoId, registeredRepositories.githubRepoId)
        )
        .where(
          and(
            eq(multiCurrencyBounties.contributorAddress, user.xdcWalletAddress),
            eq(multiCurrencyBounties.status, 'allocated')
          )
        )
        .orderBy(desc(multiCurrencyBounties.updatedAt))
        .limit(limit);

      return allocatedBounties.map(bounty => ({
        id: `contribution-${bounty.id}`,
        type: 'contribution' as const,
        title: 'PR In Progress',
        description: bounty.repoFullName 
          ? `Working on bounty for ${bounty.repoFullName}${bounty.issueId ? ` #${bounty.issueId}` : ''}`
          : `Bounty assigned - PR in progress`,
        timestamp: bounty.updatedAt?.toISOString() || bounty.createdAt?.toISOString() || new Date().toISOString(),
        metadata: {
          amount: bounty.amount,
          currency: bounty.currencyType as 'XDC' | 'ROXN' | 'USDC',
          repoName: bounty.repoFullName || undefined,
          issueId: bounty.issueId || undefined
        }
      }));
    } catch (error: any) {
      log(`Error fetching contribution activities: ${error.message}`, 'activity-ERROR');
      return [];
    }
  }
}

export const activityService = new ActivityService();

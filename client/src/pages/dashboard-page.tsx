import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { STAGING_API_URL } from "@/config";
import { ethers } from "ethers";
import { ShareAchievementModal, useShareAchievement } from "@/components/share-achievement-modal";
import {
  Wallet,
  TrendingUp,
  GitPullRequest,
  Coins,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  DollarSign,
  Activity,
  Clock,
  ExternalLink,
  RefreshCw,
  Crown,
  Gift,
  ChevronRight,
  Share2,
} from "lucide-react";

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
  },
};

// Stat Card Component
function StatCard({
  icon,
  label,
  value,
  subValue,
  trend,
  color = "primary",
  loading = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  trend?: { value: number; positive: boolean };
  color?: "cyan" | "purple" | "green" | "primary";
  loading?: boolean;
}) {
  const colorClasses = {
    cyan: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
    purple: "text-violet-500 bg-violet-500/10 border-violet-500/20",
    green: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    primary: "text-primary bg-primary/10 border-primary/20",
  };

  return (
    <motion.div
      variants={itemVariants}
      className="card-noir p-6 group"
    >
      <div className="flex items-start justify-between mb-4">
        <div className={`p-3 rounded-xl ${colorClasses[color]}`}>
          {icon}
        </div>
        {trend && (
          <div
            className={`flex items-center gap-1 text-sm font-medium ${
              trend.positive ? "text-emerald-500" : "text-red-500"
            }`}
          >
            {trend.positive ? (
              <ArrowUpRight className="w-4 h-4" />
            ) : (
              <ArrowDownRight className="w-4 h-4" />
            )}
            {trend.value}%
          </div>
        )}
      </div>

      <div className="space-y-1">
        <p className="stat-label">{label}</p>
        {loading ? (
          <Skeleton className="h-10 w-32" />
        ) : (
          <p className="stat-value">{value}</p>
        )}
        {subValue && (
          <p className="text-sm text-muted-foreground">{subValue}</p>
        )}
      </div>
    </motion.div>
  );
}

// Recent Activity Item
function ActivityItem({
  type,
  title,
  description,
  time,
  amount,
  currency,
  txHash,
  repoName,
  issueId,
  onShare,
}: {
  type: "reward" | "contribution" | "subscription" | "referral";
  title: string;
  description: string;
  time: string;
  amount?: string;
  currency?: string;
  txHash?: string;
  repoName?: string;
  issueId?: number;
  onShare?: () => void;
}) {
  const icons = {
    reward: <Coins className="w-4 h-4 text-emerald-500" />,
    contribution: <GitPullRequest className="w-4 h-4 text-cyan-500" />,
    subscription: <Crown className="w-4 h-4 text-yellow-500" />,
    referral: <Gift className="w-4 h-4 text-violet-500" />,
  };

  // Build link based on activity type
  const getLink = () => {
    if (txHash) {
      return `https://xdcscan.io/tx/${txHash.replace(/^xdc/, "0x")}`;
    }
    if (repoName) {
      return `https://github.com/${repoName}`;
    }
    return null;
  };

  const link = getLink();

  return (
    <motion.div
      variants={itemVariants}
      className="flex items-start gap-4 p-4 rounded-xl hover:bg-card/50 transition-colors group"
    >
      <div className="p-2 rounded-lg bg-card border border-border/50">
        {icons[type]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium truncate">{title}</h4>
          {amount && (
            <Badge variant="outline" className="text-xs font-mono flex-shrink-0">
              +{amount} {currency}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground truncate">{description}</p>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {time}
          </p>
          {/* Share button for reward type activities */}
          {type === "reward" && amount && onShare && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-violet-500 hover:text-violet-400 hover:bg-violet-500/10"
              onClick={(e) => {
                e.stopPropagation();
                onShare();
              }}
            >
              <Share2 className="w-3 h-3" />
              Share
            </Button>
          )}
        </div>
      </div>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
      ) : (
        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </motion.div>
  );
}

// Quick Action Button
function QuickAction({
  icon,
  label,
  href,
  variant = "default",
}: {
  icon: React.ReactNode;
  label: string;
  href: string;
  variant?: "default" | "primary";
}) {
  return (
    <Link href={href}>
      <motion.div
        variants={itemVariants}
        className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-300 cursor-pointer ${
          variant === "primary"
            ? "bg-primary/10 border-primary/30 hover:bg-primary/20 hover:border-primary/50"
            : "bg-card/50 border-border/50 hover:bg-card hover:border-border"
        }`}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        <div className={`p-2 rounded-lg ${variant === "primary" ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
          {icon}
        </div>
        <span className="font-medium">{label}</span>
        <ArrowUpRight className="w-4 h-4 ml-auto text-muted-foreground" />
      </motion.div>
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: walletInfo, isLoading: walletLoading, refetch: refetchWallet } = useWallet();
  
  const { isOpen: isShareModalOpen, achievementData, openShareModal, closeShareModal } = useShareAchievement();

  // Fetch subscription status
  const { data: subscriptionStatus } = useQuery({
    queryKey: ["/api/subscription/status"],
    queryFn: async () => {
      const response = await fetch(`${STAGING_API_URL}/api/subscription/status`, {
        credentials: "include",
      });
      if (!response.ok) return { active: false };
      return response.json();
    },
    enabled: !!user,
  });

  // Fetch referral stats
  const { data: referralStats } = useQuery({
    queryKey: ["/api/referral/stats"],
    queryFn: async () => {
      const response = await fetch(`${STAGING_API_URL}/api/referral/stats`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!user,
  });

  // Fetch real activity data
  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ["/api/user/activity"],
    queryFn: async () => {
      const response = await fetch(`${STAGING_API_URL}/api/user/activity?limit=10`, {
        credentials: "include",
      });
      if (!response.ok) return { activities: [] };
      return response.json();
    },
    enabled: !!user,
    staleTime: 60 * 1000,
  });

  // Format balances
  const xdcBalance = walletInfo?.balance
    ? parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4)
    : "0.0000";

  const roxnBalance = walletInfo?.tokenBalance
    ? parseFloat(ethers.formatEther(walletInfo.tokenBalance)).toFixed(2)
    : "0.00";

  // Helper function to format relative time
  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays < 30) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    return date.toLocaleDateString();
  };

  // Transform activity data for display
  const recentActivity = activityData?.activities?.map((activity: any) => ({
    id: activity.id,
    type: activity.type,
    title: activity.title,
    description: activity.description,
    time: formatRelativeTime(activity.timestamp),
    amount: activity.metadata?.amount,
    currency: activity.metadata?.currency,
    txHash: activity.metadata?.txHash,
    repoName: activity.metadata?.repoName,
    issueId: activity.metadata?.issueId,
  })) || [];

  interface ActivityData {
    amount?: string;
    currency?: 'XDC' | 'ROXN' | 'USDC';
    repoName?: string;
    issueId?: number;
    txHash?: string;
  }

  const handleShareActivity = (activity: ActivityData) => {
    openShareModal({
      amount: activity.amount || '0',
      currency: (activity.currency || 'ROXN') as 'XDC' | 'ROXN' | 'USDC',
      projectName: activity.repoName,
      issueNumber: activity.issueId,
      transactionHash: activity.txHash,
    });
  };

  return (
    <div className="min-h-screen bg-background noise-bg">
      {/* Share Achievement Modal */}
      <ShareAchievementModal 
        isOpen={isShareModalOpen}
        onClose={closeShareModal}
        achievementData={achievementData}
      />
      <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
        >
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl sm:text-4xl font-bold">
                Welcome back, <span className="gradient-text-cyan">{user?.githubUsername}</span>
              </h1>
              {subscriptionStatus?.active && (
                <Badge className="bg-gradient-to-r from-yellow-500/20 to-orange-500/20 text-orange-600 border-orange-500/30">
                  <Crown className="w-3 h-3 mr-1" />
                  Premium
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground">
              Here's what's happening with your contributions
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchWallet()}
            className="self-start"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </motion.div>

        {/* Stats Grid */}
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <StatCard
            icon={<Zap className="w-5 h-5" />}
            label="XDC Balance"
            value={`${xdcBalance} XDC`}
            subValue={walletInfo?.address ? `${walletInfo.address.slice(0, 8)}...` : undefined}
            color="cyan"
            loading={walletLoading}
          />
          <StatCard
            icon={<Coins className="w-5 h-5" />}
            label="ROXN Balance"
            value={`${roxnBalance} ROXN`}
            color="purple"
            loading={walletLoading}
          />
          <StatCard
            icon={<GitPullRequest className="w-5 h-5" />}
            label="Contributions"
            value="12"
            subValue="This month"
            trend={{ value: 15, positive: true }}
            color="green"
          />
          <StatCard
            icon={<TrendingUp className="w-5 h-5" />}
            label="Total Earned"
            value="2,450 XDC"
            subValue="All time"
            color="primary"
          />
        </motion.div>

        {/* Main Content Grid */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent Activity - Larger Column */}
          <motion.div
            className="lg:col-span-2 card-noir p-6"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10 text-primary">
                  <Activity className="w-5 h-5" />
                </div>
                <h2 className="text-xl font-semibold">Recent Activity</h2>
              </div>
              <Link href="/wallet">
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                  View All
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>

            <div className="space-y-2">
              {activityLoading ? (
                <>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-start gap-4 p-4 rounded-xl">
                      <Skeleton className="w-10 h-10 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                        <Skeleton className="h-3 w-1/4" />
                      </div>
                    </div>
                  ))}
                </>
              ) : recentActivity.length > 0 ? (
                recentActivity.map((activity: any, index: number) => (
                  <ActivityItem 
                    key={activity.id || index} 
                    {...activity}
                    onShare={() => handleShareActivity(activity)}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No recent activity</p>
                  <p className="text-sm">Start contributing to see your activity here</p>
                </div>
              )}
            </div>
          </motion.div>

          {/* Quick Actions - Smaller Column */}
          <motion.div
            className="space-y-6"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            {/* Quick Actions Card */}
            <div className="card-noir p-6">
              <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
              <div className="space-y-3">
                <QuickAction
                  icon={<GitPullRequest className="w-4 h-4" />}
                  label="Browse Bounties"
                  href="/repos"
                  variant="primary"
                />
                <QuickAction
                  icon={<Wallet className="w-4 h-4" />}
                  label="View Wallet"
                  href="/wallet"
                />
                <QuickAction
                  icon={<Gift className="w-4 h-4" />}
                  label="Refer Friends"
                  href="/referrals"
                />
              </div>
            </div>

            {/* Referral Stats Card */}
            {referralStats && (
              <motion.div variants={itemVariants} className="card-noir p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 rounded-lg bg-violet-500/10 text-violet-500">
                    <Gift className="w-5 h-5" />
                  </div>
                  <h2 className="text-xl font-semibold">Referrals</h2>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Friends Invited</span>
                    <span className="font-mono font-semibold">{referralStats.totalReferrals || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Earned Rewards</span>
                    <Badge variant="outline" className="font-mono badge-xdc">
                      {referralStats.totalEarned || 0} XDC
                    </Badge>
                  </div>
                </div>

                <Link href="/referrals">
                  <Button variant="outline" className="w-full mt-4" size="sm">
                    Invite More Friends
                    <ArrowUpRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              </motion.div>
            )}

            {/* Wallet Address Card */}
            <motion.div variants={itemVariants} className="card-noir p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-500">
                  <Wallet className="w-5 h-5" />
                </div>
                <h2 className="text-lg font-semibold">Your Wallet</h2>
              </div>

              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-muted/50 font-mono text-xs break-all">
                  {walletInfo?.address || "Loading..."}
                </div>

                <a
                  href={
                    walletInfo?.address
                      ? `https://xdcscan.io/address/${walletInfo.address.replace(/^xdc/, "0x")}`
                      : "#"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  View on XDCScan
                </a>
              </div>
            </motion.div>
          </motion.div>
        </div>

        {/* Premium Upsell (for non-premium users) */}
        {!subscriptionStatus?.active && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.5 }}
            className="card-noir p-8 relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-violet-500/10 via-transparent to-cyan-500/10" />
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/50 to-transparent" />

            <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="p-4 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20">
                  <Crown className="w-8 h-8 text-violet-500" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold">Upgrade to Premium</h3>
                  <p className="text-muted-foreground">
                    Unlock courses, higher bounties, and exclusive features
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-3xl font-bold">$10</p>
                  <p className="text-sm text-muted-foreground">/year</p>
                </div>
                <Link href="/membership">
                  <Button className="btn-primary px-6">
                    Get Premium
                    <ArrowUpRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

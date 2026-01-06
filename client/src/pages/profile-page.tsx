import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useWallet } from "@/hooks/use-wallet";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, Globe, MapPin, Wallet, AlertCircle, ChevronRight, DollarSign, Zap, Coins, ExternalLink, Shield, CheckCircle } from "lucide-react";
import { Redirect, Link } from "wouter";
import { ethers } from "ethers";
import { MyRepositories } from "@/components/my-repositories";
import { ReferralWidget } from "@/components/referral-widget";
import { useQuery } from '@tanstack/react-query';
import React from 'react';

// GitHub Icon component
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
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

// New hook for USDC balance
const useUsdcBalance = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['usdcBalance', user?.id],
    queryFn: async (): Promise<string> => {
      if (!user?.id) throw new Error('User not authenticated');

      const response = await fetch(`/api/wallet/multi-currency-balances/${user.id}`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to fetch wallet balances');
      }

      const balances = await response.json();
      const usdcBalance = balances.find((b: any) => b.currency === 'USDC');
      return usdcBalance?.balance || '0.00';
    },
    enabled: !!user?.id,
    staleTime: 30000,
  });
};

// Balance Card Component
function BalanceCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: "cyan" | "purple" | "blue";
}) {
  const colorClasses = {
    cyan: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
    purple: "bg-violet-500/10 text-violet-500 border-violet-500/20",
    blue: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  };

  return (
    <motion.div
      variants={itemVariants}
      className={`card-noir p-5 border ${colorClasses[color].split(' ')[2]}`}
    >
      <div className={`inline-flex p-2 rounded-lg ${colorClasses[color].split(' ').slice(0, 2).join(' ')} mb-3`}>
        {icon}
      </div>
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold font-mono">{value}</p>
    </motion.div>
  );
}

export default function ProfilePage() {
  const { user, loading } = useAuth();
  const { data: walletInfo, isLoading: walletLoading } = useWallet();
  const { data: usdcBalance, isLoading: usdcLoading } = useUsdcBalance();

  if (!loading && !user) {
    return <Redirect to="/auth" />;
  }

  const formattedXdcBalance = walletInfo?.balance
    ? parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4)
    : "0.0000";

  const formattedRoxnBalance = walletInfo?.tokenBalance
    ? parseFloat(ethers.formatEther(walletInfo.tokenBalance)).toFixed(2)
    : "0.00";

  const formattedUsdcBalance = usdcBalance
    ? parseFloat(usdcBalance).toFixed(2)
    : "0.00";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background noise-bg">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-8"
        >
          {/* Header */}
          <motion.div variants={itemVariants}>
            <h1 className="text-3xl font-bold mb-2">
              <span className="gradient-text-purple">Profile</span>
            </h1>
            <p className="text-muted-foreground">Manage your account and view your stats</p>
          </motion.div>

          {user && (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Profile Card */}
              <motion.div variants={itemVariants} className="card-noir overflow-hidden">
                {/* Header Banner */}
                <div className="h-24 bg-gradient-to-r from-violet-600 via-purple-600 to-cyan-600 relative">
                  <div className="absolute inset-0 bg-[url('data:image/svg+xml,...')] opacity-10" />
                </div>

                <div className="px-6 pb-6">
                  {/* Avatar */}
                  <div className="flex items-end -mt-12 gap-4">
                    <div className="relative">
                      <img
                        src={user.avatarUrl || ""}
                        alt={user.username}
                        className="h-24 w-24 rounded-2xl ring-4 ring-background object-cover"
                      />
                      <Badge className="absolute -bottom-2 -right-2 bg-emerald-500">
                        {user.role}
                      </Badge>
                    </div>
                    <div className="pb-2">
                      <h2 className="text-2xl font-bold">{user.name || user.username}</h2>
                      <p className="text-muted-foreground">@{user.githubUsername}</p>
                    </div>
                  </div>

                  {/* Bio */}
                  {user.bio && (
                    <p className="mt-4 text-muted-foreground">{user.bio}</p>
                  )}

                  {/* Info Grid */}
                  <div className="mt-6 space-y-3">
                    {user.email && (
                      <div className="flex items-center gap-3 text-sm">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <span>{user.email}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-sm">
                      <GitHubIcon className="h-4 w-4 text-muted-foreground" />
                      <a
                        href={`https://github.com/${user.githubUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        github.com/{user.githubUsername}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    {user.location && (
                      <div className="flex items-center gap-3 text-sm">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span>{user.location}</span>
                      </div>
                    )}

                    {user.website && (
                      <div className="flex items-center gap-3 text-sm">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <a
                          href={user.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {user.website.replace(/^https?:\/\//, '')}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>

              {/* Wallet Section */}
              <div className="space-y-6">
                {/* Wallet Card */}
                <motion.div variants={itemVariants} className="card-noir p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/10 text-primary">
                        <Wallet className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-semibold">XDC Wallet</h3>
                        <p className="text-sm text-muted-foreground">Your blockchain wallet</p>
                      </div>
                    </div>
                    <Link href="/wallet">
                      <Button variant="outline" size="sm">
                        Manage
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </Link>
                  </div>

                  {/* Mainnet Alert */}
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4">
                    <Shield className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm">
                      <span className="font-medium text-amber-500">Live on XDC Mainnet</span>
                      <p className="text-muted-foreground text-xs mt-0.5">
                        All transactions involve real tokens with actual value.
                      </p>
                    </div>
                  </div>

                  {/* Wallet Address */}
                  {walletInfo?.address && (
                    <div className="p-3 rounded-xl bg-muted/50 font-mono text-sm break-all">
                      {walletInfo.address}
                    </div>
                  )}
                </motion.div>

                {/* Balance Cards */}
                <motion.div
                  variants={containerVariants}
                  className="grid grid-cols-3 gap-4"
                >
                  <BalanceCard
                    icon={<Zap className="h-4 w-4" />}
                    label="XDC"
                    value={formattedXdcBalance}
                    color="cyan"
                  />
                  <BalanceCard
                    icon={<Coins className="h-4 w-4" />}
                    label="ROXN"
                    value={formattedRoxnBalance}
                    color="purple"
                  />
                  <BalanceCard
                    icon={<DollarSign className="h-4 w-4" />}
                    label="USDC"
                    value={formattedUsdcBalance}
                    color="blue"
                  />
                </motion.div>

                {/* Referral Widget */}
                <motion.div variants={itemVariants}>
                  <ReferralWidget />
                </motion.div>
              </div>
            </div>
          )}

          {/* Account Settings Section */}
          <motion.div variants={itemVariants} className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold">
                <span className="gradient-text-purple">Account Settings</span>
              </h2>
              <p className="text-muted-foreground">Manage your email preferences and account</p>
            </div>

            {/* Visual separator */}
            <div className="h-px w-full bg-gradient-to-r from-transparent via-purple-500 to-transparent"></div>

            {/* Email Notifications Card */}
            <motion.div variants={itemVariants} className="card-noir p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold">Email Notifications</h3>
                  <p className="text-sm text-muted-foreground">
                    Includes bounty alerts and platform updates
                  </p>
                </div>
                <EmailNotificationsToggle />
              </div>
            </motion.div>

            {/* Delete Account Card */}
            <motion.div variants={itemVariants} className="card-noir p-6 border-red-500/20">
              <div className="flex items-start gap-4">
                <div className="p-2 rounded-lg bg-red-500/10 text-red-500">
                  <AlertCircle className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-red-500">Delete Account</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Permanently delete your account and all associated data. This action cannot be undone.
                  </p>
                  <DeleteAccountButton />
                </div>
              </div>
            </motion.div>
          </motion.div>

          {/* Pool Manager Section */}
          {user?.role === 'poolmanager' && (
            <motion.div variants={itemVariants} className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold">
                    <span className="gradient-text-cyan">Pool Manager Dashboard</span>
                  </h2>
                  <p className="text-muted-foreground">Manage your repositories and bounties</p>
                </div>
                <Link href="/faq#pool-manager">
                  <Button variant="outline" size="sm">
                    Learn More
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </Link>
              </div>

              {/* Info Banner */}
              <div className="card-noir p-4 flex items-start gap-3 border-l-4 border-l-cyan-500">
                <AlertCircle className="h-5 w-5 text-cyan-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-cyan-500">Pool Manager Guide</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Add funds to repositories, assign rewards to issues, and distribute payouts to contributors.
                  </p>
                </div>
              </div>

              <MyRepositories />
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

// Email Notifications Toggle Component
function EmailNotificationsToggle() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [optOut, setOptOut] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const fetchPreferences = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/user/email-preferences', {
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error('Failed to fetch email preferences');
        }

        const data = await response.json();
        setOptOut(data.optOut);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load preferences';
        setError(errorMessage);
        toast({
          title: 'Error Loading Preferences',
          description: errorMessage,
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchPreferences();
    }
  }, [user, toast]);

  const updatePreferences = async (newOptOut: boolean) => {
    try {
      setLoading(true);
      setError(null);

      // Retrieve CSRF token from cookie (standard in this application)
      const getCookie = (name: string) => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop()?.split(';').shift();
      };

      // Get CSRF token and verify it exists
      const csrfToken = getCookie('csrfToken') || getCookie('_csrf') || null;

      if (!csrfToken) {
        throw new Error('CSRF token not found. Please refresh the page and try again.');
      }

      const response = await fetch('/api/user/email-preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ optOut: newOptOut })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update preferences');
      }

      setOptOut(newOptOut);

      // Show success toast
      toast({
        title: 'Preferences Updated',
        description: newOptOut
          ? 'Email notifications have been turned off'
          : 'Email notifications have been turned on',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update preferences';
      setError(errorMessage);
      toast({
        title: 'Update Failed',
        description: errorMessage,
        variant: 'destructive',
      });
      // Revert the toggle if it failed
      setOptOut(!newOptOut);
    } finally {
      setLoading(false);
    }
  };

  // Loading skeleton
  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-6 w-11 bg-gray-300/50 animate-pulse rounded-full"></div>
        <span className="text-sm font-medium text-gray-300 animate-pulse">ON</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => updatePreferences(!optOut)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
            optOut ? 'bg-gray-300' : 'bg-primary'
          }`}
          disabled={loading}
          aria-label={optOut ? 'Email notifications are turned off' : 'Email notifications are turned on'}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              optOut ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm font-medium">
          {optOut ? 'OFF' : 'ON'}
        </span>
      </div>
      {error && (
        <div className="text-red-500 text-xs">
          Error: {error}
        </div>
      )}
    </div>
  );
}

// Constant for redirect countdown duration (in seconds)
const REDIRECT_COUNTDOWN_SECONDS = 2;

// Delete Account Button Component
function DeleteAccountButton() {
  const { user } = useAuth();
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [confirmUsername, setConfirmUsername] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  const handleDelete = async () => {
    if (confirmUsername.toLowerCase() !== user?.username?.toLowerCase()) {
      setError('Username does not match');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Retrieve CSRF token from cookie (standard in this application)
      // Get the CSRF token from the cookie
      const getCookie = (name: string) => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop()?.split(';').shift();
      };

      // Get CSRF token and verify it exists
      const csrfToken = getCookie('csrfToken') || getCookie('_csrf') || null;

      if (!csrfToken) {
        throw new Error('CSRF token not found. Please refresh the page and try again.');
      }

      const response = await fetch('/api/user/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ confirmUsername })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete account');
      }

      setSuccess(true);
      // Success state triggers useEffect to handle redirect after countdown
      // Redirect handled by useEffect in success state (line ~571-576)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account');
    } finally {
      setLoading(false);
    }
  };

  // Include redirect countdown in success state - must be at top level
  const [countdown, setCountdown] = React.useState(REDIRECT_COUNTDOWN_SECONDS);

  React.useEffect(() => {
    if (success && countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else if (success && countdown === 0) {
      window.location.href = '/auth';
    }
  }, [countdown, success]);

  if (success) {
    return (
      <div className="text-green-500">
        <CheckCircle className="h-5 w-5 inline mr-2" />
        Account deleted successfully. Redirecting in {countdown}s...
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">
          Please type your username <span className="font-mono font-bold">{user?.username}</span> to confirm deletion:
        </div>
        <div className="space-y-2">
          <Input
            type="text"
            value={confirmUsername}
            onChange={(e) => setConfirmUsername(e.target.value)}
            placeholder={user?.username}
            className="max-w-xs"
          />
          {error && <div className="text-red-500 text-sm">{error}</div>}
        </div>
        <div className="flex gap-2">
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading || confirmUsername.toLowerCase() !== user?.username?.toLowerCase()}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Deleting...
              </>
            ) : (
              'Confirm Delete'
            )}
          </Button>
          {/* Make Cancel a text button instead of outlined for better hierarchy */}
          <Button
            variant="ghost"
            onClick={() => {
              setShowConfirm(false);
              setConfirmUsername('');
              setError(null);
            }}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Button
        variant="destructive"
        onClick={() => setShowConfirm(true)}
        className="w-fit"
      >
        Delete Account
      </Button>
      {error && <div className="text-red-500 text-sm mt-2">{error}</div>}
    </>
  );
}


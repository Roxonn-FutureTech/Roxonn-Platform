import { useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useWallet } from "@/hooks/use-wallet";
import { Loader2, Plus, RefreshCw, Wallet, Sparkles, AlertCircle, Zap, Coins } from "lucide-react";
import { ethers } from "ethers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Helmet } from "react-helmet";
import { Redirect } from "wouter";
import { STAGING_API_URL } from "@/config";
import { useNotification } from "@/components/ui/notification";

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

export default function VSCodeWalletPage() {
  const { user, loading } = useAuth();
  const { data: walletInfo, isLoading, refetch } = useWallet();
  const { addNotification } = useNotification();

  const [isBuyingXdc, setIsBuyingXdc] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);

  if (!loading && !user) {
    return <Redirect to="/auth?source=vscode" />;
  }

  const handleBuyXdc = async () => {
    try {
      setIsBuyingXdc(true);
      setBuyError(null);

      const response = await fetch(`${STAGING_API_URL}/api/wallet/buy-xdc-url`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.message || `API error: ${response.status}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();

      addNotification({
        type: 'info',
        title: 'Purchase Initiated',
        message: 'You will be redirected to complete your USDC purchase.',
        duration: 5000
      });

      window.open(data.url, '_blank');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to initiate USDC purchase';
      console.error('Error initiating USDC purchase:', error);
      setBuyError(errorMessage);

      addNotification({
        type: 'error',
        title: 'Purchase Error',
        message: errorMessage,
        duration: 10000
      });
    } finally {
      setIsBuyingXdc(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>Wallet | Roxonn Code</title>
      </Helmet>

      <div className="min-h-screen bg-background noise-bg">
        {/* Background Effects */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-[400px] h-[400px] bg-cyan-500/10 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-[300px] h-[300px] bg-violet-500/10 rounded-full blur-3xl" />
        </div>

        <div className="max-w-2xl mx-auto px-4 py-8 relative z-10">
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="space-y-6"
          >
            {/* Header */}
            <motion.div variants={itemVariants} className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 mb-2">
                  <Wallet className="h-3 w-3 text-cyan-400" />
                  <span className="text-xs text-cyan-400">VSCode Extension</span>
                </div>
                <h1 className="text-2xl font-bold">
                  <span className="gradient-text-cyan">Roxonn Code Wallet</span>
                </h1>
                <p className="text-sm text-muted-foreground">
                  Manage your wallet and AI credits
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isLoading}
                className="border-border/50 hover:border-cyan-500/50"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="ml-2">Refresh</span>
              </Button>
            </motion.div>

            {isLoading ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* AI Credits Card */}
                <motion.div variants={itemVariants} className="card-noir p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <h3 className="font-semibold">AI Credits</h3>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-4xl font-bold font-mono gradient-text-purple">
                        {user?.promptBalance !== undefined ? user.promptBalance : 0}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">credits remaining</p>
                    </div>
                    <div className="text-right">
                      <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30">
                        AI Completions
                      </Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-4 pt-4 border-t border-border/50">
                    Each credit allows one AI completion request in VSCode.
                  </p>
                </motion.div>

                {/* Wallet Card */}
                <motion.div variants={itemVariants} className="card-noir p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
                      <Wallet className="h-5 w-5" />
                    </div>
                    <h3 className="font-semibold">Wallet Details</h3>
                  </div>

                  {walletInfo?.address ? (
                    <div className="space-y-6">
                      {/* Address */}
                      <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
                        <p className="text-xs text-muted-foreground mb-1">Address</p>
                        <p className="font-mono text-sm break-all">{walletInfo.address}</p>
                      </div>

                      {/* Balances */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
                          <div className="flex items-center gap-2 mb-2">
                            <Zap className="h-4 w-4 text-cyan-400" />
                            <span className="text-xs text-muted-foreground">XDC</span>
                          </div>
                          <p className="text-xl font-bold font-mono text-cyan-400">
                            {walletInfo?.balance ? parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4) : '0'}
                          </p>
                        </div>
                        <div className="p-4 rounded-xl bg-violet-500/10 border border-violet-500/20">
                          <div className="flex items-center gap-2 mb-2">
                            <Coins className="h-4 w-4 text-violet-400" />
                            <span className="text-xs text-muted-foreground">ROXN</span>
                          </div>
                          <p className="text-xl font-bold font-mono text-violet-400">
                            {walletInfo?.tokenBalance ? parseFloat(ethers.formatEther(walletInfo.tokenBalance)).toFixed(2) : '0'}
                          </p>
                        </div>
                      </div>

                      {/* Buy USDC Button */}
                      <div className="pt-4 border-t border-border/50">
                        <Button
                          className="w-full btn-primary"
                          onClick={handleBuyXdc}
                          disabled={isBuyingXdc}
                        >
                          {isBuyingXdc ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Preparing...
                            </>
                          ) : (
                            <>
                              <Plus className="h-4 w-4 mr-2" />
                              Buy USDC on XDC
                            </>
                          )}
                        </Button>
                        <p className="text-xs text-muted-foreground text-center mt-2">
                          Purchase USDC on XDC Network to get more AI credits
                        </p>
                        {buyError && (
                          <div className="flex items-center gap-2 mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                            <span className="text-xs text-red-400">{buyError}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                      <AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0" />
                      <span className="text-sm text-amber-400">No wallet connected. Please check your profile settings.</span>
                    </div>
                  )}
                </motion.div>
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </>
  );
}

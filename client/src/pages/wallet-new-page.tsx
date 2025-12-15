import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Redirect } from "wouter";
import { ethers } from "ethers";
import { useQuery } from "@tanstack/react-query";
import { STAGING_API_URL } from "@/config";
import { WalletExport } from "@/components/wallet-export";
import { QRCodeSVG } from "qrcode.react";
import { useNotification } from "@/components/ui/notification";
import {
  Wallet,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Zap,
  Coins,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  ArrowDownUp,
  Plus,
  QrCode,
  Shield,
  TrendingUp,
  Clock,
  ChevronRight,
  Loader2,
  Send,
} from "lucide-react";
import { useTransactions } from "@/hooks/use-transactions";
import csrfService from "@/lib/csrf";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog";

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

// Balance Card Component
function BalanceCard({
  icon,
  name,
  symbol,
  balance,
  color,
  loading = false,
}: {
  icon: React.ReactNode;
  name: string;
  symbol: string;
  balance: string;
  color: "cyan" | "purple" | "blue";
  loading?: boolean;
}) {
  const colorClasses = {
    cyan: {
      bg: "bg-cyan-500/10",
      border: "border-cyan-500/20",
      text: "text-cyan-500",
      glow: "shadow-cyan-500/20",
    },
    purple: {
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
      text: "text-violet-500",
      glow: "shadow-violet-500/20",
    },
    blue: {
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
      text: "text-blue-500",
      glow: "shadow-blue-500/20",
    },
  };

  const classes = colorClasses[color];

  return (
    <motion.div
      variants={itemVariants}
      className={`card-noir p-6 ${classes.border} hover:shadow-xl hover:${classes.glow} transition-all duration-500`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className={`p-3 rounded-xl ${classes.bg} ${classes.text}`}>
          {icon}
        </div>
        <Badge variant="outline" className={`${classes.bg} ${classes.text} ${classes.border} text-xs font-mono`}>
          XDC Network
        </Badge>
      </div>

      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{name}</p>
        {loading ? (
          <div className="h-10 flex items-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <p className={`stat-value ${classes.text}`}>{balance}</p>
        )}
        <p className="text-sm text-muted-foreground font-mono">{symbol}</p>
      </div>
    </motion.div>
  );
}

// Transaction Item Component
function TransactionItem({
  type,
  amount,
  currency,
  hash,
  timestamp,
  status,
}: {
  type: "in" | "out";
  amount: string;
  currency: string;
  hash: string;
  timestamp: string;
  status: "confirmed" | "pending";
}) {
  return (
    <motion.div
      variants={itemVariants}
      className="flex items-center justify-between p-4 rounded-xl hover:bg-card/50 transition-colors group"
    >
      <div className="flex items-center gap-4">
        <div
          className={`p-2 rounded-lg ${type === "in"
            ? "bg-emerald-500/10 text-emerald-500"
            : "bg-rose-500/10 text-rose-500"
            }`}
        >
          {type === "in" ? (
            <ArrowDownRight className="w-5 h-5" />
          ) : (
            <ArrowUpRight className="w-5 h-5" />
          )}
        </div>
        <div>
          <p className="font-medium">
            {type === "in" ? "Received" : "Sent"} {currency}
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {hash.slice(0, 10)}...{hash.slice(-8)}
          </p>
        </div>
      </div>

      <div className="text-right">
        <p
          className={`font-mono font-semibold ${type === "in" ? "text-emerald-500" : "text-rose-500"
            }`}
        >
          {type === "in" ? "+" : "-"}{amount} {currency}
        </p>
        <div className="flex items-center gap-2 justify-end">
          <span className="text-xs text-muted-foreground">{timestamp}</span>
          {status === "pending" && (
            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/30">
              Pending
            </Badge>
          )}
        </div>
      </div>

      <a
        href={`https://xdcscan.io/tx/${hash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="opacity-0 group-hover:opacity-100 transition-opacity ml-2"
      >
        <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-primary" />
      </a>
    </motion.div>
  );
}

// QR Modal Component
function QRModal({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="text-center">
        <h3 className="text-xl font-bold mb-2">Receive Funds</h3>
        <p className="text-sm text-muted-foreground">
          Scan QR code or copy address to receive XDC
        </p>
      </div>

      <div className="flex justify-center">
        <div className="p-4 bg-white rounded-2xl">
          <QRCodeSVG
            value={`xdc:${address.replace("xdc", "")}`}
            size={200}
            level="H"
            includeMargin
          />
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground text-center">Your XDC Address</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 p-3 rounded-xl bg-muted font-mono text-sm break-all">
            {address}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={copyAddress}
            className="flex-shrink-0"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-500" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm">
        <Shield className="w-4 h-4 text-amber-500 flex-shrink-0" />
        <span className="text-amber-500">Only send XDC Network assets to this address</span>
      </div>
    </div>
  );
}

export default function WalletNewPage() {
  const { user, loading: authLoading } = useAuth();
  const { data: walletInfo, isLoading: walletLoading, refetch } = useWallet();
  const { data: realTransactions, isLoading: isTransactionsLoading, refetch: refetchTransactions } = useTransactions(20);
  const { addNotification } = useNotification();
  const [copied, setCopied] = useState(false);
  const [isBuying, setIsBuying] = useState(false);
  const [isSelling, setIsSelling] = useState(false);

  // Send state
  const [sendAddress, setSendAddress] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [isConfirmingSend, setIsConfirmingSend] = useState(false);
  const [isSendDialogOpen, setIsSendDialogOpen] = useState(false);

  // Fetch USDC balance
  const { data: usdcBalance, isLoading: usdcLoading, refetch: refetchUsdc } = useQuery({
    queryKey: ["usdcBalance", user?.id],
    queryFn: async (): Promise<string> => {
      if (!user?.id) throw new Error("Not authenticated");
      const response = await fetch(`/api/wallet/multi-currency-balances/${user.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch balances");
      const balances = await response.json();
      const usdc = balances.find((b: { currency: string }) => b.currency === "USDC");
      return usdc?.balance || "0";
    },
    enabled: !!user?.id,
    staleTime: 30000,
  });

  // Format balances
  const xdcBalance = walletInfo?.balance
    ? parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4)
    : "0.0000";

  const roxnBalance = walletInfo?.tokenBalance
    ? parseFloat(ethers.formatEther(walletInfo.tokenBalance)).toFixed(2)
    : "0.00";

  const formattedUsdcBalance = usdcBalance
    ? parseFloat(usdcBalance).toFixed(2)
    : "0.00";

  // Copy address handler
  const copyAddress = () => {
    if (walletInfo?.address) {
      navigator.clipboard.writeText(walletInfo.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Buy XDC handler
  const handleBuy = async () => {
    try {
      setIsBuying(true);
      const response = await fetch(`${STAGING_API_URL}/api/wallet/buy-xdc-url`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to get purchase URL");
      const { url } = await response.json();
      addNotification({
        type: "info",
        title: "Purchase Initiated",
        message: "Redirecting to complete your purchase...",
        duration: 5000,
      });
      window.open(url, "_blank");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Purchase Error",
        message: error instanceof Error ? error.message : "Failed to initiate purchase",
        duration: 10000,
      });
    } finally {
      setIsBuying(false);
    }
  };

  // Sell XDC handler
  const handleSell = async () => {
    try {
      setIsSelling(true);
      const response = await fetch(`${STAGING_API_URL}/api/wallet/sell-xdc-url`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to get withdrawal URL");
      const { url } = await response.json();
      addNotification({
        type: "info",
        title: "Withdrawal Initiated",
        message: "Redirecting to complete your withdrawal...",
        duration: 5000,
      });
      window.open(url, "_blank");
    } catch (error) {
      addNotification({
        type: "error",
        title: "Withdrawal Error",
        message: error instanceof Error ? error.message : "Failed to initiate withdrawal",
        duration: 10000,
      });
    } finally {
      setIsSelling(false);
    }
  };

  // Handle Send XDC
  const handleSend = async () => {
    try {
      const trimmedAddress = sendAddress.trim();
      const trimmedAmount = sendAmount.trim();

      if (!trimmedAddress || !trimmedAmount) {
        addNotification({
          type: "error",
          title: "Validation Error",
          message: "Please enter both address and amount",
          duration: 3000,
        });
        return;
      }

      // Validate address format
      const addressPattern = /^(xdc|0x|XDC|0X)[a-fA-F0-9]{40}$/;
      if (!addressPattern.test(trimmedAddress)) {
        addNotification({
          type: "error",
          title: "Invalid Address",
          message: "Please enter a valid XDC or 0x address",
          duration: 3000,
        });
        return;
      }

      // Validate amount
      const amountNum = parseFloat(trimmedAmount);
      if (isNaN(amountNum) || amountNum <= 0) {
        addNotification({
          type: "error",
          title: "Invalid Amount",
          message: "Please enter a valid positive amount",
          duration: 3000,
        });
        return;
      }

      // Check balance (approximate)
      if (walletInfo?.balance) {
        const balance = parseFloat(ethers.formatEther(walletInfo.balance));
        if (amountNum > balance) {
          addNotification({
            type: "error",
            title: "Insufficient Balance",
            message: `Amount exceeds available balance`,
            duration: 3000,
          });
          return;
        }
      }

      setIsConfirmingSend(true);
      const csrfToken = await csrfService.getToken();

      const response = await fetch(`${STAGING_API_URL}/api/wallet/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
          toAddress: trimmedAddress,
          amount: trimmedAmount,
        }),
      });

      let data;
      try {
        data = await response.json();
      } catch (e) {
        // Handle non-JSON response (e.g. 500 html page)
        throw new Error(response.statusText || "Server error");
      }

      if (!response.ok) {
        throw new Error(data.error || "Failed to send funds");
      }

      addNotification({
        type: "success",
        title: "Transaction Sent",
        message: `Funds sent successfully! Tx: ${data.txHash?.slice(0, 10)}...`,
        duration: 5000,
      });

      // Close dialog and reset state
      setIsSendDialogOpen(false);
      setSendAddress("");
      setSendAmount("");

      // Refresh data
      refetch();
      refetchTransactions();

    } catch (error) {
      addNotification({
        type: "error",
        title: "Transaction Error",
        message: error instanceof Error ? error.message : "Failed to send funds",
        duration: 5000,
      });
    } finally {
      setIsConfirmingSend(false);
    }
  };

  // Auth redirect
  if (!authLoading && !user) {
    return <Redirect to="/auth" />;
  }

  // Map real transactions from API to UI format
  const transactions = realTransactions ? realTransactions.map(tx => {
    // Use tokenAmount from backend if available (properly formatted)
    // Otherwise fall back to formatting the value field
    let formattedAmount = tx.tokenAmount || "0.0000";
    if (!tx.tokenAmount && tx.value && tx.value !== '0') {
      try {
        formattedAmount = ethers.formatEther(tx.value);
      } catch (e) {
        const parsed = parseFloat(tx.value);
        formattedAmount = isNaN(parsed) ? "0.0000" : parsed.toFixed(4);
      }
    }

    return {
      type: (tx.isIncoming ? "in" : "out") as "in" | "out",
      amount: parseFloat(formattedAmount).toFixed(4),
      currency: tx.tokenSymbol || "XDC",  // Use token symbol from backend
      hash: tx.hash,
      timestamp: new Date(tx.timestamp).toLocaleString(),
      status: tx.status,
    };
  }) : [];

  return (
    <div className="min-h-screen bg-background noise-bg">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8"
        >
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold mb-2">
              <span className="gradient-text-cyan">Wallet</span>
            </h1>
            <p className="text-muted-foreground">
              Manage your XDC, ROXN, and USDC balances
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetch();
                refetchUsdc();
                refetchTransactions();
              }}
              disabled={walletLoading || usdcLoading || isTransactionsLoading}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${(walletLoading || usdcLoading || isTransactionsLoading) ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Export to MetaMask
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <WalletExport />
              </DialogContent>
            </Dialog>
          </div>
        </motion.div>

        {/* Wallet Address Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mb-8"
        >
          <div className="card-noir p-6 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5" />
            <div className="relative z-10">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
                <div className="flex items-center gap-4">
                  <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20">
                    <Wallet className="w-8 h-8 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">Your XDC Wallet Address</p>
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-lg break-all">
                        {walletInfo?.address || "Loading..."}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={copyAddress}
                        className="flex-shrink-0"
                      >
                        {copied ? (
                          <Check className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline">
                        <QrCode className="w-4 h-4 mr-2" />
                        Receive
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-md">
                      {walletInfo?.address && <QRModal address={walletInfo.address} />}
                    </DialogContent>
                  </Dialog>

                  <a
                    href={
                      walletInfo?.address
                        ? `https://xdcscan.io/address/${walletInfo.address.replace(/^xdc/, "0x")}`
                        : "#"
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="outline">
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View on XDCScan
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Balance Cards */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <BalanceCard
            icon={<Zap className="w-6 h-6" />}
            name="XDC Balance"
            symbol="XDC"
            balance={xdcBalance}
            color="cyan"
            loading={walletLoading}
          />
          <BalanceCard
            icon={<Coins className="w-6 h-6" />}
            name="ROXN Balance"
            symbol="ROXN"
            balance={roxnBalance}
            color="purple"
            loading={walletLoading}
          />
          <BalanceCard
            icon={<DollarSign className="w-6 h-6" />}
            name="USDC Balance"
            symbol="USDC"
            balance={formattedUsdcBalance}
            color="blue"
            loading={usdcLoading}
          />
        </motion.div>

        {/* Buy/Sell Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8"
        >
          {/* Send XDC Card */}
          <div className="card-noir p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-500">
                <Send className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold">Send XDC</h3>
                <p className="text-sm text-muted-foreground">Transfer to another wallet</p>
              </div>
            </div>

            <Dialog open={isSendDialogOpen} onOpenChange={setIsSendDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  className="w-full btn-primary"
                  variant="outline"
                  disabled={!walletInfo?.address}
                >
                  <Send className="w-4 h-4 mr-2" />
                  Send Funds
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Send XDC</DialogTitle>
                  <DialogDescription>
                    Enter the recipient's wallet address and amount to send.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="address">Recipient Address</Label>
                    <Input
                      id="address"
                      placeholder="xdc... or 0x..."
                      value={sendAddress}
                      onChange={(e) => setSendAddress(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount (XDC)</Label>
                    <div className="relative">
                      <Input
                        id="amount"
                        type="number"
                        placeholder="0.00"
                        value={sendAmount}
                        onChange={(e) => setSendAmount(e.target.value)}
                        className="pr-20"
                      />
                      <div className="absolute inset-y-0 right-12 flex items-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            if (walletInfo?.balance) {
                              const balance = parseFloat(ethers.formatEther(walletInfo.balance));
                              // Leave ~0.01 XDC for gas
                              const maxSend = Math.max(0, balance - 0.01);
                              setSendAmount(maxSend.toFixed(4));
                            }
                          }}
                          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground mr-1"
                        >
                          Max
                        </Button>
                      </div>
                      <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-muted-foreground text-sm">
                        XDC
                      </div>
                    </div>
                    {walletInfo?.balance && (
                      <p className="text-xs text-muted-foreground text-right">
                        Available: {parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4)} XDC
                      </p>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsSendDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSend} disabled={isConfirmingSend || !sendAddress || !sendAmount}>
                    {isConfirmingSend ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Confirm Send
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <p className="text-xs text-muted-foreground mt-2">
              Instant transfer on XDC Network
            </p>
          </div>
          <div className="card-noir p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold">Buy USDC</h3>
                <p className="text-sm text-muted-foreground">Purchase with INR</p>
              </div>
            </div>
            <Button
              className="w-full btn-primary"
              onClick={handleBuy}
              disabled={isBuying || !walletInfo?.address}
            >
              {isBuying ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Buy USDC on XDC with INR
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Powered by Onramp.money
            </p>
          </div>

          <div className="card-noir p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500">
                <ArrowDownUp className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold">Withdraw USDC</h3>
                <p className="text-sm text-muted-foreground">Convert to INR</p>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={handleSell}
              disabled={isSelling || !walletInfo?.address || parseFloat(usdcBalance || "0") <= 0}
            >
              {isSelling ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ArrowDownUp className="w-4 h-4 mr-2" />
              )}
              Withdraw USDC to INR
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Powered by Onramp.money
            </p>
          </div>
        </motion.div>

        {/* Transactions Tab */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          <Tabs defaultValue="all" className="w-full">
            <div className="card-noir p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold flex items-center gap-3">
                  <Clock className="w-5 h-5 text-primary" />
                  Transaction History
                </h2>
                <TabsList className="bg-muted/50">
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="in">Received</TabsTrigger>
                  <TabsTrigger value="out">Sent</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="all" className="mt-0">
                <motion.div
                  className="space-y-2"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                >
                  {isTransactionsLoading && transactions.length === 0 ? (
                    <div className="flex justify-center p-8">
                      <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : transactions.length > 0 ? (
                    transactions.map((tx, index) => (
                      <TransactionItem key={index} {...tx} />
                    ))
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>No transactions yet</p>
                    </div>
                  )}
                </motion.div>
              </TabsContent>

              <TabsContent value="in" className="mt-0">
                <motion.div
                  className="space-y-2"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                >
                  {transactions.filter((tx) => tx.type === "in").length > 0 ? (
                    transactions
                      .filter((tx) => tx.type === "in")
                      .map((tx, index) => <TransactionItem key={index} {...tx} />)
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <ArrowDownRight className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>No incoming transactions</p>
                    </div>
                  )}
                </motion.div>
              </TabsContent>

              <TabsContent value="out" className="mt-0">
                <motion.div
                  className="space-y-2"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                >
                  {transactions.filter((tx) => tx.type === "out").length > 0 ? (
                    transactions
                      .filter((tx) => tx.type === "out")
                      .map((tx, index) => <TransactionItem key={index} {...tx} />)
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <ArrowUpRight className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>No outgoing transactions</p>
                    </div>
                  )}
                </motion.div>
              </TabsContent>
            </div>
          </Tabs>
        </motion.div>

        {/* Security Notice */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Shield className="w-4 h-4 text-amber-500" />
          <span>Live on XDC Mainnet - All transactions involve real tokens</span>
        </motion.div>
      </div>
    </div>
  );
}

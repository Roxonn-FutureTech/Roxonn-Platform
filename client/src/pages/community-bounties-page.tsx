/**
 * Community Bounties Explorer Page
 *
 * WHY THIS PAGE:
 * - Browse all active community bounties
 * - Filter by status, currency, repository
 * - Create new bounties (CLIENT profile only)
 * - Claim bounties by submitting PR (DEVELOPER profile only)
 *
 * PROFILE TYPE RESTRICTIONS:
 * - CLIENT: Can create and fund bounties (create button visible)
 * - DEVELOPER: Can claim bounties (claim button visible on funded bounties)
 *
 * FEATURES:
 * - Search and filter bounties
 * - View bounty details
 * - Create bounty modal (CLIENT only)
 * - Payment flow modal (CLIENT only)
 * - Claim bounty modal (DEVELOPER only)
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, isDeveloper, isClient } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { communityBountiesAPI, type CommunityBounty } from "@/lib/community-bounties-api";
import { Plus, Search, Filter, GitBranch, Coins, Users, ExternalLink, Trophy, Wallet, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const STATUS_COLORS: Record<string, string> = {
  pending_payment: "bg-yellow-500/20 text-yellow-500",
  funded: "bg-green-500/20 text-green-500",
  claimed: "bg-blue-500/20 text-blue-500",
  completed: "bg-purple-500/20 text-purple-500",
  refunded: "bg-gray-500/20 text-gray-500",
  expired: "bg-red-500/20 text-red-500",
  failed_verification: "bg-red-500/20 text-red-500",
};

const CURRENCY_ICONS: Record<string, string> = {
  XDC: "💎",
  ROXN: "🪙",
  USDC: "💵",
};

export default function CommunityBountiesPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all"); // Show all statuses by default
  const [currencyFilter, setCurrencyFilter] = useState<string>("all"); // Show all currencies by default
  const [selectedBounty, setSelectedBounty] = useState<CommunityBounty | null>(null);
  const [claimingBounty, setClaimingBounty] = useState<CommunityBounty | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [claimPrNumber, setClaimPrNumber] = useState("");

  // Create bounty form state
  const [formData, setFormData] = useState({
    githubIssueUrl: "",
    title: "",
    description: "",
    amount: "",
    currency: "USDC" as "XDC" | "ROXN" | "USDC",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["community-bounties", statusFilter, currencyFilter],
    queryFn: () =>
      communityBountiesAPI.getAll({
        status: statusFilter === "all" ? undefined : statusFilter || undefined,
        currency: currencyFilter === "all" ? undefined : currencyFilter || undefined,
        limit: 50,
      }),
  });

  const filteredBounties = data?.bounties.filter((bounty) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      bounty.title.toLowerCase().includes(query) ||
      bounty.description?.toLowerCase().includes(query) ||
      bounty.githubRepoOwner.toLowerCase().includes(query) ||
      bounty.githubRepoName.toLowerCase().includes(query)
    );
  }) || [];

  // Parse GitHub issue URL
  const parseGitHubIssueUrl = (url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      issueNumber: parseInt(match[3]),
    };
  };

  // Pay bounty mutation
  const payBountyMutation = useMutation({
    mutationFn: async (bountyId: number) => {
      console.log('[PAYMENT] Starting payment for bounty:', bountyId);
      try {
        const result = await communityBountiesAPI.pay(bountyId);
        console.log('[PAYMENT] Payment successful:', result);
        return result;
      } catch (error) {
        console.error('[PAYMENT] Payment failed:', error);
        throw error;
      }
    },
    onSuccess: (data) => {
      console.log('[PAYMENT] onSuccess called with:', data);
      toast({
        title: "Payment successful!",
        description: `Bounty funded. TX: ${data.txHash.slice(0, 10)}...`,
      });
      queryClient.invalidateQueries({ queryKey: ["community-bounties"] });
    },
    onError: (error: any) => {
      console.error('[PAYMENT] onError called with:', error);
      toast({
        title: "Payment failed",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  // Create bounty mutation
  const createBountyMutation = useMutation({
    mutationFn: async () => {
      const parsed = parseGitHubIssueUrl(formData.githubIssueUrl);
      if (!parsed) {
        throw new Error("Invalid GitHub issue URL");
      }

      return await communityBountiesAPI.create({
        githubRepoOwner: parsed.owner,
        githubRepoName: parsed.repo,
        githubIssueNumber: parsed.issueNumber,
        githubIssueId: `${parsed.owner}/${parsed.repo}#${parsed.issueNumber}`,
        githubIssueUrl: formData.githubIssueUrl,
        title: formData.title,
        description: formData.description || undefined,
        amount: formData.amount,
        currency: formData.currency,
      });
    },
    onSuccess: (data) => {
      console.log('[CREATE] Bounty created successfully:', data);
      toast({
        title: "Bounty created!",
        description: "Proceeding to payment...",
      });
      queryClient.invalidateQueries({ queryKey: ["community-bounties"] });
      setShowCreateDialog(false);
      // Reset form
      setFormData({
        githubIssueUrl: "",
        title: "",
        description: "",
        amount: "",
        currency: "USDC",
      });
      // Automatically trigger payment
      console.log('[CREATE] Triggering payment for bounty ID:', data.bounty.id);
      payBountyMutation.mutate(data.bounty.id);
    },
    onError: (error: any) => {
      toast({
        title: "Error creating bounty",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  const claimBountyMutation = useMutation({
    mutationFn: async ({ bountyId, prNumber }: { bountyId: number; prNumber: number }) => {
      if (!claimingBounty) {
        throw new Error("No bounty selected");
      }

      const prUrl = `https://github.com/${claimingBounty.githubRepoOwner}/${claimingBounty.githubRepoName}/pull/${prNumber}`;
      return communityBountiesAPI.claim(bountyId, prNumber, prUrl);
    },
    onSuccess: () => {
      toast({
        title: "Bounty claimed",
        description: "Your claim was recorded. Auto-payout will run after the PR merge is verified.",
      });
      setShowClaimDialog(false);
      setClaimPrNumber("");
      setClaimingBounty(null);
      setSelectedBounty(null);
      queryClient.invalidateQueries({ queryKey: ["community-bounties"] });
    },
    onError: (error: any) => {
      toast({
        title: "Claim failed",
        description: error.message || "Please verify the PR number and try again.",
        variant: "destructive",
      });
    },
  });

  const handleCreateBounty = () => {
    if (!formData.githubIssueUrl || !formData.title || !formData.amount) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    const parsed = parseGitHubIssueUrl(formData.githubIssueUrl);
    if (!parsed) {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid GitHub issue URL",
        variant: "destructive",
      });
      return;
    }

    createBountyMutation.mutate();
  };

  const handleClaimBounty = () => {
    if (!claimingBounty) {
      return;
    }

    const prNumber = parseInt(claimPrNumber, 10);
    if (Number.isNaN(prNumber) || prNumber <= 0) {
      toast({
        title: "Invalid PR number",
        description: "Enter the pull request number that closes this issue.",
        variant: "destructive",
      });
      return;
    }

    claimBountyMutation.mutate({
      bountyId: claimingBounty.id,
      prNumber,
    });
  };

  const handleClaimDialogOpenChange = (open: boolean) => {
    setShowClaimDialog(open);
    if (!open) {
      setClaimPrNumber("");
      setClaimingBounty(null);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Community Bounties</h1>
          <p className="text-muted-foreground">
            Permissionless bounties on any public GitHub repository
          </p>
        </div>
        {/* Only Clients can create bounties */}
        {isClient(user) && (
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Bounty
          </Button>
        )}
        {/* Show message to Developers */}
        {isDeveloper(user) && (
          <Badge variant="outline" className="py-2 px-4">
            <Users className="mr-2 h-4 w-4" />
            Browse & Claim Bounties
          </Badge>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Bounties</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.total || 0}</div>
            <p className="text-xs text-muted-foreground">Available to claim</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Value</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {filteredBounties.reduce((sum, b) => sum + parseFloat(b.amount || '0'), 0).toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">Across all currencies</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Contributors</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {new Set(filteredBounties.map(b => b.claimedByGithubUsername).filter(Boolean)).size}
            </div>
            <p className="text-xs text-muted-foreground">Active claimers</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search bounties, repos, or issues..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="funded">Funded</SelectItem>
              <SelectItem value="claimed">Claimed</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="pending_payment">Pending Payment</SelectItem>
            </SelectContent>
          </Select>
          <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
            <SelectTrigger className="w-[150px]">
              <Coins className="mr-2 h-4 w-4" />
              <SelectValue placeholder="All Currencies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Currencies</SelectItem>
              <SelectItem value="XDC">XDC</SelectItem>
              <SelectItem value="ROXN">ROXN</SelectItem>
              <SelectItem value="USDC">USDC</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bounties Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-3 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredBounties.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Trophy className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No bounties found</h3>
            <p className="text-muted-foreground text-center mb-4">
              {searchQuery || statusFilter !== "all" || currencyFilter !== "all"
                ? "Try adjusting your filters"
                : isClient(user)
                  ? "Be the first to create a community bounty!"
                  : "No bounties available yet. Check back soon!"}
            </p>
            {/* Only Clients can create bounties */}
            {isClient(user) && (
              <Button onClick={() => setShowCreateDialog(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create Bounty
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredBounties.map((bounty) => (
            <Card
              key={bounty.id}
              className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => setSelectedBounty(bounty)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg mb-1">{bounty.title}</CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      <GitBranch className="h-3 w-3" />
                      <span className="text-xs">
                        {bounty.githubRepoOwner}/{bounty.githubRepoName} #{bounty.githubIssueNumber}
                      </span>
                    </CardDescription>
                  </div>
                  <Badge className={STATUS_COLORS[bounty.status]}>
                    {bounty.status.replace('_', ' ')}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {bounty.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {bounty.description}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{CURRENCY_ICONS[bounty.currency]}</span>
                      <div>
                        <div className="text-lg font-bold">{bounty.amount} {bounty.currency}</div>
                        <div className="text-xs text-muted-foreground">Reward</div>
                      </div>
                    </div>
                    {bounty.claimedByGithubUsername && (
                      <div className="text-right">
                        <div className="text-sm font-medium">@{bounty.claimedByGithubUsername}</div>
                        <div className="text-xs text-muted-foreground">Claimer</div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>By @{bounty.createdByGithubUsername}</span>
                    <span>{format(new Date(bounty.createdAt), 'MMM d, yyyy')}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Bounty Detail Dialog */}
      {selectedBounty && (
        <Dialog open={!!selectedBounty} onOpenChange={() => setSelectedBounty(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <div className="flex items-start justify-between">
                <div>
                  <DialogTitle className="text-2xl mb-2">{selectedBounty.title}</DialogTitle>
                  <DialogDescription className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4" />
                    <a
                      href={selectedBounty.githubIssueUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline flex items-center gap-1"
                    >
                      {selectedBounty.githubRepoOwner}/{selectedBounty.githubRepoName} #
                      {selectedBounty.githubIssueNumber}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </DialogDescription>
                </div>
                <Badge className={STATUS_COLORS[selectedBounty.status]}>
                  {selectedBounty.status.replace('_', ' ')}
                </Badge>
              </div>
            </DialogHeader>

            <div className="space-y-4 mt-4">
              {selectedBounty.description && (
                <div>
                  <h4 className="font-semibold mb-2">Description</h4>
                  <p className="text-sm text-muted-foreground">{selectedBounty.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="font-semibold mb-2">Reward</h4>
                  <div className="flex items-center gap-2">
                    <span className="text-3xl">{CURRENCY_ICONS[selectedBounty.currency]}</span>
                    <div>
                      <div className="text-xl font-bold">
                        {selectedBounty.amount} {selectedBounty.currency}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="font-semibold mb-2">Creator</h4>
                  <div className="text-sm">@{selectedBounty.createdByGithubUsername}</div>
                  <div className="text-xs text-muted-foreground">
                    Created {format(new Date(selectedBounty.createdAt), 'PPP')}
                  </div>
                </div>
              </div>

              {selectedBounty.claimedByGithubUsername && (
                <div>
                  <h4 className="font-semibold mb-2">Claimed By</h4>
                  <div className="text-sm">@{selectedBounty.claimedByGithubUsername}</div>
                  {selectedBounty.claimedPrUrl && (
                    <a
                      href={selectedBounty.claimedPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline flex items-center gap-1"
                    >
                      PR #{selectedBounty.claimedPrNumber}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {selectedBounty.status === 'funded' && isDeveloper(user) && (
                <div className="pt-4 border-t">
                  <Button
                    className="w-full"
                    onClick={() => {
                      setClaimingBounty(selectedBounty);
                      setSelectedBounty(null);
                      setShowClaimDialog(true);
                    }}
                  >
                    <Trophy className="mr-2 h-4 w-4" />
                    Claim Bounty
                  </Button>
                </div>
              )}

              {selectedBounty.escrowTxHash && (
                <div className="text-xs text-muted-foreground">
                  <a
                    href={`https://explorer.xdc.org/tx/${selectedBounty.escrowTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline flex items-center gap-1"
                  >
                    View escrow transaction
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Create Bounty Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Community Bounty</DialogTitle>
            <DialogDescription>
              Create a bounty on any public GitHub issue. You'll pay after reviewing the details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label htmlFor="githubIssueUrl">
                GitHub Issue URL <span className="text-red-500">*</span>
              </Label>
              <Input
                id="githubIssueUrl"
                placeholder="https://github.com/owner/repo/issues/123"
                value={formData.githubIssueUrl}
                onChange={(e) =>
                  setFormData({ ...formData, githubIssueUrl: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Paste the full URL of the GitHub issue you want to fund
              </p>
            </div>

            <div>
              <Label htmlFor="title">
                Bounty Title <span className="text-red-500">*</span>
              </Label>
              <Input
                id="title"
                placeholder="Fix bug in authentication flow"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Additional context or requirements..."
                rows={4}
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="amount">
                  Amount <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="1"
                  placeholder="100"
                  value={formData.amount}
                  onChange={(e) =>
                    setFormData({ ...formData, amount: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Minimum: 1 {formData.currency}
                </p>
              </div>

              <div>
                <Label htmlFor="currency">
                  Currency <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={formData.currency}
                  onValueChange={(value: "XDC" | "ROXN" | "USDC") =>
                    setFormData({ ...formData, currency: value })
                  }
                >
                  <SelectTrigger id="currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USDC">💵 USDC</SelectItem>
                    <SelectItem value="XDC">💎 XDC</SelectItem>
                    <SelectItem value="ROXN">🪙 ROXN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="bg-muted/50 p-4 rounded-lg border border-border/50">
              <h4 className="font-semibold mb-2 text-sm">Fee Breakdown (5% total)</h4>
              <div className="space-y-1 text-sm text-muted-foreground">
                <div className="flex justify-between">
                  <span>Base bounty:</span>
                  <span>{formData.amount || "0"} {formData.currency}</span>
                </div>
                <div className="flex justify-between">
                  <span>Client fee (2.5%):</span>
                  <span>
                    +{formData.amount ? (parseFloat(formData.amount) * 0.025).toFixed(2) : "0"}{" "}
                    {formData.currency}
                  </span>
                </div>
                <div className="flex justify-between font-semibold text-foreground pt-2 border-t border-border/50">
                  <span>You pay:</span>
                  <span>
                    {formData.amount ? (parseFloat(formData.amount) * 1.025).toFixed(2) : "0"}{" "}
                    {formData.currency}
                  </span>
                </div>
                <p className="text-xs pt-2">
                  Contributor receives:{" "}
                  {formData.amount ? (parseFloat(formData.amount) * 0.975).toFixed(2) : "0"}{" "}
                  {formData.currency} (after 2.5% contributor fee)
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowCreateDialog(false)}
                disabled={createBountyMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleCreateBounty}
                disabled={createBountyMutation.isPending || payBountyMutation.isPending}
              >
                {createBountyMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : payBountyMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing payment...
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Bounty
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showClaimDialog} onOpenChange={handleClaimDialogOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Claim Community Bounty</DialogTitle>
            <DialogDescription>
              Submit the PR number that closes this issue. Roxonn will verify the merge and trigger auto-payout.
            </DialogDescription>
          </DialogHeader>

          {claimingBounty && (
            <div className="space-y-4 mt-4">
              <div className="rounded-lg border border-border/50 bg-muted/40 p-4 text-sm">
                <div className="font-medium">{claimingBounty.title}</div>
                <div className="text-muted-foreground mt-1">
                  {claimingBounty.githubRepoOwner}/{claimingBounty.githubRepoName} #{claimingBounty.githubIssueNumber}
                </div>
                <div className="mt-2 font-semibold">
                  {claimingBounty.amount} {claimingBounty.currency}
                </div>
              </div>

              <div>
                <Label htmlFor="claim-pr-number">
                  Pull Request Number <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="claim-pr-number"
                  inputMode="numeric"
                  placeholder="123"
                  value={claimPrNumber}
                  onChange={(e) => setClaimPrNumber(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The PR should include <code>fixes #{claimingBounty.githubIssueNumber}</code> in its description.
                </p>
              </div>

              <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground">
                PR URL: https://github.com/{claimingBounty.githubRepoOwner}/{claimingBounty.githubRepoName}/pull/{claimPrNumber || "<pr-number>"}
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowClaimDialog(false)}
                  disabled={claimBountyMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleClaimBounty}
                  disabled={claimBountyMutation.isPending}
                >
                  {claimBountyMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Claiming...
                    </>
                  ) : (
                    <>
                      <Trophy className="mr-2 h-4 w-4" />
                      Submit Claim
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

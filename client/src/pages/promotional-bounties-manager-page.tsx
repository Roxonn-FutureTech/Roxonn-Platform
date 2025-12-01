import { useState } from "react";
import { usePromotionalBounties } from "@/hooks/use-promotional-bounties";
import { CreatePromotionalBountyForm } from "@/components/create-promotional-bounty-form";
import { PromotionalBountyCard } from "@/components/promotional-bounty-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  Search,
  Plus,
  ExternalLink,
  Users,
  Coins,
  TrendingUp,
  X
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export default function PromotionalBountiesManagerPage() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Fetch promotional bounties for the current user's repositories
  const { data: bounties = [], isLoading, error } = usePromotionalBounties(
    undefined, // type (all)
    statusFilter === "ALL" ? undefined : statusFilter,
    undefined, // repoId (all)
    undefined // channel (all)
  );

  // Filter bounties based on search query (only bounties created by current user)
  const userBounties = bounties.filter(bounty => bounty.creatorId === user?.id);
  const filteredBounties = userBounties.filter(bounty => {
    const matchesSearch = bounty.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         bounty.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  // Stats
  const totalBounties = userBounties.length;
  const totalReward = userBounties.reduce((sum, bounty) => sum + parseFloat(bounty.rewardAmount || "0"), 0);
  const activeBounties = userBounties.filter(bounty => bounty.status === "ACTIVE").length;

  const handleBountyCreated = () => {
    setShowCreateForm(false);
  };

  if (!user || user.role !== "poolmanager") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="p-8 text-center">
          <h2 className="text-2xl font-bold mb-4">Access Denied</h2>
          <p className="text-muted-foreground mb-6">
            Only Pool Managers can create and manage promotional bounties.
          </p>
          <Button asChild>
            <a href="/auth">Sign In</a>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header Section */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-4xl sm:text-5xl font-bold">
                  Manage <span className="gradient-text-violet">Promotional Bounties</span>
                </h1>
              </div>
              <p className="text-lg text-muted-foreground">
                Create and manage promotional bounties for your repositories
              </p>
            </div>

            {/* Stats Badges */}
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border/50">
                <TrendingUp className="w-4 h-4 text-violet-500" />
                <span className="font-mono font-semibold">{activeBounties}</span>
                <span className="text-sm text-muted-foreground">Active</span>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border/50">
                <Coins className="w-4 h-4 text-amber-500" />
                <span className="font-mono font-semibold">{totalReward.toFixed(2)}</span>
                <span className="text-sm text-muted-foreground">ROXN Pool</span>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border/50">
                <Users className="w-4 h-4 text-cyan-500" />
                <span className="font-mono font-semibold">{totalBounties}</span>
                <span className="text-sm text-muted-foreground">Total</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Create Bounty Section */}
        {!showCreateForm ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mb-8"
          >
            <Card className="p-8 border-2 border-dashed border-violet-500/30 bg-violet-500/5">
              <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                <div>
                  <h3 className="font-bold text-xl mb-2">Create a New Promotional Bounty</h3>
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    Incentivize the community to promote your project through social media, content creation,
                    and other marketing activities
                  </p>
                </div>
                <Button
                  onClick={() => setShowCreateForm(true)}
                  className="bg-violet-500 hover:bg-violet-600 text-white"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create Bounty
                </Button>
              </div>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mb-8"
          >
            <Card>
              <CardHeader>
                <CardTitle>Create New Promotional Bounty</CardTitle>
              </CardHeader>
              <CardContent>
                <CreatePromotionalBountyForm onCreated={handleBountyCreated} />
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Filters & Search Bar */}
        {!showCreateForm && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mb-8"
          >
            <Card className="p-4">
              <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-4">
                {/* Search */}
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input
                    placeholder="Search your bounties..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 bg-background/50 border-border/50 h-12"
                  />
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-[180px] bg-background/50 border-border/50">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All Statuses</SelectItem>
                        <SelectItem value="ACTIVE">Active</SelectItem>
                        <SelectItem value="DRAFT">Draft</SelectItem>
                        <SelectItem value="PAUSED">Paused</SelectItem>
                        <SelectItem value="COMPLETED">Completed</SelectItem>
                        <SelectItem value="CANCELLED">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </Card>
          </motion.div>
        )}

        {!showCreateForm && (
          <>
            {/* Results Count */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mb-6 flex items-center justify-between"
            >
              <p className="text-sm text-muted-foreground">
                Showing{" "}
                <span className="font-semibold text-foreground">{filteredBounties.length}</span>{" "}
                of <span className="font-semibold text-foreground">{userBounties.length}</span> bounties
                {searchQuery && (
                  <span>
                    {" "}
                    matching "<span className="text-primary">{searchQuery}</span>"
                  </span>
                )}
              </p>
            </motion.div>

            {/* Bounties Grid */}
            {isLoading ? (
              <div className="grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {[...Array(6)].map((_, i) => (
                  <Card key={i} className="animate-pulse">
                    <div className="p-6 space-y-4">
                      <div className="h-6 bg-muted rounded w-3/4"></div>
                      <div className="h-4 bg-muted rounded w-1/2"></div>
                      <div className="h-4 bg-muted rounded w-full"></div>
                      <div className="h-4 bg-muted rounded w-2/3"></div>
                      <div className="h-10 bg-muted rounded mt-4"></div>
                    </div>
                  </Card>
                ))}
              </div>
            ) : error ? (
              <div className="card-noir p-12 text-center">
                <div className="text-destructive mb-4">
                  <X className="w-12 h-12 mx-auto" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Error Loading Bounties</h3>
                <p className="text-muted-foreground">
                  {error instanceof Error ? error.message : "Unknown error occurred"}
                </p>
              </div>
            ) : filteredBounties.length === 0 ? (
              <div className="card-noir p-12 text-center">
                <div className="text-muted-foreground mb-4">
                  <ExternalLink className="w-12 h-12 mx-auto opacity-50" />
                </div>
                <h3 className="text-xl font-semibold mb-2">No Promotional Bounties Found</h3>
                <p className="text-muted-foreground mb-4">
                  {searchQuery
                    ? "No bounties match your search criteria."
                    : statusFilter === "ALL"
                      ? "You haven't created any promotional bounties yet."
                      : `You don't have ${statusFilter.toLowerCase()} promotional bounties.`}
                </p>
                {searchQuery || statusFilter !== "ALL" ? (
                  <Button variant="outline" onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("ALL");
                  }}>
                    Clear Filters
                  </Button>
                ) : (
                  <Button onClick={() => setShowCreateForm(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Your First Bounty
                  </Button>
                )}
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                <div className="grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                  {filteredBounties.map((bounty, index) => (
                    <motion.div
                      key={bounty.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -20 }}
                      transition={{ duration: 0.4, delay: index * 0.05 }}
                    >
                      <PromotionalBountyCard bounty={bounty} />
                    </motion.div>
                  ))}
                </div>
              </AnimatePresence>
            )}
          </>
        )}
      </div>
    </div>
  );
}
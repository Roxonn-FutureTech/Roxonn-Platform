import { useState } from "react";
import { usePromotionalBountiesList } from "@/hooks/use-promotional-bounties";
import { PromotionalBountyCard } from "@/components/promotional-bounty-card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  Search,
  TrendingUp,
  Zap,
  Users,
  Coins,
  ExternalLink,
  X
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function PromotionalBountiesPage() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Fetch promotional bounties with filters
  const { data: bounties = [], isLoading, error } = usePromotionalBountiesList(
    statusFilter === "ALL" ? undefined : statusFilter,
    channelFilter || undefined
  );

  // Filter bounties based on search query
  const filteredBounties = bounties.filter(bounty => {
    const matchesSearch = bounty.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         bounty.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         (bounty.repository?.githubRepoFullName.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);
    return matchesSearch;
  });

  // Stats
  const totalBounties = bounties.length;
  const totalReward = bounties.reduce((sum, bounty) => sum + parseFloat(bounty.rewardAmount || "0"), 0);
  const activeBounties = bounties.filter(bounty => bounty.status === "ACTIVE").length;

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
                  Promotional <span className="gradient-text-violet">Bounties</span>
                </h1>
              </div>
              <p className="text-lg text-muted-foreground">
                Discover marketing and promotional bounties for various projects
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

        {/* Create Bounty CTA for Pool Managers */}
        {user?.role === "poolmanager" && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mb-8"
          >
            <Card className="p-6 border-2 border-dashed border-violet-500/30 bg-violet-500/5">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-violet-500/20">
                    <Zap className="w-6 h-6 text-violet-500" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Create a Promotional Bounty</h3>
                    <p className="text-sm text-muted-foreground">
                      Promote your project and reward contributors for marketing activities
                    </p>
                  </div>
                </div>
                <Button variant="outline" className="border-violet-500 text-violet-500 hover:bg-violet-500/10" asChild>
                  <a href="/my-repos?tab=promotional-bounties">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Create Bounty
                  </a>
                </Button>
              </div>
            </Card>
          </motion.div>
        )}

        {/* Filters & Search Bar */}
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
                  placeholder="Search promotional bounties..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 bg-background/50 border-border/50 h-12"
                />
              </div>

              {/* Filters */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                <div className="flex items-center gap-2">
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[140px] bg-background/50 border-border/50">
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

                <Select value={channelFilter} onValueChange={setChannelFilter}>
                  <SelectTrigger className="w-[160px] bg-background/50 border-border/50">
                    <SelectValue placeholder="All Channels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Channels</SelectItem>
                    <SelectItem value="Twitter/X">Twitter/X</SelectItem>
                    <SelectItem value="LinkedIn">LinkedIn</SelectItem>
                    <SelectItem value="YouTube">YouTube</SelectItem>
                    <SelectItem value="Blog">Blog</SelectItem>
                    <SelectItem value="Discord">Discord</SelectItem>
                    <SelectItem value="Reddit">Reddit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>
        </motion.div>

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
            promotional bounties
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
                : "No promotional bounties are currently available."}
            </p>
            {(searchQuery || statusFilter !== "ACTIVE" || channelFilter) && (
              <Button variant="outline" onClick={() => {
                setSearchQuery("");
                setStatusFilter("ACTIVE");
                setChannelFilter("");
              }}>
                Clear Filters
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
      </div>
    </div>
  );
}
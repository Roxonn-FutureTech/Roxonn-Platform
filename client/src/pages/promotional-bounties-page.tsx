import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { promotionalBountiesAPI, type PromotionalBounty } from "@/lib/promotional-bounties-api";
import { Plus, Search, Filter, Calendar, Coins, Users, ArrowRight } from "lucide-react";
import { format } from "date-fns";

const PROMOTIONAL_CHANNELS = [
  "Twitter",
  "LinkedIn",
  "Facebook",
  "Instagram",
  "YouTube",
  "Blog",
  "Forum",
  "Other",
];

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-500/20 text-green-500",
  DRAFT: "bg-gray-500/20 text-gray-500",
  PAUSED: "bg-yellow-500/20 text-yellow-500",
  COMPLETED: "bg-blue-500/20 text-blue-500",
  CANCELLED: "bg-red-500/20 text-red-500",
};

export default function PromotionalBountiesPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");
  const [channelFilter, setChannelFilter] = useState<string>("");

  const { data: bounties, isLoading } = useQuery({
    queryKey: ["promotional-bounties", statusFilter, channelFilter],
    queryFn: () =>
      promotionalBountiesAPI.getAll({
        status: statusFilter || undefined,
        channel: channelFilter || undefined,
      }),
  });

  const filteredBounties = bounties?.filter((bounty) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      bounty.title.toLowerCase().includes(query) ||
      bounty.description.toLowerCase().includes(query)
    );
  }) || [];

  const isPoolManager = user?.role === "poolmanager";

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Promotional Bounties</h1>
          <p className="text-muted-foreground">
            Discover marketing and promotional opportunities to earn rewards
          </p>
        </div>
        {isPoolManager && (
          <Button onClick={() => setLocation("/promotional-bounties/create")}>
            <Plus className="mr-2 h-4 w-4" />
            Create Bounty
          </Button>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search bounties..."
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
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Status</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
              <SelectItem value="COMPLETED">Completed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Channels</SelectItem>
              {PROMOTIONAL_CHANNELS.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {channel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredBounties.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No bounties found matching your criteria.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBounties.map((bounty) => (
            <BountyCard key={bounty.id} bounty={bounty} />
          ))}
        </div>
      )}
    </div>
  );
}

function BountyCard({ bounty }: { bounty: PromotionalBounty }) {
  const [, setLocation] = useLocation();

  return (
    <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setLocation(`/promotional-bounties/${bounty.id}`)}>
      <CardHeader>
        <div className="flex items-start justify-between mb-2">
          <CardTitle className="text-lg line-clamp-2">{bounty.title}</CardTitle>
          <Badge className={STATUS_COLORS[bounty.status] || STATUS_COLORS.DRAFT}>
            {bounty.status}
          </Badge>
        </div>
        <CardDescription className="line-clamp-2">{bounty.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-yellow-500" />
            <span className="font-semibold">{bounty.rewardAmount} ROXN</span>
            <span className="text-muted-foreground">
              {bounty.rewardType === "PER_SUBMISSION"
                ? "per submission"
                : bounty.rewardType === "POOL"
                ? "total pool"
                : "tiered rewards"}
            </span>
          </div>

          {bounty.maxSubmissions && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>Max {bounty.maxSubmissions} submissions</span>
            </div>
          )}

          {bounty.expiresAt && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>Expires {format(new Date(bounty.expiresAt), "MMM d, yyyy")}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-1 mt-3">
            {bounty.promotionalChannels.slice(0, 3).map((channel) => (
              <Badge key={channel} variant="outline" className="text-xs">
                {channel}
              </Badge>
            ))}
            {bounty.promotionalChannels.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{bounty.promotionalChannels.length - 3}
              </Badge>
            )}
          </div>

          <Button variant="outline" className="w-full mt-4" onClick={(e) => {
            e.stopPropagation();
            setLocation(`/promotional-bounties/${bounty.id}`);
          }}>
            View Details
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}


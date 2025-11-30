import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { promotionalBountiesAPI, type CreateBountyInput } from "@/lib/promotional-bounties-api";
import { ArrowLeft, Loader2, CheckCircle2, XCircle } from "lucide-react";

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

export default function PromotionalBountiesCreatePage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState<CreateBountyInput>({
    repoId: 0,
    type: "PROMOTIONAL",
    title: "",
    description: "",
    promotionalChannels: [],
    requiredDeliverable: "",
    rewardAmount: "",
    rewardType: "PER_SUBMISSION",
    maxSubmissions: undefined,
    totalRewardPool: undefined,
    expiresAt: undefined,
  });

  const { data: repositories, isLoading: reposLoading } = useQuery({
    queryKey: ["promotional-repositories"],
    queryFn: () => promotionalBountiesAPI.getRepositories(),
  });

  const createBountyMutation = useMutation({
    mutationFn: (data: CreateBountyInput) => promotionalBountiesAPI.create(data),
    onSuccess: () => {
      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["promotional-bounties"] });
      setTimeout(() => {
        setLocation("/promotional-bounties");
      }, 2000);
    },
    onError: (err: any) => {
      setError(err.message || "Failed to create bounty");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!formData.repoId) {
      setError("Please select a repository");
      return;
    }

    if (formData.promotionalChannels.length === 0) {
      setError("Please select at least one promotional channel");
      return;
    }

    createBountyMutation.mutate(formData);
  };

  const toggleChannel = (channel: string) => {
    setFormData((prev) => ({
      ...prev,
      promotionalChannels: prev.promotionalChannels.includes(channel)
        ? prev.promotionalChannels.filter((c) => c !== channel)
        : [...prev.promotionalChannels, channel],
    }));
  };

  if (!user || user.role !== "poolmanager") {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert>
          <XCircle className="h-4 w-4" />
          <AlertDescription>Only pool managers can create promotional bounties.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Button variant="ghost" onClick={() => setLocation("/promotional-bounties")} className="mb-6">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Bounties
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Create Promotional Bounty</CardTitle>
          <CardDescription>
            Create a new promotional bounty to incentivize marketing and community engagement
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {success && (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>Bounty created successfully! Redirecting...</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="repoId">Repository *</Label>
              <Select
                value={formData.repoId.toString()}
                onValueChange={(value) => setFormData((prev) => ({ ...prev, repoId: parseInt(value, 10) }))}
                disabled={reposLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories?.map((repo: any) => (
                    <SelectItem key={repo.id} value={repo.id.toString()}>
                      {repo.name || repo.githubRepoName || `Repo #${repo.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Promote our new feature on Twitter"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description *</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Describe what you want contributors to do..."
                rows={4}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Promotional Channels *</Label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {PROMOTIONAL_CHANNELS.map((channel) => (
                  <div key={channel} className="flex items-center space-x-2">
                    <Checkbox
                      id={channel}
                      checked={formData.promotionalChannels.includes(channel)}
                      onCheckedChange={() => toggleChannel(channel)}
                    />
                    <Label htmlFor={channel} className="text-sm font-normal cursor-pointer">
                      {channel}
                    </Label>
                  </div>
                ))}
              </div>
              {formData.promotionalChannels.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {formData.promotionalChannels.map((channel) => (
                    <Badge key={channel} variant="secondary">
                      {channel}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="requiredDeliverable">Required Deliverable *</Label>
              <Input
                id="requiredDeliverable"
                value={formData.requiredDeliverable}
                onChange={(e) => setFormData((prev) => ({ ...prev, requiredDeliverable: e.target.value }))}
                placeholder="e.g., Link to your tweet, URL of your blog post"
                required
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rewardAmount">Reward Amount (ROXN) *</Label>
                <Input
                  id="rewardAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.rewardAmount}
                  onChange={(e) => setFormData((prev) => ({ ...prev, rewardAmount: e.target.value }))}
                  placeholder="0.00"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="rewardType">Reward Type *</Label>
                <Select
                  value={formData.rewardType}
                  onValueChange={(value: any) => setFormData((prev) => ({ ...prev, rewardType: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PER_SUBMISSION">Per Submission</SelectItem>
                    <SelectItem value="POOL">Pool-based</SelectItem>
                    <SelectItem value="TIERED">Tiered</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {formData.rewardType === "POOL" && (
              <div className="space-y-2">
                <Label htmlFor="totalRewardPool">Total Reward Pool (ROXN)</Label>
                <Input
                  id="totalRewardPool"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.totalRewardPool || ""}
                  onChange={(e) => setFormData((prev) => ({ ...prev, totalRewardPool: e.target.value || undefined }))}
                  placeholder="0.00"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="maxSubmissions">Max Submissions (Optional)</Label>
              <Input
                id="maxSubmissions"
                type="number"
                min="1"
                value={formData.maxSubmissions || ""}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    maxSubmissions: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  }))
                }
                placeholder="Leave empty for unlimited"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="expiresAt">Expiration Date (Optional)</Label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={formData.expiresAt || ""}
                onChange={(e) => setFormData((prev) => ({ ...prev, expiresAt: e.target.value || undefined }))}
              />
            </div>

            <div className="flex gap-4">
              <Button
                type="submit"
                disabled={createBountyMutation.isPending}
                className="flex-1"
              >
                {createBountyMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Bounty"
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLocation("/promotional-bounties")}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}


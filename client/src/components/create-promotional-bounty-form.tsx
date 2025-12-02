import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCreatePromotionalBounty, useUserRepositories } from "@/hooks/use-promotional-bounties";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Checkbox,
} from "@/components/ui/checkbox";

interface CreatePromotionalBountyFormProps {
  onCreated?: () => void;
}

export function CreatePromotionalBountyForm({ onCreated }: CreatePromotionalBountyFormProps) {
  const { toast } = useToast();
  const { mutate: createBounty, isPending } = useCreatePromotionalBounty();
  const { data: repositories = [], isLoading: reposLoading } = useUserRepositories();

  const [formData, setFormData] = useState({
    repoId: 0,
    type: "PROMOTIONAL" as const,
    title: "",
    description: "",
    promotionalChannels: [] as string[],
    requiredDeliverable: "",
    rewardAmount: "",
    rewardCurrency: "ROXN" as "XDC" | "ROXN" | "USDC",  // Added reward currency
    rewardType: "PER_SUBMISSION" as const,
    maxSubmissions: undefined as number | undefined,
    totalRewardPool: undefined as string | undefined,
    expiresAt: ""
  });

  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  const promotionalChannels = [
    "Twitter/X",
    "LinkedIn",
    "Facebook",
    "Instagram",
    "YouTube",
    "TikTok",
    "Blog",
    "Newsletter",
    "Podcast",
    "Discord",
    "Reddit",
    "GitHub",
    "Other"
  ];

  const handleChannelToggle = (channel: string) => {
    if (selectedChannels.includes(channel)) {
      setSelectedChannels(selectedChannels.filter(c => c !== channel));
    } else {
      setSelectedChannels([...selectedChannels, channel]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.repoId) {
      toast({
        title: "Error",
        description: "Please select a repository",
        variant: "destructive",
      });
      return;
    }

    if (selectedChannels.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one promotional channel",
        variant: "destructive",
      });
      return;
    }

    if (!formData.requiredDeliverable.trim()) {
      toast({
        title: "Error",
        description: "Please specify the required deliverable",
        variant: "destructive",
      });
      return;
    }

    const bountyData = {
      ...formData,
      promotionalChannels: selectedChannels,
    };

    createBounty(bountyData, {
      onSuccess: () => {
        toast({
          title: "Success",
          description: "Promotional bounty created successfully!",
        });
        if (onCreated) onCreated();
        // Reset form
        setFormData({
          repoId: 0,
          type: "PROMOTIONAL",
          title: "",
          description: "",
          promotionalChannels: [],
          requiredDeliverable: "",
          rewardAmount: "",
          rewardCurrency: "ROXN",
          rewardType: "PER_SUBMISSION",
          maxSubmissions: undefined,
          totalRewardPool: undefined,
          expiresAt: ""
        });
        setSelectedChannels([]);
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message || "Failed to create promotional bounty",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Create Promotional Bounty</CardTitle>
        <CardDescription>
          Create a bounty for marketing and promotional activities for your repository
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Repository Selection */}
          <div className="space-y-2">
            <Label htmlFor="repoId">
              Repository <span className="text-destructive">*</span>
            </Label>
            {reposLoading ? (
              <div className="h-10 bg-muted rounded flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : repositories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You don't have any registered repositories. Please register a repository first.
              </p>
            ) : (
              <Select
                value={formData.repoId.toString()}
                onValueChange={(value) => setFormData({...formData, repoId: Number(value)})}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id.toString()}>
                      {repo.githubRepoFullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) => setFormData({...formData, title: e.target.value})}
              placeholder="e.g., Share our new release on social media"
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({...formData, description: e.target.value})}
              placeholder="Describe the promotional activity in detail..."
              required
              rows={4}
            />
          </div>

          {/* Required Deliverable */}
          <div className="space-y-2">
            <Label htmlFor="requiredDeliverable">
              Required Deliverable <span className="text-destructive">*</span>
            </Label>
            <Input
              id="requiredDeliverable"
              value={formData.requiredDeliverable}
              onChange={(e) => setFormData({...formData, requiredDeliverable: e.target.value})}
              placeholder="e.g., Link to your tweet, URL of your blog post"
              required
            />
          </div>

          {/* Promotional Channels */}
          <div className="space-y-3">
            <Label>
              Promotional Channels <span className="text-destructive">*</span>
            </Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {promotionalChannels.map((channel) => (
                <div
                  key={channel}
                  className="flex items-center space-x-2 p-3 border rounded-lg hover:bg-accent cursor-pointer"
                  onClick={(e) => {
                    // Only toggle if click was not on the checkbox itself
                    if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                    handleChannelToggle(channel);
                  }}
                >
                  <Checkbox
                    id={`channel-${channel}`}
                    checked={selectedChannels.includes(channel)}
                    onCheckedChange={() => handleChannelToggle(channel)}
                  />
                  <Label
                    htmlFor={`channel-${channel}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    {channel}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          {/* Reward Information */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="rewardAmount">
                Reward Amount <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="rewardAmount"
                  type="number"
                  step="0.01"
                  value={formData.rewardAmount}
                  onChange={(e) => setFormData({...formData, rewardAmount: e.target.value})}
                  placeholder="0.00"
                  required
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{formData.rewardCurrency}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rewardCurrency">
                Reward Currency <span className="text-destructive">*</span>
              </Label>
              <Select
                value={formData.rewardCurrency}
                onValueChange={(value) => setFormData({
                  ...formData,
                  rewardCurrency: value as "XDC" | "ROXN" | "USDC"
                })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select currency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="XDC">XDC</SelectItem>
                  <SelectItem value="ROXN">ROXN</SelectItem>
                  <SelectItem value="USDC">USDC</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Max Submissions and Expiration */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="maxSubmissions">
                Max Submissions (Optional)
              </Label>
              <Input
                id="maxSubmissions"
                type="number"
                value={formData.maxSubmissions || ""}
                onChange={(e) => setFormData({...formData, maxSubmissions: e.target.value ? Number(e.target.value) : undefined})}
                placeholder="Leave empty for unlimited"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="expiresAt">
                Expiration Date (Optional)
              </Label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={formData.expiresAt}
                onChange={(e) => setFormData({...formData, expiresAt: e.target.value})}
              />
            </div>
          </div>

          {/* Submit Button */}
          <div className="flex justify-end pt-4">
            <Button type="submit" disabled={isPending} className="w-full md:w-auto">
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Bounty
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useCreatePromotionalSubmission } from "@/hooks/use-promotional-bounties";
import { useToast } from "@/hooks/use-toast";
import {
  ExternalLink,
  Clock,
  Users,
  Coins,
  Calendar,
  Check,
  X,
  Loader2
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface PromotionalBountyCardProps {
  bounty: {
    id: number;
    title: string;
    description: string;
    promotionalChannels: string[];
    requiredDeliverable: string;
    rewardAmount: string;
    rewardCurrency: string;  // Added currency field
    rewardType: string;
    maxSubmissions?: number;
    totalRewardPool?: string;
    expiresAt?: string;
    createdAt: string;
    status: string;
    repository?: {
      githubRepoFullName: string;
    };
  };
}

export function PromotionalBountyCard({ bounty }: PromotionalBountyCardProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { mutate: submitBounty, isPending: isSubmitting } = useCreatePromotionalSubmission();

  const [proofLinks, setProofLinks] = useState<string[]>([""]);
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate proof links with URL validation
    const validLinks = [];
    const errors = [];

    // Create a map of valid channels for quick lookup
    const validChannelMap = bounty.promotionalChannels.reduce((map, channel) => {
      map[channel.toLowerCase()] = true;
      return map;
    }, {} as Record<string, boolean>);

    for (const link of proofLinks) {
      const trimmed = link.trim();

      if (!trimmed) continue;

      try {
        const urlObj = new URL(trimmed);

        // Basic URL validation
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
          errors.push(`Invalid URL protocol: ${trimmed}`);
          continue;
        }

        // Channel-specific URL validation
        let channelMatched = false;
        for (const channel of bounty.promotionalChannels) {
          const channelLower = channel.toLowerCase();

          // Twitter/X validation
          if (channelLower.includes('twitter') || channelLower.includes('x')) {
            const twitterPatterns = [
              /^https?:\/\/(www\.)?twitter\.com\/\w+\/status\/\d+/,
              /^https?:\/\/(www\.)?x\.com\/\w+\/status\/\d+/,
              /^https?:\/\/t\.co\//
            ];

            if (twitterPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // LinkedIn validation
          else if (channelLower.includes('linkedin')) {
            const linkedinPatterns = [
              /^https?:\/\/(www\.)?linkedin\.com\/posts\/\w+/,
              /^https?:\/\/(www\.)?linkedin\.com\/in\/\w+/,
              /^https?:\/\/(www\.)?linkedin\.com\/feed\/update/,
              /^https?:\/\/lnkd\.in\//
            ];

            if (linkedinPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // Facebook validation
          else if (channelLower.includes('facebook')) {
            const facebookPatterns = [
              /^https?:\/\/(www\.)?facebook\.com\/.*/,
              /^https?:\/\/fb\.me\//
            ];

            if (facebookPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // Instagram validation
          else if (channelLower.includes('instagram')) {
            const instagramPatterns = [
              /^https?:\/\/(www\.)?instagram\.com\/p\/.+$/,
              /^https?:\/\/(www\.)?instagram\.com\/reel\/.+$/,
              /^https?:\/\/(www\.)?instagram\.com\/stories\/.+$/,
              /^https?:\/\/instagr\.am\/.+$/,
              /^https?:\/\/(www\.)?fb\.watch\/.+$/  // Facebook Watch links for Instagram content
            ];

            if (instagramPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // YouTube validation
          else if (channelLower.includes('youtube')) {
            const youtubePatterns = [
              /^https?:\/\/(www\.)?youtube\.com\/watch\?v=.+/,
              /^https?:\/\/(www\.)?youtube\.com\/shorts\/.+$/,
              /^https?:\/\/(www\.)?youtu.be\/.+/
            ];

            if (youtubePatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // TikTok validation
          else if (channelLower.includes('tiktok')) {
            const tiktokPatterns = [
              /^https?:\/\/(www\.)?tiktok\.com\/@.*/,
              /^https?:\/\/vm\.tiktok\.com\/.+/
            ];

            if (tiktokPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // Discord validation
          else if (channelLower.includes('discord')) {
            const discordPatterns = [
              /^https?:\/\/(www\.)?discord\.com\/channels\/.+$/,
              /^https?:\/\/discord\.gg\/.+/
            ];

            if (discordPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // Reddit validation
          else if (channelLower.includes('reddit')) {
            const redditPatterns = [
              /^https?:\/\/(www\.)?reddit\.com\/r\/.+\/comments\/.+$/,
              /^https?:\/\/(www\.)?redd.it\/.+/
            ];

            if (redditPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }

          // GitHub validation
          else if (channelLower.includes('github')) {
            const githubPatterns = [
              /^https?:\/\/(www\.)?github\.com\/.+\/.+/
            ];

            if (githubPatterns.some(pattern => pattern.test(trimmed))) {
              channelMatched = true;
              break;
            }
          }
        }

        // If no channel matched, check for other valid channels
        if (!channelMatched) {
          // If we have specific channel requirements, warn the user
          if (bounty.promotionalChannels.length > 0) {
            errors.push(`URL "${trimmed}" doesn't match any of the required promotional channels: ${bounty.promotionalChannels.join(", ")}`);
            continue;
          }
        }

        // Additional checks for spam patterns
        const spamIndicators = [
          /^https?:\/\/localhost/,
          /^https?:\/\/127\.0\.0\.1/,
          /bit\.ly/i,
          /tinyurl\.com/i,
          /adf\.ly/i,
          /is\.gd/i,
          /ow\.ly/i,
          /t\.me/i  // Telegram
        ];

        const isSpam = spamIndicators.some(pattern => pattern.test(trimmed));
        if (isSpam) {
          errors.push(`Spam or invalid URL detected: ${trimmed}`);
          continue;
        }

        validLinks.push(trimmed);
      } catch (error) {
        errors.push(`Invalid URL format: ${trimmed}`);
      }
    }

    if (validLinks.length === 0) {
      toast({
        title: "Error",
        description: errors.length > 0 ? errors[0] : "Please provide at least one valid URL",
        variant: "destructive",
      });
      return;
    }

    const submissionData = {
      bountyId: bounty.id,
      proofLinks: validLinks,
      description
    };

    submitBounty(submissionData, {
      onSuccess: () => {
        toast({
          title: "Success",
          description: "Submission created successfully!",
        });
        setOpen(false);
        // Reset form
        setProofLinks([""]);
        setDescription("");
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message || "Failed to submit",
          variant: "destructive",
        });
      }
    });
  };

  const addProofLink = () => {
    setProofLinks([...proofLinks, ""]);
  };

  const updateProofLink = (index: number, value: string) => {
    const newLinks = [...proofLinks];
    newLinks[index] = value;
    setProofLinks(newLinks);
  };

  const removeProofLink = (index: number) => {
    if (proofLinks.length > 1) {
      const newLinks = [...proofLinks];
      newLinks.splice(index, 1);
      setProofLinks(newLinks);
    }
  };

  const isExpired = bounty.expiresAt ? new Date(bounty.expiresAt) < new Date() : false;
  const isClosed = bounty.status !== 'ACTIVE' || isExpired;

  // Determine the display status and badge styling
  let statusText = bounty.status;
  let badgeVariant = "default";
  let badgeClasses = "bg-emerald-500/10 text-emerald-500 border-emerald-500/30";

  if (isExpired) {
    statusText = 'EXPIRED';
    badgeVariant = "destructive";
    badgeClasses = "bg-destructive/10 text-destructive border-destructive/30";
  } else if (bounty.status !== 'ACTIVE') {
    badgeVariant = "secondary";
    badgeClasses = "bg-muted/50 text-muted-foreground";
  }

  return (
    <Card className="group overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-xl font-bold truncate max-w-[70%]">{bounty.title}</h3>
          <Badge
            variant={badgeVariant}
            className={badgeClasses}
          >
            {statusText}
          </Badge>
        </div>

        {bounty.repository && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <div className="h-4 w-4" />
            <span>{bounty.repository.githubRepoFullName}</span>
          </div>
        )}

        <p className="text-muted-foreground line-clamp-2">{bounty.description}</p>
      </CardHeader>

      <CardContent className="pb-3">
        <div className="space-y-3">
          {/* Promotional Channels */}
          <div>
            <h4 className="text-sm font-medium mb-1">Promotional Channels</h4>
            <div className="flex flex-wrap gap-2">
              {bounty.promotionalChannels.map((channel, index) => (
                <Badge key={index} variant="secondary" className="bg-purple-500/10 text-purple-500 border-purple-500/30">
                  {channel}
                </Badge>
              ))}
            </div>
          </div>

          {/* Required Deliverable */}
          <div>
            <h4 className="text-sm font-medium mb-1">Required Deliverable</h4>
            <p className="text-sm">{bounty.requiredDeliverable}</p>
          </div>

          {/* Reward Info */}
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-sm font-medium">{bounty.rewardAmount} {bounty.rewardCurrency || 'ROXN'}</p>
                <p className="text-xs text-muted-foreground">{bounty.rewardType}</p>
              </div>
            </div>

            {bounty.maxSubmissions && (
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-cyan-500" />
                <div>
                  <p className="text-sm font-medium">{bounty.maxSubmissions} slots</p>
                  <p className="text-xs text-muted-foreground">max submissions</p>
                </div>
              </div>
            )}
          </div>

          {/* Time Info */}
          <div className="flex items-center gap-4 text-sm text-muted-foreground pt-2">
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              <span>Posted {formatDistanceToNow(new Date(bounty.createdAt), { addSuffix: true })}</span>
            </div>

            {bounty.expiresAt && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                <span>Expires {formatDistanceToNow(new Date(bounty.expiresAt))}</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex flex-col gap-3">
        {!user ? (
          <Button variant="outline" className="w-full" asChild>
            <a href="/auth">Sign In to Participate</a>
          </Button>
        ) : isClosed ? (
          <Button variant="outline" className="w-full" disabled>
            {isExpired ? 'Expired' : bounty.status}
          </Button>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="w-full">
                <ExternalLink className="h-4 w-4 mr-2" />
                Submit Work
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Submit for: {bounty.title}</DialogTitle>
                <DialogDescription>
                  Provide proof of your promotional work
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="proof-link-0">
                    Proof Links <span className="text-destructive">*</span>
                  </Label>
                  <div className="space-y-2 mt-2">
                    {proofLinks.map((link, index) => (
                      <div key={index} className="flex gap-2">
                        <Input
                          id={`proof-link-${index}`}
                          value={link}
                          onChange={(e) => updateProofLink(index, e.target.value)}
                          placeholder="https://twitter.com/your_tweet"
                        />
                        {proofLinks.length > 1 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => removeProofLink(index)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addProofLink}
                    className="mt-2"
                  >
                    Add More Link
                  </Button>
                </div>

                <div>
                  <Label htmlFor="description">
                    Description
                  </Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe your promotional work..."
                    rows={3}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        Submit
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardFooter>
    </Card>
  );
}
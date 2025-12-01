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
    const validLinks = proofLinks.filter(link => {
      const trimmed = link.trim();
      if (!trimmed) return false;
      try {
        new URL(trimmed);
        return trimmed.startsWith('http://') || trimmed.startsWith('https://');
      } catch {
        return false;
      }
    });

    if (validLinks.length === 0) {
      toast({
        title: "Error",
        description: "Please provide at least one valid URL",
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

  return (
    <Card className="group overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-xl font-bold truncate max-w-[70%]">{bounty.title}</h3>
          <Badge
            variant={bounty.status === 'ACTIVE' && !isExpired ? "default" : "secondary"}
            className={bounty.status === 'ACTIVE' && !isExpired ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" : "bg-muted/50 text-muted-foreground"}
          >
            {isExpired ? 'EXPIRED' : bounty.status}
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
                <p className="text-sm font-medium">{bounty.rewardAmount} ROXN</p>
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
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { promotionalBountiesAPI, type PromotionalBounty, type CreateSubmissionInput } from "@/lib/promotional-bounties-api";
import { ArrowLeft, Coins, Calendar, Users, CheckCircle2, XCircle, Plus, X, ExternalLink } from "lucide-react";
import { format } from "date-fns";

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-500/20 text-green-500",
  DRAFT: "bg-gray-500/20 text-gray-500",
  PAUSED: "bg-yellow-500/20 text-yellow-500",
  COMPLETED: "bg-blue-500/20 text-blue-500",
  CANCELLED: "bg-red-500/20 text-red-500",
};

export default function PromotionalBountiesDetailPage() {
  const { user } = useAuth();
  const [, params] = useRoute("/promotional-bounties/:id");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState(false);

  const bountyId = params?.id ? parseInt(params.id, 10) : 0;

  const { data: bounty, isLoading } = useQuery({
    queryKey: ["promotional-bounty", bountyId],
    queryFn: () => promotionalBountiesAPI.getById(bountyId),
    enabled: !!bountyId,
  });

  const { data: submissions } = useQuery({
    queryKey: ["promotional-submissions", bountyId],
    queryFn: () => promotionalBountiesAPI.getSubmissions(bountyId),
    enabled: !!bountyId,
  });

  const [submissionForm, setSubmissionForm] = useState<CreateSubmissionInput>({
    bountyId,
    proofLinks: [""],
    description: "",
  });

  const createSubmissionMutation = useMutation({
    mutationFn: (data: CreateSubmissionInput) => promotionalBountiesAPI.createSubmission(data),
    onSuccess: () => {
      setSuccess(true);
      setSubmissionOpen(false);
      queryClient.invalidateQueries({ queryKey: ["promotional-submissions", bountyId] });
      setTimeout(() => setSuccess(false), 5000);
    },
    onError: (err: any) => {
      setError(err.message || "Failed to create submission");
    },
  });

  const handleAddLink = () => {
    setSubmissionForm((prev) => ({
      ...prev,
      proofLinks: [...prev.proofLinks, ""],
    }));
  };

  const handleRemoveLink = (index: number) => {
    setSubmissionForm((prev) => ({
      ...prev,
      proofLinks: prev.proofLinks.filter((_, i) => i !== index),
    }));
  };

  const handleLinkChange = (index: number, value: string) => {
    setSubmissionForm((prev) => {
      const newLinks = [...prev.proofLinks];
      newLinks[index] = value;
      return { ...prev, proofLinks: newLinks };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    const validLinks = submissionForm.proofLinks.filter((link) => link.trim());
    if (validLinks.length === 0) {
      setError("Please provide at least one proof link");
      return;
    }

    createSubmissionMutation.mutate({
      ...submissionForm,
      proofLinks: validLinks,
    });
  };

  const isPoolManager = user?.role === "poolmanager";
  const canSubmit = bounty?.status === "ACTIVE" && !isPoolManager;

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Skeleton className="h-10 w-64 mb-6" />
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2 mt-2" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!bounty) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert>
          <XCircle className="h-4 w-4" />
          <AlertDescription>Bounty not found</AlertDescription>
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

      {success && (
        <Alert className="mb-6">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>Submission created successfully!</AlertDescription>
        </Alert>
      )}

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="text-2xl mb-2">{bounty.title}</CardTitle>
              <div className="flex items-center gap-2 mb-2">
                <Badge className={STATUS_COLORS[bounty.status] || STATUS_COLORS.DRAFT}>
                  {bounty.status}
                </Badge>
                <Badge variant="outline">
                  <Coins className="mr-1 h-3 w-3" />
                  {bounty.rewardAmount} ROXN
                </Badge>
              </div>
            </div>
            {canSubmit && (
              <Dialog open={submissionOpen} onOpenChange={setSubmissionOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Submit Proof
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Submit Proof of Work</DialogTitle>
                    <DialogDescription>
                      Provide links to your promotional work (tweets, posts, articles, etc.)
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {error && (
                      <Alert variant="destructive">
                        <XCircle className="h-4 w-4" />
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}
                    <div className="space-y-2">
                      <Label>Proof Links *</Label>
                      {submissionForm.proofLinks.map((link, index) => (
                        <div key={index} className="flex gap-2">
                          <Input
                            type="url"
                            value={link}
                            onChange={(e) => handleLinkChange(index, e.target.value)}
                            placeholder="https://twitter.com/..."
                            required={index === 0}
                          />
                          {submissionForm.proofLinks.length > 1 && (
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => handleRemoveLink(index)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                      <Button type="button" variant="outline" onClick={handleAddLink} className="w-full">
                        <Plus className="mr-2 h-4 w-4" />
                        Add Another Link
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="description">Description (Optional)</Label>
                      <Textarea
                        id="description"
                        value={submissionForm.description}
                        onChange={(e) => setSubmissionForm((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder="Add any additional context..."
                        rows={3}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" disabled={createSubmissionMutation.isPending} className="flex-1">
                        {createSubmissionMutation.isPending ? "Submitting..." : "Submit"}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setSubmissionOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h3 className="font-semibold mb-2">Description</h3>
            <p className="text-muted-foreground whitespace-pre-wrap">{bounty.description}</p>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Required Deliverable</h3>
            <p className="text-muted-foreground">{bounty.requiredDeliverable}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground mb-1">Reward Type</p>
              <p className="font-semibold">{bounty.rewardType.replace("_", " ")}</p>
            </div>
            {bounty.maxSubmissions && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Max Submissions</p>
                <p className="font-semibold">{bounty.maxSubmissions}</p>
              </div>
            )}
            {bounty.expiresAt && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Expires</p>
                <p className="font-semibold">{format(new Date(bounty.expiresAt), "MMM d, yyyy")}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground mb-1">Submissions</p>
              <p className="font-semibold">{submissions?.length || 0}</p>
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Promotional Channels</h3>
            <div className="flex flex-wrap gap-2">
              {bounty.promotionalChannels.map((channel) => (
                <Badge key={channel} variant="outline">
                  {channel}
                </Badge>
              ))}
            </div>
          </div>

          {isPoolManager && submissions && submissions.length > 0 && (
            <div>
              <h3 className="font-semibold mb-4">Submissions</h3>
              <div className="space-y-3">
                {submissions.map((submission) => (
                  <Card key={submission.id}>
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between mb-3">
                        <Badge
                          className={
                            submission.status === "APPROVED"
                              ? "bg-green-500/20 text-green-500"
                              : submission.status === "REJECTED"
                              ? "bg-red-500/20 text-red-500"
                              : "bg-yellow-500/20 text-yellow-500"
                          }
                        >
                          {submission.status}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {format(new Date(submission.createdAt), "MMM d, yyyy")}
                        </span>
                      </div>
                      {submission.description && <p className="mb-3 text-sm">{submission.description}</p>}
                      <div className="space-y-1">
                        {submission.proofLinks.map((link, index) => (
                          <a
                            key={index}
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-sm text-primary hover:underline"
                          >
                            {link}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


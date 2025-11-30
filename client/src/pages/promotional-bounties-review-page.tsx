import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { promotionalBountiesAPI, type PromotionalSubmission, type ReviewSubmissionInput } from "@/lib/promotional-bounties-api";
import { ArrowLeft, CheckCircle2, XCircle, ExternalLink, Calendar, Eye } from "lucide-react";
import { format } from "date-fns";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-500/20 text-yellow-500",
  APPROVED: "bg-green-500/20 text-green-500",
  REJECTED: "bg-red-500/20 text-red-500",
};

export default function PromotionalBountiesReviewPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [reviewOpen, setReviewOpen] = useState<number | null>(null);
  const [reviewStatus, setReviewStatus] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [reviewNotes, setReviewNotes] = useState("");

  const { data: myBounties, isLoading: bountiesLoading } = useQuery({
    queryKey: ["promotional-bounties", "my"],
    queryFn: () => promotionalBountiesAPI.getAll({}),
    enabled: user?.role === "poolmanager",
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: ReviewSubmissionInput }) =>
      promotionalBountiesAPI.reviewSubmission(id, data),
    onSuccess: () => {
      setReviewOpen(null);
      setReviewNotes("");
      queryClient.invalidateQueries({ queryKey: ["promotional-submissions"] });
      queryClient.invalidateQueries({ queryKey: ["promotional-bounties"] });
    },
  });

  const handleReview = (submissionId: number) => {
    reviewMutation.mutate({
      id: submissionId,
      data: {
        status: reviewStatus,
        reviewNotes: reviewNotes || undefined,
      },
    });
  };

  if (!user || user.role !== "poolmanager") {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert>
          <XCircle className="h-4 w-4" />
          <AlertDescription>Only pool managers can review submissions.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const allSubmissions: PromotionalSubmission[] = [];
  myBounties?.forEach((bounty) => {
    // We'll need to fetch submissions for each bounty
    // For now, we'll show a message to fetch them
  });

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <Button variant="ghost" onClick={() => setLocation("/promotional-bounties")} className="mb-6">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Bounties
      </Button>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Review Submissions</h1>
        <p className="text-muted-foreground">
          Review and approve or reject submissions for your promotional bounties
        </p>
      </div>

      {bountiesLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-32 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : myBounties && myBounties.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">You don't have any bounties yet.</p>
            <Button onClick={() => setLocation("/promotional-bounties/create")} className="mt-4">
              Create Your First Bounty
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {myBounties?.map((bounty) => (
            <BountySubmissionsCard
              key={bounty.id}
              bounty={bounty}
              onReview={handleReview}
              reviewOpen={reviewOpen}
              setReviewOpen={setReviewOpen}
              reviewStatus={reviewStatus}
              setReviewStatus={setReviewStatus}
              reviewNotes={reviewNotes}
              setReviewNotes={setReviewNotes}
              isReviewing={reviewMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BountySubmissionsCard({
  bounty,
  onReview,
  reviewOpen,
  setReviewOpen,
  reviewStatus,
  setReviewStatus,
  reviewNotes,
  setReviewNotes,
  isReviewing,
}: {
  bounty: any;
  onReview: (id: number) => void;
  reviewOpen: number | null;
  setReviewOpen: (id: number | null) => void;
  reviewStatus: "APPROVED" | "REJECTED";
  setReviewStatus: (status: "APPROVED" | "REJECTED") => void;
  reviewNotes: string;
  setReviewNotes: (notes: string) => void;
  isReviewing: boolean;
}) {
  const { data: submissions, isLoading } = useQuery({
    queryKey: ["promotional-submissions", bounty.id],
    queryFn: () => promotionalBountiesAPI.getSubmissions(bounty.id),
  });

  const pendingSubmissions = submissions?.filter((s) => s.status === "PENDING") || [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-3/4" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{bounty.title}</CardTitle>
        <CardDescription>
          {pendingSubmissions.length} pending submission{pendingSubmissions.length !== 1 ? "s" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {pendingSubmissions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No pending submissions</p>
        ) : (
          <div className="space-y-4">
            {pendingSubmissions.map((submission) => (
              <Card key={submission.id} className="bg-muted/50">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <Badge className={STATUS_COLORS[submission.status]}>
                        {submission.status}
                      </Badge>
                      <p className="text-sm text-muted-foreground mt-2">
                        Submitted {format(new Date(submission.createdAt), "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    </div>
                    <Dialog
                      open={reviewOpen === submission.id}
                      onOpenChange={(open) => setReviewOpen(open ? submission.id : null)}
                    >
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Eye className="mr-2 h-4 w-4" />
                          Review
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Review Submission</DialogTitle>
                          <DialogDescription>
                            Review the proof links and provide feedback
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          {submission.description && (
                            <div>
                              <Label>Description</Label>
                              <p className="text-sm text-muted-foreground mt-1">{submission.description}</p>
                            </div>
                          )}
                          <div>
                            <Label>Proof Links</Label>
                            <div className="space-y-2 mt-2">
                              {submission.proofLinks.map((link: string, index: number) => (
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
                          </div>
                          <div>
                            <Label>Review Status *</Label>
                            <Select value={reviewStatus} onValueChange={(value: any) => setReviewStatus(value)}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="APPROVED">Approve</SelectItem>
                                <SelectItem value="REJECTED">Reject</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label htmlFor="reviewNotes">Review Notes (Optional)</Label>
                            <Textarea
                              id="reviewNotes"
                              value={reviewNotes}
                              onChange={(e) => setReviewNotes(e.target.value)}
                              placeholder="Add feedback or notes..."
                              rows={3}
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => onReview(submission.id)}
                              disabled={isReviewing}
                              className="flex-1"
                            >
                              {isReviewing ? "Submitting..." : "Submit Review"}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setReviewOpen(null)}
                              disabled={isReviewing}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                  {submission.description && (
                    <p className="text-sm mb-3">{submission.description}</p>
                  )}
                  <div className="space-y-1">
                    {submission.proofLinks.map((link: string, index: number) => (
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
        )}
      </CardContent>
    </Card>
  );
}


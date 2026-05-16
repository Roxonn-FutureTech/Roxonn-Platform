import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { promotionalBountiesAPI, type CreateBountyInput, type SubmitProofInput, type ReviewSubmissionInput } from "@/lib/promotional-bounties-api";
import { useToast } from "@/hooks/use-toast";

export function usePromotionalBounties(filters?: { status?: string; channel?: string }) {
  return useQuery({
    queryKey: ["promotional-bounties", filters],
    queryFn: () => promotionalBountiesAPI.getAll(filters),
  });
}

export function usePromotionalBounty(id: number) {
  return useQuery({
    queryKey: ["promotional-bounty", id],
    queryFn: () => promotionalBountiesAPI.getById(id),
    enabled: !!id,
  });
}

export function usePromotionalBountySubmissions(id: number) {
  return useQuery({
    queryKey: ["promotional-submissions", id],
    queryFn: () => promotionalBountiesAPI.getSubmissions(id),
    enabled: !!id,
  });
}

export function useCreateBounty() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (data: CreateBountyInput) => promotionalBountiesAPI.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["promotional-bounties"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error creating bounty",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useSubmitProof() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: SubmitProofInput }) => 
      promotionalBountiesAPI.submitProof(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["promotional-submissions", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["promotional-bounty", variables.id] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error submitting proof",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

export function useReviewSubmission() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ submissionId, data }: { submissionId: number; data: ReviewSubmissionInput }) => 
      promotionalBountiesAPI.reviewSubmission(submissionId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["promotional-submissions"] });
      queryClient.invalidateQueries({ queryKey: ["promotional-bounty"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error reviewing submission",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

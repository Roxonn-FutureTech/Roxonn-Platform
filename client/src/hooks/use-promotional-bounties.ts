import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { STAGING_API_URL } from "@/config";
import { useAuth } from "./use-auth";

export interface PromotionalBounty {
  id: number;
  repoId: number;
  creatorId: number;
  type: "CODE" | "PROMOTIONAL";
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  title: string;
  description: string;
  promotionalChannels: string[];
  requiredDeliverable: string;
  rewardType: "PER_SUBMISSION" | "POOL" | "TIERED";
  maxSubmissions?: number;
  totalRewardPool?: string;
  campaignId?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  rewardAmount: string;
  repository?: {
    id: number;
    githubRepoFullName: string;
    githubRepoId: string;
    isActive: boolean;
  };
  submissions?: PromotionalSubmission[];
}

export interface PromotionalSubmission {
  id: number;
  bountyId: number;
  contributorId: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  proofLinks: string[];
  description: string;
  reviewedAt?: string;
  reviewedBy?: number;
  reviewNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreatePromotionalBountyInput = Pick<
  PromotionalBounty,
  | 'repoId'
  | 'type'
  | 'title'
  | 'description'
  | 'promotionalChannels'
  | 'requiredDeliverable'
  | 'rewardAmount'
  | 'rewardType'
  | 'maxSubmissions'
  | 'totalRewardPool'
  | 'expiresAt'
>;

export type CreatePromotionalSubmissionInput = Pick<
  PromotionalSubmission,
  'bountyId' | 'proofLinks' | 'description'
>;

// API functions
const api = {
  getBounties: async (type?: string, status?: string, repoId?: number, channel?: string) => {
    const params = new URLSearchParams();
    if (type) params.append('type', type);
    if (status) params.append('status', status);
    if (repoId) params.append('repoId', repoId.toString());
    if (channel) params.append('channel', channel);

    const response = await fetch(`${STAGING_API_URL}/api/promotional/bounties${params.toString() ? '?' + params.toString() : ''}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      let errorMessage = 'Failed to fetch bounties';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  getPromotionalBounties: async (status?: string, channel?: string, repoId?: number) => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (channel) params.append('channel', channel);
    if (repoId) params.append('repoId', repoId.toString());

    const response = await fetch(`${STAGING_API_URL}/api/promotional/bounties/promotional${params.toString() ? '?' + params.toString() : ''}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      let errorMessage = 'Failed to fetch promotional bounties';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  getBountyById: async (id: number) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/bounties/${id}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      let errorMessage = 'Failed to fetch bounty';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  createBounty: async (bountyData: CreatePromotionalBountyInput) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/bounties`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bountyData)
    });

    if (!response.ok) {
      let errorMessage = 'Failed to create bounty';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  updateBountyStatus: async (id: number, status: string) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/bounties/${id}/status`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status })
    });

    if (!response.ok) {
      let errorMessage = 'Failed to update bounty status';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  getSubmissions: async (bountyId?: number, status?: string, contributorId?: number) => {
    const params = new URLSearchParams();
    if (bountyId) params.append('bountyId', bountyId.toString());
    if (status) params.append('status', status);
    if (contributorId) params.append('contributorId', contributorId.toString());

    const response = await fetch(`${STAGING_API_URL}/api/promotional/submissions${params.toString() ? '?' + params.toString() : ''}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      let errorMessage = 'Failed to fetch submissions';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  createSubmission: async (submissionData: CreatePromotionalSubmissionInput) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/submissions`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(submissionData)
    });

    if (!response.ok) {
      let errorMessage = 'Failed to create submission';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  reviewSubmission: async (id: number, status: string, reviewNotes?: string) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/submissions/${id}/review`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status, reviewNotes })
    });

    if (!response.ok) {
      let errorMessage = 'Failed to review submission';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  },

  getSubmissionById: async (id: number) => {
    const response = await fetch(`${STAGING_API_URL}/api/promotional/submissions/${id}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      let errorMessage = 'Failed to fetch submission';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }
};

// Constants
const QUERY_STALE_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

// React Query hooks
export function usePromotionalBounties(type?: string, status?: string, repoId?: number, channel?: string) {
  return useQuery({
    queryKey: ['promotional-bounties', type, status, repoId, channel],
    queryFn: () => api.getBounties(type, status, repoId, channel),
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}

export function usePromotionalBountiesList(status?: string, channel?: string, repoId?: number) {
  return useQuery({
    queryKey: ['promotional-bounties-list', status, channel, repoId],
    queryFn: () => api.getPromotionalBounties(status, channel, repoId),
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}

export function usePromotionalBounty(id: number) {
  return useQuery({
    queryKey: ['promotional-bounty', id],
    queryFn: () => api.getBountyById(id),
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}

export function useCreatePromotionalBounty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createBounty,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promotional-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['promotional-bounties-list'] });
    },
  });
}

export function useUpdateBountyStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.updateBountyStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promotional-bounties'] });
      queryClient.invalidateQueries({ queryKey: ['promotional-bounty'] });
    },
  });
}

export function usePromotionalSubmissions(bountyId?: number, status?: string, contributorId?: number) {
  return useQuery({
    queryKey: ['promotional-submissions', bountyId, status, contributorId],
    queryFn: () => api.getSubmissions(bountyId, status, contributorId),
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}

export function useCreatePromotionalSubmission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createSubmission,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promotional-submissions'] });
    },
  });
}

export function useReviewSubmission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status, reviewNotes }: { id: number; status: string; reviewNotes?: string }) =>
      api.reviewSubmission(id, status, reviewNotes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['promotional-submissions'] });
      queryClient.invalidateQueries({ queryKey: ['promotional-bounty'] });
    },
  });
}

export function usePromotionalSubmission(id: number) {
  return useQuery({
    queryKey: ['promotional-submission', id],
    queryFn: () => api.getSubmissionById(id),
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}

export function useUserRepositories() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['user-repositories'],
    queryFn: async () => {
      if (!user) return [];

      const response = await fetch(`${STAGING_API_URL}/api/promotional/repositories`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        let errorMessage = 'Failed to fetch repositories';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // Use default error message if JSON parsing fails
        }
        throw new Error(errorMessage);
      }

      return response.json();
    },
    enabled: !!user,
    staleTime: QUERY_STALE_TIME, // 5 minutes
  });
}
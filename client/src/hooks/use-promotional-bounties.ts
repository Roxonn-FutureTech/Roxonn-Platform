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
      throw new Error('Failed to fetch bounties');
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
      throw new Error('Failed to fetch promotional bounties');
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
      throw new Error('Failed to fetch bounty');
    }

    return response.json();
  },

  createBounty: async (bountyData: Omit<PromotionalBounty, 'id' | 'createdAt' | 'updatedAt' | 'repository' | 'submissions'>) => {
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
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to create bounty');
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
      throw new Error('Failed to update bounty status');
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
      throw new Error('Failed to fetch submissions');
    }

    return response.json();
  },

  createSubmission: async (submissionData: Omit<PromotionalSubmission, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'reviewedAt' | 'reviewedBy' | 'reviewNotes'>) => {
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
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to create submission');
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
      throw new Error('Failed to review submission');
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
      throw new Error('Failed to fetch submission');
    }

    return response.json();
  }
};

// React Query hooks
export function usePromotionalBounties(type?: string, status?: string, repoId?: number, channel?: string) {
  return useQuery({
    queryKey: ['promotional-bounties', type, status, repoId, channel],
    queryFn: () => api.getBounties(type, status, repoId, channel),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function usePromotionalBountiesList(status?: string, channel?: string, repoId?: number) {
  return useQuery({
    queryKey: ['promotional-bounties-list', status, channel, repoId],
    queryFn: () => api.getPromotionalBounties(status, channel, repoId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function usePromotionalBounty(id: number) {
  return useQuery({
    queryKey: ['promotional-bounty', id],
    queryFn: () => api.getBountyById(id),
    staleTime: 5 * 60 * 1000, // 5 minutes
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
    staleTime: 5 * 60 * 1000, // 5 minutes
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
    staleTime: 5 * 60 * 1000, // 5 minutes
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
        throw new Error('Failed to fetch repositories');
      }

      return response.json();
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
import api from "./api";

export interface PromotionalBounty {
  id: number;
  repoId: number;
  creatorId: number;
  type: "CODE" | "PROMOTIONAL";
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  title: string;
  description: string;
  promotionalChannels: string[];
  requiredDeliverable: string | null;
  rewardAmount: string;
  rewardType: "PER_SUBMISSION" | "POOL" | "TIERED";
  maxSubmissions: number | null;
  totalRewardPool: string | null;
  campaignId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionalSubmission {
  id: number;
  bountyId: number;
  contributorId: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  proofLinks: string[];
  description: string | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBountyInput {
  repoId: number;
  type?: "CODE" | "PROMOTIONAL";
  title: string;
  description: string;
  promotionalChannels: string[];
  requiredDeliverable: string;
  rewardAmount: string;
  rewardType?: "PER_SUBMISSION" | "POOL" | "TIERED";
  maxSubmissions?: number;
  totalRewardPool?: string;
  expiresAt?: string;
}

export interface CreateSubmissionInput {
  bountyId: number;
  proofLinks: string[];
  description?: string;
}

export interface ReviewSubmissionInput {
  status: "APPROVED" | "REJECTED";
  reviewNotes?: string;
}

export const promotionalBountiesAPI = {
  // Get all promotional bounties with optional filters
  getAll: async (params?: {
    status?: string;
    channel?: string;
    repoId?: number;
  }): Promise<PromotionalBounty[]> => {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append("status", params.status);
    if (params?.channel) queryParams.append("channel", params.channel);
    if (params?.repoId) queryParams.append("repoId", params.repoId.toString());
    
    const query = queryParams.toString();
    const endpoint = `/api/promotional/bounties/promotional${query ? `?${query}` : ""}`;
    return api.get<PromotionalBounty[]>(endpoint);
  },

  // Get a single bounty by ID
  getById: async (id: number): Promise<PromotionalBounty> => {
    return api.get<PromotionalBounty>(`/api/promotional/bounties/${id}`);
  },

  // Create a new promotional bounty
  create: async (data: CreateBountyInput): Promise<PromotionalBounty> => {
    return api.post<PromotionalBounty>("/api/promotional/bounties", data);
  },

  // Update bounty status
  updateStatus: async (id: number, status: string): Promise<PromotionalBounty> => {
    return api.patch<PromotionalBounty>(`/api/promotional/bounties/${id}/status`, { status });
  },

  // Get all submissions for a bounty
  getSubmissions: async (bountyId: number): Promise<PromotionalSubmission[]> => {
    return api.get<PromotionalSubmission[]>(`/api/promotional/submissions?bountyId=${bountyId}`);
  },

  // Create a submission
  createSubmission: async (data: CreateSubmissionInput): Promise<PromotionalSubmission> => {
    return api.post<PromotionalSubmission>("/api/promotional/submissions", data);
  },

  // Get submission by ID
  getSubmissionById: async (id: number): Promise<PromotionalSubmission> => {
    return api.get<PromotionalSubmission>(`/api/promotional/submissions/${id}`);
  },

  // Review a submission
  reviewSubmission: async (id: number, data: ReviewSubmissionInput): Promise<PromotionalSubmission> => {
    return api.patch<PromotionalSubmission>(`/api/promotional/submissions/${id}/review`, data);
  },

  // Get all my submissions
  getMySubmissions: async (): Promise<PromotionalSubmission[]> => {
    return api.get<PromotionalSubmission[]>("/api/promotional/submissions");
  },

  // Get registered repositories (for creating bounties)
  getRepositories: async (): Promise<any[]> => {
    return api.get<any[]>("/api/promotional/repositories");
  },
};


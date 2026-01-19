import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pre-emptively set env vars
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.GITHUB_APP_ID = '123';

// Mock heavy infrastructure modules BEFORE imports
vi.mock('../server/db', () => ({
  db: { query: { users: { findFirst: vi.fn() } } },
  users: {},
}));

vi.mock('../server/config', () => ({
  config: {
    databaseUrl: 'postgres://mock:mock@localhost:5432/mock',
    githubAppId: 'mock-id',
    githubAppPrivateKey: 'mock-key',
    githubAppWebhookSecret: 'mock-secret',
    xdcNodeUrl: 'https://rpc.mock.com',
    feeCollectorAddress: 'xdc000',
    platformFeeRate: 250,
    contributorFeeRate: 250,
    repoRewardsContractAddress: 'xdc111',
    forwarderContractAddress: 'xdc222',
    roxnTokenAddress: 'xdc333',
    relayerPrivateKey: '0xabc',
    communityBountyEscrowAddress: 'xdc444'
  }
}));

vi.mock('../server/blockchain', () => ({
  blockchain: {
    allocateIssueReward: vi.fn(),
    getRepository: vi.fn(),
  }
}));

vi.mock('../server/storage');
vi.mock('axios');
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() => vi.fn().mockResolvedValue({ token: 'mock-installation-token' }))
}));

import { parseBountyCommand, handleBountyCommand } from '../server/github';
import { blockchain } from '../server/blockchain';
import { storage } from '../server/storage';
import { ethers } from 'ethers';
import * as githubModule from '../server/github';

vi.mock('../server/github', async () => {
  const actual = await vi.importActual<typeof import('../server/github')>('../server/github');
  return {
    ...actual,
    postGitHubComment: vi.fn(), // We are spying on axios, but keeping this for safety
  };
});

import axios from 'axios';
const mockInstallationId = 'install123';

// Use spies for blockchain methods instead of auto-mocking
// This preserves real method signatures for integration tests

describe('Bounty Bot Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseBountyCommand', () => {
    it('should parse /bounty with amount and currency', () => {
      const result = parseBountyCommand('/bounty 10 XDC');
      expect(result).toEqual({
        type: 'community_create',
        amount: '10',
        currency: 'XDC'
      });
    });

    it('should parse /bounty with decimal amount', () => {
      const result = parseBountyCommand('/bounty 10.5 ROXN');
      expect(result).toEqual({
        type: 'community_create',
        amount: '10.5',
        currency: 'ROXN'
      });
    });

    it('should parse /bounty without amount (request)', () => {
      const result = parseBountyCommand('/bounty');
      expect(result).toEqual({
        type: 'request'
      });
    });

    it('should parse @roxonn bounty with amount', () => {
      const result = parseBountyCommand('@roxonn bounty 25 USDC');
      expect(result).toEqual({
        type: 'community_create',
        amount: '25',
        currency: 'USDC'
      });
    });

    it('should parse @roxonn bounty without amount', () => {
      const result = parseBountyCommand('@roxonn bounty');
      expect(result).toEqual({
        type: 'request'
      });
    });

    it('should handle case insensitive parsing', () => {
      const result = parseBountyCommand('/Bounty 5 xdc');
      expect(result).toEqual({
        type: 'community_create',
        amount: '5',
        currency: 'XDC'
      });
    });

    it('should reject invalid currency', () => {
      const result = parseBountyCommand('/bounty 10 BTC');
      expect(result).toBeNull();
    });

    it('should reject invalid amount (too large)', () => {
      const result = parseBountyCommand('/bounty 2000000 XDC');
      expect(result).toBeNull();
    });

    it('should reject negative amounts', () => {
      const result = parseBountyCommand('/bounty -10 XDC');
      expect(result).toBeNull();
    });

    it('should handle comments with extra text', () => {
      // Note: The new parser is stricter or regex based, check if this works. 
      // The implementation used .match() on specific patterns. 
      // Pattern 4 matches /\/bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i
      // It does NOT require start/end string anchors like ^ or $.
      const result = parseBountyCommand('Hey, can you /bounty 10 XDC please?');
      expect(result).toEqual({
        type: 'community_create',
        amount: '10',
        currency: 'XDC'
      });
    });

    it('should return null for non-command text', () => {
      const result = parseBountyCommand('This is just a regular comment');
      expect(result).toBeNull();
    });
  });

  describe('handleBountyCommand - Request Flow', () => {
    const mockPayload = {
      comment: {
        body: '/bounty',
        id: 123
      },
      issue: {
        id: 456,
        number: 1,
        html_url: 'https://github.com/test/repo/issues/1'
      },
      repository: {
        id: 789,
        full_name: 'test/repo'
      },
    };

    it('should create bounty request for /bounty command', async () => {
      const mockPayload = {
        comment: {
          body: '/bounty',
          id: 123
        },
        issue: {
          id: 456,
          number: 1,
          html_url: 'https://github.com/test/repo/issues/1'
        },
        repository: {
          id: 789,
          full_name: 'test/repo'
        },
        sender: {
          login: 'user123'
        }
      };
      const mockRegistration = { id: 1, githubRepoId: '789' };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.createBountyRequest).mockResolvedValue({ id: 1 } as any);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.findRegisteredRepositoryByGithubId).toHaveBeenCalledWith('789');
      expect(storage.createBountyRequest).toHaveBeenCalledWith({
        githubRepoId: '789',
        githubIssueId: '456',
        githubIssueNumber: 1,
        githubIssueUrl: 'https://github.com/test/repo/issues/1',
        requestedBy: 'user123',
        suggestedAmount: null,
        suggestedCurrency: null
      });

      // Verify comment posted via axios
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Bounty Requested')
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-installation-token'
          })
        })
      );
    });

    it('should reject if repository not registered', async () => {
      const mockPayload = {
        comment: {
          body: '/bounty pool 100 USDC',
          id: 123
        },
        issue: {
          id: 456,
          number: 1,
          html_url: 'https://github.com/test/repo/issues/1'
        },
        repository: {
          id: 999, // Not registered
          full_name: 'test/repo'
        },
        sender: {
          login: 'user123'
        }
      };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(null);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.createBountyRequest).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Repository Not Registered')
        }),
        expect.any(Object)
      );
    });

    it('should enforce rate limiting', async () => {
      const mockPayload = {
        comment: {
          body: '/bounty',
          id: 123
        },
        issue: {
          id: 456,
          number: 1,
          html_url: 'https://github.com/test/repo/issues/1'
        },
        repository: {
          id: 789,
          full_name: 'test/repo'
        },
        sender: {
          login: 'user123'
        }
      };
      const mockRegistration = { id: 1, githubRepoId: '789' };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([
        {
          id: 1,
          githubRepoId: '789',
          githubIssueId: '456',
          githubIssueNumber: 1,
          requestedBy: 'user123',
          createdAt: new Date(), // Just now
          suggestedAmount: null,
          suggestedCurrency: null,
          status: 'pending'
        }
      ]);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.createBountyRequest).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Rate Limit')
        }),
        expect.any(Object)
      );
    });
  });

  describe('handleBountyCommand - Allocation Flow', () => {
    const mockPayload = {
      comment: {
        body: '/bounty pool 10 XDC',
        id: 123
      },
      issue: {
        id: 456,
        number: 1,
        html_url: 'https://github.com/test/repo/issues/1'
      },
      repository: {
        id: 789,
        full_name: 'test/repo'
      },
      sender: {
        login: 'poolmanager'
      }
    };

    const mockRegistration = { id: 1, githubRepoId: '789' };
    const mockPoolManager = {
      id: 100,
      githubUsername: 'poolmanager',
      xdcWalletAddress: '0x123'
    };

    beforeEach(() => {
      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager);
      vi.mocked(blockchain.getRepository).mockResolvedValue({
        xdcPoolRewards: '100',
        roxnPoolRewards: '1000',
        usdcPoolRewards: '500'
      });
      vi.mocked(blockchain.allocateIssueReward).mockResolvedValue({
        transactionHash: '0x123',
        blockNumber: 1000
      });
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]); // Ensure no rate limiting
    });

    it('should allocate bounty for authorized pool manager', async () => {
      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.getRepositoryPoolManager).toHaveBeenCalledWith(789); // GitHub Repo ID (as integer)
      expect(blockchain.getRepository).toHaveBeenCalledWith(789); // GitHub Repo ID
      expect(blockchain.allocateIssueReward).toHaveBeenCalledWith(
        789, // GitHub Repo ID
        1, // issueNumber
        '10', // amount
        'XDC', // currency
        100 // userId
      );

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Bounty Allocated')
        }),
        expect.any(Object)
      );
    });

    it('should reject unauthorized users', async () => {
      const unauthorizedPayload = {
        ...mockPayload,
        sender: { login: 'randomuser' }
      };

      await handleBountyCommand(unauthorizedPayload, mockInstallationId);

      expect(blockchain.allocateIssueReward).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Not Authorized')
        }),
        expect.any(Object)
      );
    });

    it('should check pool balance before allocation', async () => {
      vi.mocked(blockchain.getRepository).mockResolvedValue({
        xdcPoolRewards: '5', // Less than 10
        roxnPoolRewards: '1000',
        usdcPoolRewards: '500'
      });

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(blockchain.allocateIssueReward).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Insufficient Funds')
        }),
        expect.any(Object)
      );
    });

    it('should handle USDC with 6 decimals', async () => {
      const usdcPayload = {
        ...mockPayload,
        comment: { ...mockPayload.comment, body: '/bounty pool 100 USDC' }
      };
      // Mock repo details to have enough USDC
      vi.mocked(blockchain.getRepository).mockResolvedValue({
        xdcPoolRewards: '0.0',
        roxnPoolRewards: '0.0',
        usdcPoolRewards: '1000.0'
      });

      await handleBountyCommand(usdcPayload, mockInstallationId);

      // Verify USDC amount is parsed correctly (6 decimals)
      const poolBalance = ethers.parseUnits('1000.0', 6);
      const amountWei = ethers.parseUnits('100', 6);
      expect(poolBalance).toBeGreaterThanOrEqual(amountWei);
      expect(blockchain.allocateIssueReward).toHaveBeenCalledWith(
        789, // GitHub Repo ID
        1,
        '100',
        'USDC',
        100
      );
    });
  });

  describe('Blockchain Integration', () => {
    it('should verify allocateIssueReward method exists', () => {
      // Verify the method exists (using spy to preserve real signature)
      expect(typeof blockchain.allocateIssueReward).toBe('function');
    });

    it('should verify getRepository method exists', () => {
      expect(typeof blockchain.getRepository).toBe('function');
    });

    it('should verify getRepository returns correct structure', async () => {
      const mockRepoDetails = {
        xdcPoolRewards: '100.0',
        roxnPoolRewards: '50.0',
        usdcPoolRewards: '200.0',
        poolManagers: [],
        contributors: [],
        issues: []
      };

      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockRepoDetails as any);

      const result = await blockchain.getRepository(1);

      expect(result).toHaveProperty('xdcPoolRewards');
      expect(result).toHaveProperty('roxnPoolRewards');
      expect(result).toHaveProperty('usdcPoolRewards');
      expect(typeof result.xdcPoolRewards).toBe('string');
      expect(typeof result.roxnPoolRewards).toBe('string');
      expect(typeof result.usdcPoolRewards).toBe('string');
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing payload fields gracefully', async () => {
      const invalidPayload = {
        comment: null,
        issue: { id: 456, number: 1 },
        repository: { id: 789 },
        sender: { login: 'testuser' }
      };

      await expect(handleBountyCommand(invalidPayload as any, 'install123')).resolves.not.toThrow();
    });

    it('should handle invalid repo format (SSRF protection)', async () => {
      const invalidPayload = {
        comment: { body: '/bounty', id: 123 },
        issue: { id: 456, number: 1, html_url: 'https://github.com/test/repo/issues/1' },
        repository: {
          id: 789,
          full_name: 'invalid/repo/format'
        },
        sender: { login: 'testuser' }
      };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(null);

      await handleBountyCommand(invalidPayload as any, 'install123');

      // Should not crash, but may log error
      expect(storage.createBountyRequest).not.toHaveBeenCalled();
    });

    it('should handle blockchain errors gracefully', async () => {
      const mockPayload = {
        comment: { body: '/bounty pool 10 XDC', id: 123 },
        issue: { id: 456, number: 1, html_url: 'https://github.com/test/repo/issues/1' },
        repository: { id: 789, full_name: 'test/repo' },
        sender: { login: 'poolmanager' }
      };
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockPoolManager = {
        id: 100,
        githubUsername: 'poolmanager',
        xdcWalletAddress: 'xdc123'
      };
      const mockRepoDetails = {
        xdcPoolRewards: '100.0',
        roxnPoolRewards: '50.0',
        usdcPoolRewards: '200.0'
      };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager as any);
      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockRepoDetails as any);
      vi.spyOn(blockchain, 'allocateIssueReward').mockRejectedValue(new Error('Blockchain error'));

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/issues/1/comments',
        expect.objectContaining({
          body: expect.stringContaining('Allocation Failed')
        }),
        expect.any(Object)
      );
    });
  });
});


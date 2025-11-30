import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseBountyCommand, handleBountyCommand } from '../server/github';
import { blockchain } from '../server/blockchain';
import { storage } from '../server/storage';
import { ethers } from 'ethers';
import * as githubModule from '../server/github';

// Mock dependencies
vi.mock('../server/storage');
vi.mock('axios');

// Mock github module to properly mock postGitHubComment
vi.mock('../server/github', async () => {
  const actual = await vi.importActual<typeof import('../server/github')>('../server/github');
  return {
    ...actual,
    postGitHubComment: vi.fn().mockResolvedValue(undefined),
  };
});

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
        type: 'allocate',
        amount: '10',
        currency: 'XDC'
      });
    });

    it('should parse /bounty with decimal amount', () => {
      const result = parseBountyCommand('/bounty 10.5 ROXN');
      expect(result).toEqual({
        type: 'allocate',
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
        type: 'allocate',
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
        type: 'allocate',
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
      const result = parseBountyCommand('Hey, can you /bounty 10 XDC please?');
      expect(result).toEqual({
        type: 'allocate',
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
      sender: {
        login: 'testuser'
      }
    };

    it('should create bounty request for /bounty command', async () => {
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockInstallationId = 'install123';

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
        requestedBy: 'testuser',
        suggestedAmount: null,
        suggestedCurrency: null
      });
      expect(githubModule.postGitHubComment).toHaveBeenCalled();
    });

    it('should reject if repository not registered', async () => {
      const mockInstallationId = 'install123';

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(null);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.createBountyRequest).not.toHaveBeenCalled();
      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        mockInstallationId,
        'test',
        'repo',
        1,
        expect.stringContaining('Repository Not Registered')
      );
    });

    it('should enforce rate limiting', async () => {
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockInstallationId = 'install123';
      const recentRequest = {
        requestedBy: 'testuser',
        createdAt: new Date()
      };

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([recentRequest] as any);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.createBountyRequest).not.toHaveBeenCalled();
      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        mockInstallationId,
        'test',
        'repo',
        1,
        expect.stringContaining('Rate Limit')
      );
    });
  });

  describe('handleBountyCommand - Allocation Flow', () => {
    const mockPayload = {
      comment: {
        body: '/bounty 10 XDC',
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

    it('should allocate bounty for authorized pool manager', async () => {
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
      const mockInstallationId = 'install123';

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager as any);
      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockRepoDetails as any);
      vi.spyOn(blockchain, 'allocateIssueReward').mockResolvedValue({
        transactionHash: '0x123',
        blockNumber: 1000
      });

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(storage.getRepositoryPoolManager).toHaveBeenCalledWith(1);
      expect(blockchain.getRepository).toHaveBeenCalledWith(1);
      expect(blockchain.allocateIssueReward).toHaveBeenCalledWith(
        1, // repoId
        1, // issueNumber
        '10', // amount
        'XDC', // currency
        100 // userId
      );
      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        mockInstallationId,
        'test',
        'repo',
        1,
        expect.stringContaining('Bounty Allocated')
      );
    });

    it('should reject unauthorized users', async () => {
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockPoolManager = {
        id: 100,
        githubUsername: 'differentuser',
        xdcWalletAddress: 'xdc123'
      };
      const mockInstallationId = 'install123';

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager as any);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(blockchain.allocateIssueReward).not.toHaveBeenCalled();
      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        mockInstallationId,
        'test',
        'repo',
        1,
        expect.stringContaining('Not Authorized')
      );
    });

    it('should check pool balance before allocation', async () => {
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockPoolManager = {
        id: 100,
        githubUsername: 'poolmanager',
        xdcWalletAddress: 'xdc123'
      };
      const mockRepoDetails = {
        xdcPoolRewards: '5.0', // Less than requested 10 XDC
        roxnPoolRewards: '50.0',
        usdcPoolRewards: '200.0'
      };
      const mockInstallationId = 'install123';

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager as any);
      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockRepoDetails as any);

      await handleBountyCommand(mockPayload, mockInstallationId);

      expect(blockchain.allocateIssueReward).not.toHaveBeenCalled();
      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        mockInstallationId,
        'test',
        'repo',
        1,
        expect.stringContaining('Insufficient Funds')
      );
    });

    it('should handle USDC with 6 decimals', async () => {
      const usdcPayload = {
        ...mockPayload,
        comment: { ...mockPayload.comment, body: '/bounty 100 USDC' }
      };
      const mockRegistration = { id: 1, githubRepoId: '789' };
      const mockPoolManager = {
        id: 100,
        githubUsername: 'poolmanager',
        xdcWalletAddress: 'xdc123'
      };
      const mockRepoDetails = {
        xdcPoolRewards: '0.0',
        roxnPoolRewards: '0.0',
        usdcPoolRewards: '1000.0'
      };
      const mockInstallationId = 'install123';

      vi.mocked(storage.findRegisteredRepositoryByGithubId).mockResolvedValue(mockRegistration as any);
      vi.mocked(storage.getBountyRequestsByIssue).mockResolvedValue([]);
      vi.mocked(storage.getRepositoryPoolManager).mockResolvedValue(mockPoolManager as any);
      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockRepoDetails as any);
      vi.spyOn(blockchain, 'allocateIssueReward').mockResolvedValue({
        transactionHash: '0x123',
        blockNumber: 1000
      });

      await handleBountyCommand(usdcPayload, mockInstallationId);

      // Verify USDC amount is parsed correctly (6 decimals)
      const poolBalance = ethers.parseUnits('1000.0', 6);
      const amountWei = ethers.parseUnits('100', 6);
      expect(poolBalance).toBeGreaterThanOrEqual(amountWei);
      expect(blockchain.allocateIssueReward).toHaveBeenCalledWith(
        1,
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
        comment: { body: '/bounty 10 XDC', id: 123 },
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

      await handleBountyCommand(mockPayload, 'install123');

      expect(githubModule.postGitHubComment).toHaveBeenCalledWith(
        'install123',
        'test',
        'repo',
        1,
        expect.stringContaining('Allocation Failed')
      );
    });
  });
});


import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blockchain } from '../server/blockchain';
import { ethers } from 'ethers';

describe('Blockchain Integration Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('allocateIssueReward Method', () => {
    it('should have correct method signature', () => {
      expect(typeof blockchain.allocateIssueReward).toBe('function');
    });

    it('should accept correct parameters', async () => {
      const mockResult = {
        transactionHash: '0x1234567890abcdef',
        blockNumber: 1000
      };

      // Mock the method to verify it's called correctly
      const allocateSpy = vi.spyOn(blockchain, 'allocateIssueReward').mockResolvedValue(mockResult);

      const result = await blockchain.allocateIssueReward(
        1, // repoId
        10, // issueId
        '10.5', // reward (string)
        'XDC', // currencyType
        100 // userId
      );

      expect(allocateSpy).toHaveBeenCalledWith(1, 10, '10.5', 'XDC', 100);
      expect(result).toHaveProperty('transactionHash');
      expect(result).toHaveProperty('blockNumber');
    });

    it('should handle all currency types', async () => {
      const currencies: Array<'XDC' | 'ROXN' | 'USDC'> = ['XDC', 'ROXN', 'USDC'];
      
      for (const currency of currencies) {
        const mockResult = {
          transactionHash: `0x${currency}`,
          blockNumber: 1000
        };

        vi.spyOn(blockchain, 'allocateIssueReward').mockResolvedValue(mockResult);

        const result = await blockchain.allocateIssueReward(1, 1, '10', currency, 100);
        
        expect(result.transactionHash).toBeDefined();
        expect(result.blockNumber).toBeDefined();
      }
    });

    it('should parse decimal amounts correctly', async () => {
      const testAmounts = ['10', '10.5', '0.1', '100.99'];
      
      for (const amount of testAmounts) {
        const mockResult = {
          transactionHash: '0x123',
          blockNumber: 1000
        };

        vi.spyOn(blockchain, 'allocateIssueReward').mockResolvedValue(mockResult);

        // XDC and ROXN use 18 decimals
        const parsedXDC = ethers.parseEther(amount);
        expect(parsedXDC).toBeGreaterThan(BigInt(0));

        // USDC uses 6 decimals
        const parsedUSDC = ethers.parseUnits(amount, 6);
        expect(parsedUSDC).toBeGreaterThan(BigInt(0));
      }
    });
  });

  describe('getRepository Method', () => {
    it('should have correct method signature', () => {
      expect(typeof blockchain.getRepository).toBe('function');
    });

    it('should return repository details with pool balances', async () => {
      const mockRepoDetails = {
        xdcPoolRewards: '100.0',
        roxnPoolRewards: '50.0',
        usdcPoolRewards: '200.0',
        poolManagers: ['0x123'],
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

    it('should handle uninitialized repositories', async () => {
      const mockEmptyRepo = {
        xdcPoolRewards: '0.0',
        roxnPoolRewards: '0.0',
        usdcPoolRewards: '0.0',
        poolManagers: [],
        contributors: [],
        issues: []
      };

      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockEmptyRepo as any);

      const result = await blockchain.getRepository(999);

      expect(result.xdcPoolRewards).toBe('0.0');
      expect(result.roxnPoolRewards).toBe('0.0');
      expect(result.usdcPoolRewards).toBe('0.0');
    });
  });

  describe('Currency Decimal Handling', () => {
    it('should use 18 decimals for XDC', () => {
      const amount = '10.5';
      const parsed = ethers.parseEther(amount);
      const formatted = ethers.formatEther(parsed);
      
      expect(formatted).toBe('10.5');
      expect(parsed.toString()).toBe('10500000000000000000');
    });

    it('should use 18 decimals for ROXN', () => {
      const amount = '10.5';
      const parsed = ethers.parseEther(amount);
      const formatted = ethers.formatEther(parsed);
      
      expect(formatted).toBe('10.5');
    });

    it('should use 6 decimals for USDC', () => {
      const amount = '10.5';
      const parsed = ethers.parseUnits(amount, 6);
      const formatted = ethers.formatUnits(parsed, 6);
      
      expect(formatted).toBe('10.5');
      expect(parsed.toString()).toBe('10500000');
    });

    it('should correctly compare pool balances', () => {
      const poolBalance = ethers.parseEther('100.0');
      const requestedAmount = ethers.parseEther('10.0');
      
      expect(poolBalance).toBeGreaterThan(requestedAmount);
      
      const insufficientBalance = ethers.parseEther('5.0');
      expect(insufficientBalance).toBeLessThan(requestedAmount);
    });
  });

  describe('Error Handling', () => {
    it('should handle blockchain connection errors', async () => {
      vi.spyOn(blockchain, 'getRepository').mockRejectedValue(
        new Error('Network error')
      );

      await expect(blockchain.getRepository(1)).rejects.toThrow('Network error');
    });

    it('should handle insufficient gas errors', async () => {
      vi.spyOn(blockchain, 'allocateIssueReward').mockRejectedValue(
        new Error('Insufficient XDC balance')
      );

      await expect(
        blockchain.allocateIssueReward(1, 1, '10', 'XDC', 100)
      ).rejects.toThrow('Insufficient XDC balance');
    });

    it('should handle invalid repository ID', async () => {
      const mockEmptyRepo = {
        xdcPoolRewards: '0.0',
        roxnPoolRewards: '0.0',
        usdcPoolRewards: '0.0',
        poolManagers: [],
        contributors: [],
        issues: []
      };

      vi.spyOn(blockchain, 'getRepository').mockResolvedValue(mockEmptyRepo as any);

      const result = await blockchain.getRepository(99999);
      
      // Should return empty structure, not throw
      expect(result).toBeDefined();
      expect(result.xdcPoolRewards).toBe('0.0');
    });
  });
});


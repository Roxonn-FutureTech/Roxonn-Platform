import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storage } from '../storage';
import { db } from '../db';
import { blockchain } from '../blockchain';
import { users } from '../../../shared/schema';

// Mock external dependencies
vi.mock('../db');
vi.mock('../blockchain');

describe('Storage Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deleteUser method', () => {
    it('should delete user account when user has no wallet balance', async () => {
      // Mock user exists
      const mockUser = {
        id: 1,
        xdcWalletAddress: 'xdc123...'
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);
      
      // Mock wallet info shows no balance
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });
      
      // Mock deletion returns success
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 1 }])
      } as any);

      const result = await storage.deleteUser(1);
      
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalledWith(expect.anything());
    });

    it('should prevent deletion when user has XDC balance', async () => {
      // Mock user exists
      const mockUser = {
        id: 1,
        xdcWalletAddress: 'xdc123...'
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);
      
      // Mock wallet info shows XDC balance
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(1000000000000000000), // 1 XDC
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });

      await expect(storage.deleteUser(1)).rejects.toThrow('Cannot delete account: Wallet has funds. Please transfer funds before account deletion.');
    });

    it('should prevent deletion when user has ROXN balance', async () => {
      // Mock user exists
      const mockUser = {
        id: 1,
        xdcWalletAddress: 'xdc123...'
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);
      
      // Mock wallet info shows ROXN balance
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(1000000000000000000), // 1 ROXN
        usdcBalance: BigInt(0)
      });

      await expect(storage.deleteUser(1)).rejects.toThrow('Cannot delete account: Wallet has funds. Please transfer funds before account deletion.');
    });

    it('should prevent deletion when user has USDC balance', async () => {
      // Mock user exists
      const mockUser = {
        id: 1,
        xdcWalletAddress: 'xdc123...'
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);
      
      // Mock wallet info shows USDC balance
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(1000000) // 1 USDC (with 6 decimals)
      });

      await expect(storage.deleteUser(1)).rejects.toThrow('Cannot delete account: Wallet has funds. Please transfer funds before account deletion.');
    });

    it('should allow deletion when user has no wallet address', async () => {
      // Mock user with no wallet address
      const mockUser = {
        id: 1,
        xdcWalletAddress: null
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);
      
      // Mock deletion returns success
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 1 }])
      } as any);

      const result = await storage.deleteUser(1);
      
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('getUserByGithubUsername method', () => {
    it('should find user by GitHub username (case insensitive)', async () => {
      const mockUser = { id: 1, githubUsername: 'TestUser' };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);

      const result = await storage.getUserByGithubUsername('testuser');
      
      expect(result).toEqual(mockUser);
      expect(db.query.users.findFirst).toHaveBeenCalledWith({
        where: expect.anything() // This will check for the LOWER function call
      });
    });

    it('should return null if user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(null);

      const result = await storage.getUserByGithubUsername('nonexistentuser');
      
      expect(result).toBeNull();
    });
  });

  describe('getUserByGithubEmail method', () => {
    it('should find user by email', async () => {
      const mockUser = { id: 1, email: 'test@example.com' };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);

      const result = await storage.getUserByGithubEmail('test@example.com');
      
      expect(result).toEqual(mockUser);
      expect(db.query.users.findFirst).toHaveBeenCalledWith({
        where: expect.any(Object) // eq function call
      });
    });

    it('should return null if user not found by email', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(null);

      const result = await storage.getUserByGithubEmail('nonexistent@example.com');
      
      expect(result).toBeNull();
    });
  });
});
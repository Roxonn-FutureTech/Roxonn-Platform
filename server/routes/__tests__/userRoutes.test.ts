import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import { eq } from 'drizzle-orm';
import { users } from '../../../shared/schema';
import { storage } from '../../storage';
import { blockchain } from '../../blockchain';
import { db } from '../../db';
import { config } from '../../config';

// Mock external dependencies
vi.mock('../../storage');
vi.mock('../../blockchain');
vi.mock('../../db');
vi.mock('../../config');

// Use requireAuth middleware mock
const mockRequireAuth = (req: Request, res: Response, next: NextFunction) => {
  req.user = { id: 1, username: 'testuser', githubUsername: 'testuser' };
  next();
};

const mockCsrfProtection = (req: Request, res: Response, next: NextFunction) => {
  next();
};

// Import the router after mocking
let userRoutes: express.Router;

// Setup the app with mocked middleware
const app = express();

beforeEach(async () => {
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  }));
  
  // Reset mocks
  vi.clearAllMocks();
  
  // Import userRoutes after clearing mocks
  const userRoutesModule = await import('../userRoutes');
  userRoutes = userRoutesModule.default;
  
  // Apply mock middleware
  userRoutes.stack.forEach((middleware) => {
    const layer = middleware;
    if (layer.route?.path === '/delete-account') {
      layer.handle = vi.fn().mockImplementation(mockRequireAuth).mockImplementation(mockCsrfProtection);
    } else if (layer.route?.path === '/email-preferences') {
      layer.handle = vi.fn().mockImplementation(mockRequireAuth).mockImplementation(mockCsrfProtection);
    }
  });
  
  app.use('/api/user', userRoutes);
});

describe('User Routes Tests', () => {
  describe('DELETE /api/user/delete-account', () => {
    it('should delete user account when user has no wallet balance', async () => {
      // Mock user without wallet balance
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        xdcWalletAddress: 'xdc123...',
        // ...other user fields
      });
      
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });
      
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
      
      const response = await request(app)
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'testuser' })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Account deleted successfully');
    });

    it('should not delete user account when user has wallet balance', async () => {
      // Mock user with wallet balance
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        xdcWalletAddress: 'xdc123...',
        // ...other user fields
      });
      
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(1000000000000000000), // 1 XDC
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });
      
      const response = await request(app)
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'testuser' })
        .expect(400);
      
      expect(response.body.error).toContain('Cannot delete account: Wallet has funds');
    });

    it('should require username confirmation', async () => {
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        username: 'testuser',
        xdcWalletAddress: 'xdc123...',
      });
      
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });
      
      const response = await request(app)
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'wronguser' })
        .expect(400);
      
      expect(response.body.error).toBe('Username confirmation does not match');
    });
  });

  describe('PATCH /api/user/email-preferences', () => {
    it('should update email preferences successfully', async () => {
      const mockUpdateResult = [{ emailOptOut: true }];
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockUpdateResult)
      } as any);

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: true })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.emailOptOut).toBe(true);
    });

    it('should validate optOut parameter', async () => {
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: 'invalid' })
        .expect(400);
      
      expect(response.body.error).toBe('optOut must be a boolean value');
    });

    it('should require optOut parameter', async () => {
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({})
        .expect(400);
      
      expect(response.body.error).toBe('optOut field is required');
    });
  });

  describe('GET /api/user/email-preferences', () => {
    it('should get email preferences successfully', async () => {
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        emailOptOut: false,
        // ...other fields
      } as any);

      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(200);
      
      expect(response.body.optOut).toBe(false);
    });

    it('should return false when user has no emailOptOut preference', async () => {
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        // No emailOptOut set
      } as any);

      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(200);
      
      expect(response.body.optOut).toBe(false);
    });
  });
});
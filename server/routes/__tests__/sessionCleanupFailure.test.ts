import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { storage } from '../../storage';
import { blockchain } from '../../blockchain';

// Mock external dependencies
vi.mock('../../storage');
vi.mock('../../blockchain');

// Mock user data
const mockUser = {
  id: 1,
  username: 'testuser',
  githubUsername: 'testuser',
  xdcWalletAddress: 'xdc123456789'
};

describe('Account Deletion Session Cleanup Failure Handling', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should succeed even if session destruction fails', async () => {
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }));

    // Import and use the routes module
    const userRoutesModule = await import('../userRoutes');
    const userRoutes = userRoutesModule.default;
    app.use('/api/user', userRoutes);
    
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    // Mock user session
    app.use((req, res, next) => {
      (req as any).user = { id: 1, username: 'testuser' };
      // Temporarily mock session.destroy to fail
      const originalDestroy = req.session.destroy.bind(req.session);
      req.session.destroy = (callback) => {
        callback(new Error('Session destruction failed'));
      };
      next();
    });

    const response = await request(app)
      .post('/api/user/delete-account')
      .send({ confirmUsername: 'testuser' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Account deleted successfully');
  });

  it('should succeed even if logout fails', async () => {
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }));

    // Import and use the routes module
    const userRoutesModule = await import('../userRoutes');
    const userRoutes = userRoutesModule.default;
    app.use('/api/user', userRoutes);
    
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    // Mock user session with logout failure
    app.use((req, res, next) => {
      (req as any).user = { id: 1, username: 'testuser' };
      // Temporarily mock req.logout to fail
      const originalLogout = req.logout.bind(req);
      req.logout = (callback) => {
        callback(new Error('Logout failed'));
      };
      next();
    });

    const response = await request(app)
      .post('/api/user/delete-account')
      .send({ confirmUsername: 'testuser' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Account deleted successfully');
  });

  it('should handle both logout and session destruction failures gracefully', async () => {
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }));

    // Import and use the routes module
    const userRoutesModule = await import('../userRoutes');
    const userRoutes = userRoutesModule.default;
    app.use('/api/user', userRoutes);
    
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    app.use((req, res, next) => {
      (req as any).user = { id: 1, username: 'testuser' };
      // Mock both logout and session destroy to fail
      const originalLogout = req.logout.bind(req);
      req.logout = (callback) => {
        callback(new Error('Logout failed'));
      };
      
      const originalDestroy = req.session.destroy.bind(req.session);
      req.session.destroy = (callback) => {
        callback(new Error('Session destruction failed'));
      };
      next();
    });

    const response = await request(app)
      .post('/api/user/delete-account')
      .send({ confirmUsername: 'testuser' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Account deleted successfully');
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { storage } from '../../storage';
import { blockchain } from '../../blockchain';
import { db } from '../../db';

// Mock external dependencies
vi.mock('../../storage');
vi.mock('../../blockchain');
vi.mock('../../db');

// Mock user data
const mockUser = {
  id: 1,
  username: 'testuser',
  githubUsername: 'testuser',
  xdcWalletAddress: 'xdc123456789',
  emailOptOut: false
};

describe('Session Cleanup Failure Handling', () => {
  let app: express.Application;
  let userRoutes: express.Router;

  beforeEach(async () => {
    // Create a fresh app instance for each test to avoid accumulation
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }));

    // Clear mocks and import routes
    vi.clearAllMocks();
    
    // Import and register user routes after session middleware
    const routesModule = await import('../userRoutes');
    userRoutes = routesModule.default;
    app.use('/api/user', userRoutes);
  });

  it('should succeed even if session destruction fails', async () => {
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    // Create middleware to set up authenticated user and simulate session destroy failure
    app.use('/api/user/delete-account', (req, _res, next) => {
      (req as any).user = { ...mockUser, id: 1 }; // Set authenticated user
      // Mock session.destroy to fail
      const originalDestroy = req.session.destroy.bind(req.session);
      req.session.destroy = (callback: (err?: any) => void) => {
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
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    // Create middleware to set up authenticated user and simulate logout failure
    app.use('/api/user/delete-account', (req, _res, next) => {
      (req as any).user = { ...mockUser, id: 1 }; // Set authenticated user
      // Mock req.logout to fail
      const originalLogout = req.logout.bind(req);
      req.logout = (callback: (err?: any) => void) => {
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
    // Mock successful user deletion
    vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
    vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
      balance: BigInt(0),
      tokenBalance: BigInt(0),
      usdcBalance: BigInt(0)
    });
    vi.mocked(storage.deleteUser).mockResolvedValue(true);

    // Create middleware to set up authenticated user and simulate both failures
    app.use('/api/user/delete-account', (req, _res, next) => {
      (req as any).user = { ...mockUser, id: 1 }; // Set authenticated user
      // Mock req.logout to fail
      const originalLogout = req.logout.bind(req);
      req.logout = (callback: (err?: any) => void) => {
        callback(new Error('Logout failed'));
      };
      // Mock session.destroy to fail
      const originalDestroy = req.session.destroy.bind(req.session);
      req.session.destroy = (callback: (err?: any) => void) => {
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

describe('Email Preferences API Tests with Authentication', () => {
  let app: express.Application;
  let userRoutes: express.Router;

  beforeEach(async () => {
    // Create a fresh app instance for each test
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }));

    // Clear mocks and import routes
    vi.clearAllMocks();
    
    // Import and register user routes after session middleware
    const routesModule = await import('../userRoutes');
    userRoutes = routesModule.default;
    app.use('/api/user', userRoutes);
  });

  describe('PATCH /api/user/email-preferences with CSRF protection', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: false })
        .set('X-CSRF-Token', 'test-csrf-token') // Include CSRF token
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it('should require CSRF token', async () => {
      // Set up authenticated user
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { id: 1, ...mockUser }; // Authenticate user
        next();
      });

      // Test without CSRF token - should fail with 403
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: false })
        .expect(403); // CSRF protection should cause 403 without token

      expect(response.body.error).toBeDefined();
    });

    it('should successfully update email preferences when authenticated with CSRF token', async () => {
      // Mock the DB update to return success
      const mockUpdateResult = [{ id: 1, emailOptOut: true }];
      const mockUpdateMethod = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockUpdateResult)
      };
      vi.mocked(db.update).mockReturnValue(mockUpdateMethod as any);

      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { id: 1, ...mockUser }; // Authenticate user with ID
        next();
      });

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: true })
        .set('X-CSRF-Token', 'valid-csrf-token') // Add valid CSRF token
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Email preferences updated successfully');
      expect(response.body.optOut).toBe(true);
    });
  });

  describe('GET /api/user/email-preferences with authentication', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it('should return user email preferences when authenticated', async () => {
      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { id: 1, ...mockUser }; // Authenticate user with ID
        next();
      });

      // Mock storage.getUserById to return user with email preferences
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        emailOptOut: false,
        username: 'testuser',
        githubUsername: 'testuser'
      } as any);

      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(200);

      expect(response.body.optOut).toBe(false);
    });
  });
});
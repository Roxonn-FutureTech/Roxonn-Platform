import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import session from 'express-session';
import { storage } from '../../storage';
import { blockchain } from '../../blockchain';
import { db } from '../../db';
import { users } from '../../../shared/schema';
import { eq } from 'drizzle-orm';

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

describe('User Routes Session Cleanup Tests', () => {
  let app: express.Application;
  let userRoutes: express.Router;

  beforeEach(async () => {
    // Clear mocks before each test run
    vi.clearAllMocks();
    
    // Create a fresh app instance for each test to avoid accumulation
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours, not secure for testing
    }));

    // Import and register user routes after session middleware
    const routesModule = await import('../userRoutes');
    userRoutes = routesModule.default;
    app.use('/api/user', userRoutes);
  });

  describe('DELETE /api/user/delete-account with session failures', () => {
    beforeEach(() => {
      // Set up default mocks for successful deletion
      vi.mocked(storage.getUserById).mockResolvedValue(mockUser);
      vi.mocked(blockchain.getWalletInfo).mockResolvedValue({
        balance: BigInt(0),
        tokenBalance: BigInt(0),
        usdcBalance: BigInt(0)
      });
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
    });

    it('should succeed even if session destruction fails', async () => {
      // Mock successful user deletion
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
      
      // Create middleware to simulate session destroy failure
      app.use('/api/user/delete-account', (req, _res, next) => {
        // Set up authenticated user
        (req as any).user = { ...mockUser };
        
        // Replace session.destroy to simulate failure
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
      vi.mocked(storage.deleteUser).mockResolvedValue(true);

      // Create middleware to simulate logout failure
      app.use('/api/user/delete-account', (req, _res, next) => {
        // Set up authenticated user
        (req as any).user = { ...mockUser };
        
        // Replace req.logout to simulate failure
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
      vi.mocked(storage.deleteUser).mockResolvedValue(true);

      // Create middleware to simulate both logout and session destroy failures
      app.use('/api/user/delete-account', (req, _res, next) => {
        // Set up authenticated user
        (req as any).user = { ...mockUser };
        
        // Replace both logout and session.destroy to simulate failures
        const originalLogout = req.logout.bind(req);
        req.logout = (callback: (err?: any) => void) => {
          callback(new Error('Logout failed'));
        };
        
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
});

describe('User Routes Email Preferences Tests', () => {
  let app: express.Application;
  let userRoutes: express.Router;

  beforeEach(async () => {
    // Clear mocks before each test run
    vi.clearAllMocks();
    
    // Create a fresh app instance for each test to avoid accumulation
    app = express();
    app.use(express.json());
    
    // Set up session middleware
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours, not secure for testing
    }));

    // Import and register user routes after session middleware
    const routesModule = await import('../userRoutes');
    userRoutes = routesModule.default;
    app.use('/api/user', userRoutes);
  });

  describe('PATCH /api/user/email-preferences', () => {
    beforeEach(() => {
      // Clear mocks
      vi.clearAllMocks();
    });

    it('should handle request with missing optOut field with authentication', async () => {
      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { ...mockUser }; // Authenticate user
        next();
      });

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({})
        .set('X-CSRF-Token', 'test-csrf-token') // Add CSRF token
        .expect(400);

      expect(response.body.error).toBe('optOut field is required');
    });

    it('should handle request with invalid optOut type with authentication', async () => {
      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { ...mockUser }; // Authenticate user
        next();
      });

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: 'invalid' })
        .set('X-CSRF-Token', 'test-csrf-token') // Add CSRF token
        .expect(400);

      expect(response.body.error).toBe('optOut must be a boolean value');
    });

    it('should successfully update email preferences with authentication', async () => {
      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { id: 1, ...mockUser }; // Authenticate user with ID
        next();
      });
      
      // Mock the db.update to return success
      const mockUpdateResult = [{ id: 1, emailOptOut: true }];
      const mockUpdateMethod = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockUpdateResult)
      };
      vi.mocked(db.update).mockReturnValue(mockUpdateMethod as any);

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: true })
        .set('X-CSRF-Token', 'test-csrf-token') // Add CSRF token
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Email preferences updated successfully');
      expect(response.body.optOut).toBe(true);
    });
  });

  describe('GET /api/user/email-preferences', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return user email preferences with authenticated session', async () => {
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

    it('should return false if user has no emailOptOut preference', async () => {
      // Set up authentication middleware for this test
      app.use('/api/user/email-preferences', (req, _res, next) => {
        (req as any).user = { id: 1, ...mockUser }; // Authenticate user with ID
        next();
      });

      // Mock storage.getUserById to return user with undefined emailOptOut
      vi.mocked(storage.getUserById).mockResolvedValue({
        id: 1,
        emailOptOut: undefined as any,
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
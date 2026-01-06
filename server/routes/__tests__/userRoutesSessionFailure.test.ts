import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

// Create a mock session store
const mockSessionStore = {
  destroy: vi.fn((id, callback) => callback(null)), // Mock implementation
  get: vi.fn((id, callback) => callback(null, {})),
  set: vi.fn((id, session, callback) => callback(null)),
};

// Set up test app
const app = express();

// Apply middleware
app.use(express.json());
app.use(session({
  secret: 'test-secret',
  resave: false,
  saveUninitialized: false,
  store: mockSessionStore
}));

// Import and use the router after session middleware
let userRoutes: express.Router;

beforeEach(async () => {
  // Clear mocks before each test
  vi.clearAllMocks();

  // Import the routes after clearing mocks
  const routesModule = await import('../userRoutes');
  userRoutes = routesModule.default;

  app.use('/api/user', userRoutes);
});

// Mock user data
const mockUser = {
  id: 1,
  username: 'testuser',
  githubUsername: 'testuser',
  xdcWalletAddress: 'xdc123456789'
};

describe('User Routes Tests', () => {
  describe('DELETE /api/user/delete-account', () => {
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
      // Mock successful user deletion but failed session destruction
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
      
      // Mock session store to simulate failure on destroy
      const originalDestroy = mockSessionStore.destroy;
      mockSessionStore.destroy = vi.fn((id, callback) => callback(new Error('Session store error')));
      
      // Add session data to simulate the user being logged in
      const agent = request.agent(app);
      await agent
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'testuser' })
        .expect(200)
        .then((response) => {
          expect(response.body.success).toBe(true);
          expect(response.body.message).toBe('Account deleted successfully');
        });
      
      // Restore original function
      mockSessionStore.destroy = originalDestroy;
    });

    it('should succeed even if logout fails', async () => {
      // Mock successful user deletion
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
      
      // Create an app with special middleware that mocks req.logout to fail
      const errorApp = express();
      errorApp.use(express.json());
      
      // Mock the req.logout function to fail
      errorApp.use((req, res, next) => {
        req.logout = (callback) => {
          if (callback) {
            callback(new Error('Logout failed'));
          }
          next();
        };
        req.session = {
          destroy: (cb) => cb(null),
          regenerate: (cb) => cb(null),
          save: (cb) => cb(null),
          touch: () => {},
        } as session.Session;
        next();
      });
      
      // Load routes for error app
      const routesModule = await import('../userRoutes');
      const errorUserRoutes = routesModule.default;
      errorApp.use('/api/user', errorUserRoutes);

      const response = await request(errorApp)
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'testuser' })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Account deleted successfully');
    });

    it('should properly handle both logout and session destruction failures', async () => {
      // Mock successful user deletion
      vi.mocked(storage.deleteUser).mockResolvedValue(true);
      
      // Create app with both logout and session destruction failing
      const errorApp = express();
      errorApp.use(express.json());
      
      errorApp.use((req, res, next) => {
        req.logout = (callback) => {
          if (callback) {
            callback(new Error('Logout failed'));
          }
          next();
        };
        req.session = {
          destroy: (cb) => cb(new Error('Session destruction failed')),
          regenerate: (cb) => cb(null),
          save: (cb) => cb(null),
          touch: () => {},
        } as session.Session;
        next();
      });
      
      // Load routes for error app
      const routesModule = await import('../userRoutes');
      const errorUserRoutes = routesModule.default;
      errorApp.use('/api/user', errorUserRoutes);

      const response = await request(errorApp)
        .post('/api/user/delete-account')
        .send({ confirmUsername: 'testuser' })
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Account deleted successfully');
    });
  });

  describe('PATCH /api/user/email-preferences', () => {
    beforeEach(() => {
      // Clear mocks
      vi.clearAllMocks();
    });

    it('should handle request with missing optOut field', async () => {
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('optOut field is required');
    });

    it('should handle request with invalid optOut type', async () => {
      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: 'invalid' })
        .expect(400);

      expect(response.body.error).toBe('optOut must be a boolean value');
    });

    it('should successfully update email preferences', async () => {
      const mockUser = { id: 1, emailOptOut: false };
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([mockUser])
      } as any);

      const response = await request(app)
        .patch('/api/user/email-preferences')
        .send({ optOut: true })
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

    it('should return user email preferences', async () => {
      const mockUser = { id: 1, emailOptOut: false };
      vi.mocked(storage.getUserById).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(200);

      expect(response.body.optOut).toBe(false);
    });

    it('should return false if user has no emailOptOut preference', async () => {
      const mockUser = { id: 1, emailOptOut: undefined as any };
      vi.mocked(storage.getUserById).mockResolvedValue(mockUser as any);

      const response = await request(app)
        .get('/api/user/email-preferences')
        .expect(200);

      expect(response.body.optOut).toBe(false);
    });
  });
});
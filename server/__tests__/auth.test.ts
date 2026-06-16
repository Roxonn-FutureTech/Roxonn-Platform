import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requireAuth,
  requireVSCodeAuth,
  csrfProtection,
  requireRole,
  requireDeveloper,
  requireClient,
  requireAdmin,
  isAdminUser,
  PROFILE_TYPES,
  PROFILE_DISPLAY_NAMES
} from '../auth';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { config } from '../config';

// Mock dependencies
vi.mock('../db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock('../config', () => ({
  config: {
    sessionSecret: 'test-secret-key',
  },
}));

// Mock log function to prevent console output during tests
vi.mock('../utils', () => ({
  log: vi.fn(),
}));

// Mock drizzle-orm eq function
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((field, value) => ({ field, value })),
}));

// Mock users schema
vi.mock('../../shared/schema', () => ({
  users: {
    id: 'id',
  },
}));

// Mock modules that throw at import time when env vars are missing
vi.mock('../tatum', () => ({
  generateWallet: vi.fn(),
}));

vi.mock('../blockchain', () => ({
  blockchain: {
    registerUser: vi.fn(),
  },
}));

vi.mock('../aws', () => ({
  getWalletSecret: vi.fn(),
  storeWalletSecret: vi.fn(),
}));

vi.mock('../zoho', () => ({
  createZohoLead: vi.fn(),
}));

vi.mock('../storage', () => ({
  DatabaseStorage: class {
    sessionStore = {};
  },
}));

describe('Auth Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest = {
      user: undefined,
      headers: {},
      method: 'GET',
      path: '/api/test',
      session: {} as any,
      body: {},
    };
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
  });

  describe('requireAuth', () => {
    it('should allow authenticated users', () => {
      mockRequest.user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        githubAccessToken: 'token123',
      } as any;

      requireAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject unauthenticated requests', () => {
      mockRequest.user = undefined;

      requireAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject users without GitHub access token', () => {
      mockRequest.user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        githubAccessToken: undefined,
      } as any;

      requireAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'GitHub token not available' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireVSCodeAuth', () => {
    it('should allow authenticated users from Passport', async () => {
      mockRequest.user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        githubAccessToken: 'token123',
      } as any;

      await requireVSCodeAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should authenticate via JWT Bearer token', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.jpg',
        role: 'contributor' as const,
        githubUsername: 'testuser',
        isProfileComplete: true,
        xdcWalletAddress: 'xdc123',
        walletReferenceId: 'ref123',
        githubAccessToken: 'token123',
        promptBalance: 100,
      };

      const token = jwt.sign(user, config.sessionSecret!);
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      (db.query.users.findFirst as any).mockResolvedValue(user);

      await requireVSCodeAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user?.id).toBe(1);
    });

    it('should reject requests without Bearer token', async () => {
      mockRequest.headers = {};

      await requireVSCodeAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Unauthorized - No token provided' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject invalid JWT tokens', async () => {
      mockRequest.headers = {
        authorization: 'Bearer invalid-token',
      };

      await requireVSCodeAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Unauthorized - Invalid token' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject when user not found in database', async () => {
      const user = {
        id: 999,
        githubId: '123',
        username: 'testuser',
      };

      const token = jwt.sign(user, config.sessionSecret!);
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      (db.query.users.findFirst as any).mockResolvedValue(null);

      await requireVSCodeAuth(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Unauthorized - User not found' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('csrfProtection', () => {
    it('should skip CSRF check for auth routes', () => {
      mockRequest.path = '/api/auth/github';
      mockRequest.method = 'POST';

      csrfProtection(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip CSRF check for VSCode AI completions', () => {
      mockRequest.path = '/api/vscode/ai/completions';
      mockRequest.method = 'POST';

      csrfProtection(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should validate CSRF token for POST requests', () => {
      mockRequest.path = '/api/test';
      mockRequest.method = 'POST';
      mockRequest.session = {
        csrfToken: 'session-token-123',
      } as any;
      mockRequest.headers = {
        'x-csrf-token': 'session-token-123',
      };

      csrfProtection(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject POST requests with invalid CSRF token', () => {
      mockRequest.path = '/api/test';
      mockRequest.method = 'POST';
      mockRequest.session = {
        csrfToken: 'session-token-123',
      } as any;
      mockRequest.headers = {
        'x-csrf-token': 'wrong-token',
      };

      csrfProtection(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'CSRF validation failed' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow GET requests without CSRF token', () => {
      mockRequest.path = '/api/test';
      mockRequest.method = 'GET';

      csrfProtection(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('PROFILE_TYPES and PROFILE_DISPLAY_NAMES', () => {
    it('should have correct profile type constants', () => {
      expect(PROFILE_TYPES.DEVELOPER).toBe('contributor');
      expect(PROFILE_TYPES.CLIENT).toBe('poolmanager');
    });

    it('should have correct display names', () => {
      expect(PROFILE_DISPLAY_NAMES.contributor).toBe('Developer');
      expect(PROFILE_DISPLAY_NAMES.poolmanager).toBe('Client');
    });
  });

  describe('requireRole', () => {
    it('should reject unauthenticated requests', async () => {
      mockRequest.user = undefined;

      const middleware = requireRole(['contributor']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject users without role assigned', async () => {
      mockRequest.user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: null,
        githubAccessToken: 'token123',
      } as any;

      const middleware = requireRole(['contributor']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Profile registration incomplete. Please complete your profile setup first.',
        code: 'PROFILE_INCOMPLETE'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow users with matching role (contributor/Developer)', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;

      (db.query.users.findFirst as any).mockResolvedValue(user);

      const middleware = requireRole(['contributor']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should allow users with matching role (poolmanager/Client)', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'poolmanager',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;

      (db.query.users.findFirst as any).mockResolvedValue(user);

      const middleware = requireRole(['poolmanager']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject users with wrong role', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor', // Developer trying to access Client endpoint
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;
      mockRequest.method = 'POST';
      mockRequest.path = '/api/community-bounties';

      (db.query.users.findFirst as any).mockResolvedValue(user);

      const middleware = requireRole(['poolmanager']); // Client only
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'This action is only available for Client accounts. Your account type is Developer.',
        code: 'ROLE_NOT_ALLOWED',
        userRole: 'contributor',
        allowedRoles: ['poolmanager']
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow when user has any of multiple allowed roles', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;

      (db.query.users.findFirst as any).mockResolvedValue(user);

      const middleware = requireRole(['contributor', 'poolmanager']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should verify role from database (not trust session)', async () => {
      // Session says poolmanager, but database says contributor
      const sessionUser = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'poolmanager', // Tampered session data
        githubAccessToken: 'token123',
      };
      const dbUser = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor', // Real role in database
      };
      mockRequest.user = sessionUser as any;
      mockRequest.method = 'POST';
      mockRequest.path = '/api/community-bounties';

      (db.query.users.findFirst as any).mockResolvedValue(dbUser);

      const middleware = requireRole(['poolmanager']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Should be rejected based on DATABASE role, not session role
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject when user not found in database', async () => {
      mockRequest.user = {
        id: 999,
        githubId: '123',
        username: 'testuser',
        role: 'contributor',
        githubAccessToken: 'token123',
      } as any;

      (db.query.users.findFirst as any).mockResolvedValue(null);

      const middleware = requireRole(['contributor']);
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireDeveloper', () => {
    it('should allow contributor role', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;

      (db.query.users.findFirst as any).mockResolvedValue(user);

      await requireDeveloper(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject poolmanager role', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'poolmanager',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;
      mockRequest.method = 'POST';
      mockRequest.path = '/api/community-bounties/1/claim';

      (db.query.users.findFirst as any).mockResolvedValue(user);

      await requireDeveloper(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireClient', () => {
    it('should allow poolmanager role', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'poolmanager',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;

      (db.query.users.findFirst as any).mockResolvedValue(user);

      await requireClient(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject contributor role', async () => {
      const user = {
        id: 1,
        githubId: '123',
        username: 'testuser',
        role: 'contributor',
        githubAccessToken: 'token123',
      };
      mockRequest.user = user as any;
      mockRequest.method = 'POST';
      mockRequest.path = '/api/community-bounties';

      (db.query.users.findFirst as any).mockResolvedValue(user);

      await requireClient(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireAdmin', () => {
    const SAVED_ADMIN_USERNAMES = process.env.ADMIN_USERNAMES;

    afterEach(() => {
      // Restore ADMIN_USERNAMES to its original value after each test
      if (SAVED_ADMIN_USERNAMES === undefined) {
        delete process.env.ADMIN_USERNAMES;
      } else {
        process.env.ADMIN_USERNAMES = SAVED_ADMIN_USERNAMES;
      }
    });

    it('Test 1: returns 401 when req.user is absent', () => {
      mockRequest.user = undefined;
      delete process.env.ADMIN_USERNAMES;

      requireAdmin(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('Test 2: returns 503 when ADMIN_USERNAMES is unset (fail-closed, no throw)', () => {
      mockRequest.user = { id: 1, username: 'dineshroxonn', githubAccessToken: 'tok' } as any;
      delete process.env.ADMIN_USERNAMES;

      requireAdmin(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Admin access not configured' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('Test 3: returns 403 when username NOT in ADMIN_USERNAMES list', () => {
      mockRequest.user = { id: 2, username: 'unknownuser', githubAccessToken: 'tok' } as any;
      process.env.ADMIN_USERNAMES = 'dineshroxonn,dineshrampalli';

      requireAdmin(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Admin access required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('Test 4: calls next() when username IS in ADMIN_USERNAMES (case-insensitive)', () => {
      // 'DineshRoxonn' should match list entry 'dineshroxonn'
      mockRequest.user = { id: 1, username: 'DineshRoxonn', githubAccessToken: 'tok' } as any;
      process.env.ADMIN_USERNAMES = 'dineshroxonn,dineshrampalli';

      requireAdmin(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('Test 4b: calls next() for second admin in list', () => {
      mockRequest.user = { id: 3, username: 'dineshrampalli', githubAccessToken: 'tok' } as any;
      process.env.ADMIN_USERNAMES = 'dineshroxonn,dineshrampalli';

      requireAdmin(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('isAdminUser', () => {
    const SAVED_ADMIN_USERNAMES = process.env.ADMIN_USERNAMES;

    afterEach(() => {
      if (SAVED_ADMIN_USERNAMES === undefined) {
        delete process.env.ADMIN_USERNAMES;
      } else {
        process.env.ADMIN_USERNAMES = SAVED_ADMIN_USERNAMES;
      }
    });

    it('returns false when req.user is absent', () => {
      mockRequest.user = undefined;
      delete process.env.ADMIN_USERNAMES;

      expect(isAdminUser(mockRequest as Request)).toBe(false);
    });

    it('returns false when ADMIN_USERNAMES is unset (no throw)', () => {
      mockRequest.user = { id: 1, username: 'dineshroxonn', githubAccessToken: 'tok' } as any;
      delete process.env.ADMIN_USERNAMES;

      // Must not throw
      expect(() => isAdminUser(mockRequest as Request)).not.toThrow();
      expect(isAdminUser(mockRequest as Request)).toBe(false);
    });

    it('returns false when username is NOT in list', () => {
      mockRequest.user = { id: 2, username: 'unknownuser', githubAccessToken: 'tok' } as any;
      process.env.ADMIN_USERNAMES = 'dineshroxonn,dineshrampalli';

      expect(isAdminUser(mockRequest as Request)).toBe(false);
    });

    it('returns true when username IS in list (case-insensitive)', () => {
      mockRequest.user = { id: 1, username: 'DINESHROXONN', githubAccessToken: 'tok' } as any;
      process.env.ADMIN_USERNAMES = 'dineshroxonn,dineshrampalli';

      expect(isAdminUser(mockRequest as Request)).toBe(true);
    });
  });
});

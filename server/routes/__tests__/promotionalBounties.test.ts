import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import request from 'supertest';
import { db } from '../../db';
import promotionalBountiesRoutes from '../promotionalBounties';

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(),
  },
  users: {},
}));

vi.mock('../../auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 123, role: 'contributor' };
    next();
  },
  requireDeveloper: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireClient: (_req: Request, _res: Response, next: NextFunction) => next(),
  csrfProtection: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../utils', () => ({
  log: vi.fn(),
}));

describe('Promotional bounty routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/promotional', promotionalBountiesRoutes);
  });

  it('rejects submission proof links that do not match the bounty channel', async () => {
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({
          rows: [{
            id: 1,
            status: 'ACTIVE',
            promotional_channels: JSON.stringify(['Twitter']),
            expires_at: null,
            max_submissions: null,
          }],
        }),
      };

      return callback(tx);
    });

    const response = await request(app)
      .post('/api/promotional/submissions')
      .send({
        bountyId: 1,
        proofLinks: ['https://youtube.com/watch?v=abc'],
        description: 'Wrong channel proof link',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('twitter.com');
  });
});

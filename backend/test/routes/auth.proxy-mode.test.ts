import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAuthRouter } from '../../src/routes/auth';
import { DatabaseService } from '../../src/database/DatabaseService';

describe('Auth Routes - Proxy Mode', () => {
  let app: Express;
  let databaseService: DatabaseService;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-key'; // pragma: allowlist secret

    databaseService = new DatabaseService(':memory:');
    await databaseService.initialize();

    await databaseService.getAdapter().execute(
      `INSERT INTO users (id, username, email, passwordHash, firstName, lastName, isActive, isAdmin, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'proxy-user-id',
        'proxyuser',
        'proxy@example.com',
        '$2b$10$abcdefghijklmnopqrstuv',
        'Proxy',
        'User',
        1,
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

    const proxyAuthMiddleware = (
      req: Request,
      _res: Response,
      next: NextFunction,
    ): void => {
      req.user = {
        userId: 'proxy-user-id',
        username: 'proxyuser',
        roles: [],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      next();
    };

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(databaseService, 'proxy', proxyAuthMiddleware));
  });

  afterEach(async () => {
    await databaseService.close();
  });

  it('returns proxy mode from /api/auth/mode', async () => {
    const response = await request(app).get('/api/auth/mode').expect(200);
    expect(response.body.mode).toBe('proxy');
  });

  it('disables /api/auth/login in proxy mode', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'proxyuser', password: 'Password123!' })
      .expect(400);

    expect(response.body.error.code).toBe('AUTH_MODE_PROXY');
  });

  it('returns session user for /api/auth/session in proxy mode', async () => {
    const response = await request(app).get('/api/auth/session').expect(200);

    expect(response.body.mode).toBe('proxy');
    expect(response.body.user).toBeDefined();
    expect(response.body.user.id).toBe('proxy-user-id');
    expect(response.body.user.username).toBe('proxyuser');
  });
});

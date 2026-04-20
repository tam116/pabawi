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
    process.env.AUTH_PROXY_USER_HEADER = 'x-forwarded-user';

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
    delete process.env.AUTH_PROXY_USER_HEADER;
  });

  it('returns proxy mode from /api/auth/mode', async () => {
    const response = await request(app).get('/api/auth/mode').expect(200);
    expect(response.body.mode).toBe('proxy');
  });

  it('authenticates /api/auth/login in proxy mode using trusted user header', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('x-forwarded-user', 'proxyuser')
      .send({})
      .expect(200);

    expect(response.body.user).toBeDefined();
    expect(response.body.user.username).toBe('proxyuser');
    expect(response.body.token).toBeTypeOf('string');
    expect(response.body.refreshToken).toBeTypeOf('string');
  });

  it('returns 401 for /api/auth/login in proxy mode when user header is missing', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({})
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toContain('x-forwarded-user');
  });

  it('returns session user for /api/auth/session in proxy mode', async () => {
    const response = await request(app).get('/api/auth/session').expect(200);

    expect(response.body.mode).toBe('proxy');
    expect(response.body.user).toBeDefined();
    expect(response.body.user.id).toBe('proxy-user-id');
    expect(response.body.user.username).toBe('proxyuser');
  });

  describe('AUTO_PROVISION_EXTERNAL_USERS', () => {
    beforeEach(() => {
      process.env.AUTO_PROVISION_EXTERNAL_USERS = 'true';
      process.env.AUTH_PROXY_EMAIL_HEADER = 'x-forwarded-email';
      process.env.AUTH_PROXY_NAME_HEADER = 'x-remote-name';
    });

    afterEach(() => {
      delete process.env.AUTO_PROVISION_EXTERNAL_USERS;
      delete process.env.AUTH_PROXY_EMAIL_HEADER;
      delete process.env.AUTH_PROXY_NAME_HEADER;
    });

    it('auto-provisions a new user on first proxy login', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-forwarded-user', 'newextuser')
        .set('x-forwarded-email', 'newextuser@example.com')
        .send({})
        .expect(200);

      expect(response.body.user).toBeDefined();
      expect(response.body.user.username).toBe('newextuser');
      expect(response.body.token).toBeTypeOf('string');
    });

    it('uses email header when provisioning new user', async () => {
      await request(app)
        .post('/api/auth/login')
        .set('x-forwarded-user', 'emailuser')
        .set('x-forwarded-email', 'emailuser@corp.example.com')
        .send({})
        .expect(200);

      // Second login should succeed (user now exists)
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-forwarded-user', 'emailuser')
        .send({})
        .expect(200);

      expect(response.body.user.username).toBe('emailuser');
    });

    it('uses proxy name header to split first and last name when provisioning', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('x-forwarded-user', 'nameduser')
        .set('x-forwarded-email', 'nameduser@example.com')
        .set('x-remote-name', 'Jane Mary Doe')
        .send({})
        .expect(200);

      expect(response.body.user.username).toBe('nameduser');
      expect(response.body.user.firstName).toBe('Jane');
      expect(response.body.user.lastName).toBe('Mary Doe');
    });

    it('returns 401 for unknown user when auto-provision is disabled', async () => {
      delete process.env.AUTO_PROVISION_EXTERNAL_USERS;

      await request(app)
        .post('/api/auth/login')
        .set('x-forwarded-user', 'noprovisionuser')
        .send({})
        .expect(401);
    });
  });
});

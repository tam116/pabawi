import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { SQLiteAdapter } from "../../src/database/SQLiteAdapter";
import type { DatabaseAdapter } from "../../src/database/DatabaseAdapter";
import { createProxyAuthMiddleware } from "../../src/middleware/proxyAuthMiddleware";

describe("Proxy Authentication Middleware", () => {
  let db: DatabaseAdapter;
  let middleware: ReturnType<typeof createProxyAuthMiddleware>;

  beforeEach(async () => {
    db = new SQLiteAdapter(":memory:");
    await db.initialize();
    await initializeSchema(db);

    await db.execute(
      `INSERT INTO users (id, username, email, passwordHash, firstName, lastName, isActive, isAdmin, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "test-user-id",
        "proxy-user",
        "proxy@example.com",
        "$2b$10$abcdefghijklmnopqrstuv",
        "Proxy",
        "User",
        1,
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

    middleware = createProxyAuthMiddleware(db, {
      userHeader: "x-forwarded-user",
      emailHeader: "x-forwarded-email",
      groupsHeader: "x-forwarded-groups",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  const createMocks = () => {
    const req = {
      headers: {},
      header(name: string): string | undefined {
        const key = name.toLowerCase();
        return this.headers[key as keyof typeof this.headers] as string | undefined;
      },
    } as unknown as Request;

    const res = {
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: unknown) {
        this.body = data;
        return this;
      },
      statusCode: 0,
      body: null,
    } as unknown as Response;

    const next = (() => {
      next.called = true;
    }) as NextFunction & { called?: boolean };
    next.called = false;

    return { req, res, next };
  };

  it("accepts configured proxy user header and attaches request user", async () => {
    const { req, res, next } = createMocks();
    req.headers = {
      "x-forwarded-user": "proxy-user",
      "x-forwarded-groups": "infra,operators",
    } as Request["headers"];

    await middleware(req, res, next);

    expect(next.called).toBe(true);
    expect(req.user?.userId).toBe("test-user-id");
    expect(req.user?.username).toBe("proxy-user");
    expect(req.user?.roles).toContain("infra");
    expect(req.user?.roles).toContain("operators");
  });

  it("returns 401 when identity header is missing", async () => {
    const { req, res, next } = createMocks();

    await middleware(req, res, next);

    expect(next.called).toBe(false);
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when proxy identity is not mapped to local user", async () => {
    const { req, res, next } = createMocks();
    req.headers = {
      "x-forwarded-user": "unknown-user",
    } as Request["headers"];

    await middleware(req, res, next);

    expect(next.called).toBe(false);
    expect((res as any).statusCode).toBe(401);
    expect((res as any).body.error.message).toContain("not authorized");
  });
});

async function initializeSchema(db: DatabaseAdapter): Promise<void> {
  await db.execute(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    isActive INTEGER NOT NULL DEFAULT 1,
    isAdmin INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastLoginAt TEXT
  )`);
}

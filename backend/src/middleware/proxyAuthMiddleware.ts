import type { Request, Response, NextFunction } from "express";
import type { DatabaseAdapter } from "../database/DatabaseAdapter";
import { LoggerService } from "../services/LoggerService";
import {
  ERROR_CODES,
  sendDatabaseError,
  isDatabaseConnectionError,
} from "../utils/errorHandling";

const logger = new LoggerService();

interface ProxyAuthConfig {
  userHeader: string;
  emailHeader?: string;
  groupsHeader?: string;
}

interface AuthenticatedUser {
  id: string;
  username: string;
  isAdmin: number;
}

function parseHeaderList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createProxyAuthMiddleware(
  db: DatabaseAdapter,
  proxyConfig: ProxyAuthConfig,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userHeaderValue = req.header(proxyConfig.userHeader);

      if (!userHeaderValue) {
        res.status(401).json({
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: `Missing trusted proxy identity header: ${proxyConfig.userHeader}`,
          },
        });
        return;
      }

      const username = userHeaderValue.trim();
      if (!username) {
        res.status(401).json({
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: "Invalid proxy identity header value",
          },
        });
        return;
      }

      let user = await db.queryOne<AuthenticatedUser>(
        "SELECT id, username, isAdmin FROM users WHERE username = ? AND isActive = 1",
        [username],
      );

      if (!user && proxyConfig.emailHeader) {
        const emailHeaderValue = req.header(proxyConfig.emailHeader)?.trim();
        if (emailHeaderValue) {
          user = await db.queryOne<AuthenticatedUser>(
            "SELECT id, username, isAdmin FROM users WHERE email = ? AND isActive = 1",
            [emailHeaderValue],
          );
        }
      }

      if (!user) {
        logger.warn("Proxy-authenticated identity is not mapped to a local active user", {
          component: "proxyAuthMiddleware",
          operation: "authenticate",
          metadata: {
            proxyUsername: username,
          },
        });

        res.status(401).json({
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: "Proxy identity is not authorized in Pabawi",
          },
        });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const groups = parseHeaderList(
        proxyConfig.groupsHeader ? req.header(proxyConfig.groupsHeader) : undefined,
      );

      req.user = {
        userId: user.id,
        username: user.username,
        roles: user.isAdmin === 1 ? ["admin", ...groups] : groups,
        iat: now,
        exp: now + 3600,
      };

      next();
    } catch (error) {
      if (isDatabaseConnectionError(error)) {
        sendDatabaseError(
          res,
          error,
          "Authentication service temporarily unavailable",
        );
        return;
      }

      logger.error(
        "Failed to authenticate request via proxy headers",
        {
          component: "proxyAuthMiddleware",
          operation: "authenticate",
        },
        error instanceof Error ? error : undefined,
      );

      res.status(401).json({
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: "Authentication failed",
        },
      });
    }
  };
}

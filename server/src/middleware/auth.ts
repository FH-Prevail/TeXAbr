import type { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { Config } from "../config";
import type { Db } from "../db/db";
import type { UserRow } from "../db/users";

// Augment Express's Request once so `req.user` is typed in every route
// instead of forcing each handler to cast through AuthedRequest.
declare module "express-serve-static-core" {
  interface Request {
    user?: UserRow;
  }
}

interface TokenPayload {
  sub: number;
  role: "user" | "admin";
  tv: number;          // token_version snapshot at issuance — bumped to revoke
}

export function signToken(cfg: Config, db: Db, user: UserRow): string {
  const payload: TokenPayload = { sub: user.id, role: user.role, tv: user.token_version };
  return jwt.sign(payload, cfg.auth.jwtSecret, {
    expiresIn: `${db.registry.getInt("auth.sessionTtlHours")}h`,
  });
}

export function requireAuth(cfg: Config, db: Db): RequestHandler {
  return (req, res, next) => {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: "unauthenticated" });

    let verified: unknown;
    try {
      verified = jwt.verify(token, cfg.auth.jwtSecret);
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!verified || typeof verified !== "object") {
      return res.status(401).json({ error: "invalid token" });
    }
    const payload = verified as Partial<TokenPayload>;
    if (typeof payload.sub !== "number" || typeof payload.tv !== "number") {
      return res.status(401).json({ error: "invalid token" });
    }

    const user = db.users.findById(payload.sub);
    if (!user || user.disabled) {
      return res.status(401).json({ error: "user disabled or missing" });
    }
    if (user.token_version !== payload.tv) {
      return res.status(401).json({ error: "session revoked" });
    }
    req.user = user;
    next();
  };
}

export function requireAdmin(cfg: Config, db: Db): RequestHandler {
  const auth = requireAuth(cfg, db);
  return (req, res, next) => {
    auth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "admin only" });
      }
      next();
    });
  };
}

function readToken(req: Request): string | null {
  const h = req.header("authorization");
  if (h?.startsWith("Bearer ")) return h.slice("Bearer ".length).trim();
  const c = (req as Request & { cookies?: Record<string, string> }).cookies?.["texabr.token"];
  return c ?? null;
}

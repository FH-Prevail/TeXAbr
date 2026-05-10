import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { Db } from "../db/db";

// Double-submit CSRF: a non-httpOnly cookie holds a random token; the JS
// client must echo it back in the X-CSRF-Token header on every state-changing
// request. The server compares them with a timing-safe equality check.
//
// SameSite on the session cookie is the *primary* defense. This middleware
// is defense-in-depth, also covering misconfigured proxies that strip
// SameSite or browsers where SameSite cannot be enforced.
//
// Bearer-token requests (Authorization: Bearer ...) are exempt — those are
// not driven by ambient cookie auth, so CSRF doesn't apply.

const COOKIE_NAME = "texabr.csrf";
const HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOKEN_BYTES = 32;

export function newCsrfToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export function setCsrfCookie(db: Db, res: Response, isHttps: boolean, token?: string): string {
  const value = token ?? newCsrfToken();
  res.cookie(COOKIE_NAME, value, {
    httpOnly: false,                  // intentionally readable to JS
    secure: isHttps || db.registry.getBool("auth.https.enforced"),
    sameSite: db.registry.getEnum("auth.cookieSameSite") as "lax" | "strict" | "none",
    maxAge: db.registry.getInt("auth.sessionTtlHours") * 3_600_000,
    path: "/",
  });
  return value;
}

export function clearCsrfCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function csrfGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const auth = req.header("authorization");
    if (auth?.startsWith("Bearer ")) return next();

    const cookieToken = readCookie(req, COOKIE_NAME);
    const headerToken = req.header(HEADER_NAME);
    if (!cookieToken || !headerToken) {
      return res.status(403).json({ error: "csrf token missing" });
    }
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "csrf token mismatch" });
    }
    next();
  };
}

function readCookie(req: Request, name: string): string | null {
  const c = (req as Request & { cookies?: Record<string, string> }).cookies;
  return c?.[name] ?? null;
}

import { Router } from "express";
import bcrypt from "bcrypt";
import type { Request, Response } from "express";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAuth, signToken } from "../middleware/auth";
import { getRegistrationMode } from "../services/registration";
import { makeLockout, type LockoutService } from "../services/lockout";
import { setCsrfCookie, clearCsrfCookie } from "../middleware/csrf";
import {
  generateRecoverySeed,
  hashRecoverySeed,
  isValidRecoverySeedFormat,
  verifyRecoverySeed,
} from "../services/recoverySeed";
import { userDiskUsageBytes } from "../services/quota";
import { mbToBytes } from "../services/projects";

let lockoutSvc: LockoutService | null = null;
function getLockout(db: Db): LockoutService {
  if (!lockoutSvc) lockoutSvc = makeLockout(db);
  return lockoutSvc;
}

export function authRouter(cfg: Config, db: Db) {
  const r = Router();

  r.post("/login", async (req, res) => {
    const lockout = getLockout(db);
    const ip = clientIp(req);

    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }

    const lk = lockout.check({ username, ip });
    if (lk.locked) {
      lockout.recordAttempt({ username, ip, outcome: "locked" });
      db.audit.record({
        event: "auth.login.fail", actor: { name: username }, ip,
        outcome: "denied", detail: { reason: "locked", scope: lk.scope, until: lk.until },
      });
      return res.status(429).json({ error: "too many failed attempts; try again later", until: lk.until });
    }

    const user = db.users.findByUsername(username);
    if (!user) {
      lockout.recordAttempt({ username, ip, outcome: "no_user" });
      db.audit.record({ event: "auth.login.fail", actor: { name: username }, ip, outcome: "denied", detail: { reason: "no_user" } });
      return res.status(401).json({ error: "invalid credentials" });
    }
    if (user.disabled) {
      lockout.recordAttempt({ username, ip, outcome: "disabled" });
      db.audit.record({ event: "auth.login.fail", actor: { id: user.id, name: username }, ip, outcome: "denied", detail: { reason: "disabled" } });
      return res.status(401).json({ error: "invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      lockout.recordAttempt({ username, ip, outcome: "bad_password" });
      db.audit.record({ event: "auth.login.fail", actor: { id: user.id, name: username }, ip, outcome: "denied", detail: { reason: "bad_password" } });
      return res.status(401).json({ error: "invalid credentials" });
    }

    lockout.recordAttempt({ username, ip, outcome: "success" });
    db.users.touchLogin(user.id);
    issueSession(cfg, db, res, user.id);
    db.audit.record({ event: "auth.login.success", actor: { id: user.id, name: user.username }, ip });
    res.json({ user: publicUser(user) });
  });

  r.post("/register", async (req, res) => {
    const ip = clientIp(req);
    const mode = getRegistrationMode(cfg, db);
    if (mode === "closed") {
      return res.status(403).json({ error: "registration is closed" });
    }

    const { username, password, email, invite } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: "invalid username" });
    }
    const minLen = db.registry.getInt("registration.passwordMinLength");
    if (password.length < minLen) {
      return res.status(400).json({ error: `password must be >= ${minLen} characters` });
    }

    if (db.users.findByUsername(username)) {
      return res.status(409).json({ error: "username taken" });
    }
    if (mode === "invite" && (typeof invite !== "string" || !invite)) {
      return res.status(403).json({ error: "invite token required" });
    }

    const cost = db.registry.getInt("auth.bcryptCost");
    const hash = await bcrypt.hash(password, cost);
    // Generate the recovery seed BEFORE the transaction so we can return its
    // plaintext to the user once. The DB only ever stores the bcrypt hash.
    const recoverySeed = generateRecoverySeed();
    const recoverySeedHash = await hashRecoverySeed(recoverySeed, cost);
    let user;
    try {
      user = db.raw.transaction(() => {
        if (mode === "invite") {
          const consumed = db.invites.consume(invite);
          if (!consumed) throw new Error("invalid or expired invite");
        }
        return db.users.create({
          username,
          email: typeof email === "string" ? email : null,
          passwordHash: hash,
          role: "user",
          recoverySeedHash,
        });
      })();
    } catch (err) {
      if ((err as Error).message === "invalid or expired invite") {
        return res.status(403).json({ error: "invalid or expired invite" });
      }
      if ((err as Error).message.includes("UNIQUE")) {
        return res.status(409).json({ error: "username or email taken" });
      }
      throw err;
    }

    issueSession(cfg, db, res, user.id);
    db.audit.record({ event: "auth.register", actor: { id: user.id, name: user.username }, ip, detail: { mode } });
    // recoverySeed is included exactly once, in this response. Never stored
    // plaintext anywhere on the server; the client UI is responsible for
    // showing it to the user with a "save this somewhere safe" warning.
    res.json({ user: publicUser(user), recoverySeed });
  });

  // ---- Password recovery via seed --------------------------------------------
  // Body: { username, recoverySeed, newPassword }. Same lockout counters as
  // /login, so brute-forcing the seed is throttled identically.
  r.post("/recover", async (req, res) => {
    const lockout = getLockout(db);
    const ip = clientIp(req);
    const { username, recoverySeed, newPassword } = req.body ?? {};

    if (typeof username !== "string" || typeof newPassword !== "string" || typeof recoverySeed !== "string") {
      return res.status(400).json({ error: "username, recoverySeed, and newPassword are required" });
    }
    if (!isValidRecoverySeedFormat(recoverySeed)) {
      return res.status(400).json({ error: "recoverySeed must be 32 hex characters (groups of 4, hyphen-separated)" });
    }
    const minLen = db.registry.getInt("registration.passwordMinLength");
    if (newPassword.length < minLen) {
      return res.status(400).json({ error: `password must be >= ${minLen} characters` });
    }

    const lk = lockout.check({ username, ip });
    if (lk.locked) {
      lockout.recordAttempt({ username, ip, outcome: "locked" });
      db.audit.record({
        event: "auth.recover.fail", actor: { name: username }, ip,
        outcome: "denied", detail: { reason: "locked" },
      });
      return res.status(429).json({ error: "too many failed attempts; try again later" });
    }

    const user = db.users.findByUsername(username);
    if (!user || user.disabled) {
      // Same bucket as bad_password — these all signal that some credential
      // is wrong, and we don't want to leak which one.
      lockout.recordAttempt({ username, ip, outcome: "bad_password" });
      db.audit.record({
        event: "auth.recover.fail", actor: { name: username }, ip,
        outcome: "denied", detail: { reason: user ? "disabled" : "no_user" },
      });
      return res.status(401).json({ error: "invalid credentials" });
    }

    const ok = await verifyRecoverySeed(recoverySeed, user.recovery_seed_hash);
    if (!ok) {
      lockout.recordAttempt({ username, ip, outcome: "bad_password" });
      db.audit.record({
        event: "auth.recover.fail", actor: { id: user.id, name: user.username }, ip,
        outcome: "denied", detail: { reason: "bad_seed" },
      });
      return res.status(401).json({ error: "invalid credentials" });
    }

    const cost = db.registry.getInt("auth.bcryptCost");
    const newHash = await bcrypt.hash(newPassword, cost);
    // Rotate the seed at the same time so a leaked seed can't be replayed.
    const nextSeed = generateRecoverySeed();
    const nextSeedHash = await hashRecoverySeed(nextSeed, cost);

    db.raw.transaction(() => {
      db.users.setPassword(user.id, newHash);
      db.users.setRecoverySeedHash(user.id, nextSeedHash);
      db.users.bumpTokenVersion(user.id);
    })();

    lockout.recordAttempt({ username, ip, outcome: "success" });
    db.audit.record({
      event: "auth.recover.success", actor: { id: user.id, name: user.username }, ip,
    });
    res.json({ ok: true, recoverySeed: nextSeed });
  });

  // ---- Rotate the recovery seed for a logged-in user -------------------------
  // Returns a fresh seed; old seed is invalidated atomically.
  r.post("/rotate-seed", requireAuth(cfg, db), async (req, res) => {
    const me = req.user!;
    const cost = db.registry.getInt("auth.bcryptCost");
    const nextSeed = generateRecoverySeed();
    const nextSeedHash = await hashRecoverySeed(nextSeed, cost);
    db.users.setRecoverySeedHash(me.id, nextSeedHash);
    db.audit.record({
      event: "auth.recover.rotate", actor: { id: me.id, name: me.username }, ip: clientIp(req),
    });
    res.json({ ok: true, recoverySeed: nextSeed });
  });

  r.post("/logout", (req, res) => {
    const me = readUserFromCookie(cfg, db, req);
    res.clearCookie("texabr.token", { path: "/" });
    clearCsrfCookie(res);
    if (me) {
      db.audit.record({ event: "auth.logout", actor: { id: me.id, name: me.username }, ip: clientIp(req) });
    }
    res.json({ ok: true });
  });

  r.post("/logout-all", requireAuth(cfg, db), (req, res) => {
    // Bumps the user's token_version so every issued JWT for this user is now
    // invalid. Useful from the account-settings panel for "sign out everywhere".
    db.users.bumpTokenVersion(req.user!.id);
    res.clearCookie("texabr.token", { path: "/" });
    clearCsrfCookie(res);
    db.audit.record({ event: "auth.session.revoke_all", actor: { id: req.user!.id, name: req.user!.username }, ip: clientIp(req) });
    res.json({ ok: true });
  });

  r.post("/change-password", requireAuth(cfg, db), async (req, res) => {
    const me = req.user!;
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ error: "currentPassword and newPassword required" });
    }
    const minLen = db.registry.getInt("registration.passwordMinLength");
    if (newPassword.length < minLen) {
      return res.status(400).json({ error: `password must be >= ${minLen} characters` });
    }
    const ok = await bcrypt.compare(currentPassword, me.password_hash);
    if (!ok) return res.status(401).json({ error: "current password incorrect" });
    const hash = await bcrypt.hash(newPassword, db.registry.getInt("auth.bcryptCost"));
    db.raw.transaction(() => {
      db.users.setPassword(me.id, hash);
      db.users.bumpTokenVersion(me.id);
    })();
    // Re-issue a session for the active browser so the user isn't logged out.
    const fresh = db.users.findById(me.id)!;
    issueSession(cfg, db, res, fresh.id);
    db.audit.record({ event: "auth.password.change", actor: { id: me.id, name: me.username }, ip: clientIp(req) });
    res.json({ ok: true });
  });

  r.get("/me", requireAuth(cfg, db), (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  // Per-user disk quota: total bytes consumed by all of the user's owned
  // projects under dataDir/projects/<userId>/, and the cap from the registry.
  // The Projects page polls this; uploads / writes that would exceed the cap
  // are blocked server-side in services/quota.ts.
  r.get("/quota", requireAuth(cfg, db), async (req, res) => {
    const me = req.user!;
    const capMb = db.registry.getInt("limits.maxUserDiskMb");
    const capBytes = mbToBytes(capMb);
    const usedBytes = await userDiskUsageBytes(cfg, me.id);
    const remainingBytes = Math.max(0, capBytes - usedBytes);
    const percent = capBytes > 0 ? Math.min(100, Math.round((usedBytes / capBytes) * 100)) : 0;
    res.json({ usedBytes, capBytes, remainingBytes, capMb, percent });
  });

  return r;
}

export function issueSession(cfg: Config, db: Db, res: Response, userId: number): void {
  const fresh = db.users.findById(userId);
  if (!fresh) throw new Error("issueSession: user vanished");
  const token = signToken(cfg, db, fresh);
  const ttlMs = db.registry.getInt("auth.sessionTtlHours") * 3_600_000;
  const isHttps = cfg.https.enabled || db.registry.getBool("auth.https.enforced");
  res.cookie("texabr.token", token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: db.registry.getEnum("auth.cookieSameSite") as "lax" | "strict" | "none",
    maxAge: ttlMs,
    path: "/",
  });
  setCsrfCookie(db, res, isHttps);
}

function readUserFromCookie(cfg: Config, db: Db, req: Request) {
  // Best-effort decode for audit logging during /logout. Don't throw — even an
  // expired cookie is fine; we still want to clear it.
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.["texabr.token"];
  if (!cookie) return null;
  try {
    const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
    const decoded = jwt.verify(cookie, cfg.auth.jwtSecret) as { sub?: number };
    if (typeof decoded?.sub !== "number") return null;
    return db.users.findById(decoded.sub) ?? null;
  } catch {
    return null;
  }
}

function clientIp(req: Request): string | null {
  return (req.header("x-forwarded-for")?.split(",")[0].trim()) || req.ip || null;
}

function publicUser(u: { id: number; username: string; role: string; email: string | null }) {
  return { id: u.id, username: u.username, role: u.role, email: u.email };
}

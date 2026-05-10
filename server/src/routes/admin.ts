import { Router } from "express";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAdmin } from "../middleware/auth";
import { getRegistrationMode, registrationFlags, setRegistrationMode } from "../services/registration";
import { getTlsHealth } from "../services/tlsHealth";
import { makeLockout } from "../services/lockout";

export function adminRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAdmin(cfg, db));
  const lockout = makeLockout(db);

  // ----- registration / global settings (legacy view) ---------------------
  r.get("/settings", (_req, res) => {
    const mode = getRegistrationMode(cfg, db);
    res.json({
      registration: registrationFlags(mode),
      https: getTlsHealth(cfg),
    });
  });

  r.patch("/settings/registration", (req, res) => {
    const me = req.user!;
    const before = getRegistrationMode(cfg, db);
    const { mode, open, requireInvite } = req.body ?? {};
    let next = before;
    if (mode === "closed" || mode === "invite" || mode === "open") {
      next = mode;
    } else if (typeof open === "boolean" || typeof requireInvite === "boolean") {
      const nextOpen = typeof open === "boolean"
        ? open
        : db.settings.getBool("registration.open", cfg.registration.open);
      const nextRequireInvite = typeof requireInvite === "boolean"
        ? requireInvite
        : db.settings.getBool("registration.requireInvite", cfg.registration.requireInvite);
      next = nextOpen && !nextRequireInvite ? "open" : nextRequireInvite ? "invite" : "closed";
    }
    setRegistrationMode(db, next);
    db.audit.record({
      event: "admin.settings.registration",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      detail: { before, after: next },
    });
    res.json({ ok: true });
  });

  // ----- typed runtime-settings registry ----------------------------------
  r.get("/registry", (_req, res) => {
    res.json({
      settings: db.registry.list().map((s) => ({
        key: s.def.key,
        type: s.def.type,
        group: s.def.group,
        label: s.def.label,
        description: s.def.description,
        requiresRestart: !!s.def.requiresRestart,
        secret: !!s.def.secret,
        ...(s.def.type === "int" ? { min: s.def.min, max: s.def.max } : {}),
        ...(s.def.type === "enum" ? { values: s.def.values } : {}),
        default: s.def.default,
        value: s.def.secret ? null : s.value,
        source: s.source,
      })),
    });
  });

  r.patch("/registry/:key", (req, res) => {
    const me = req.user!;
    const key = req.params.key;
    const { value } = req.body ?? {};
    if (value === undefined) return res.status(400).json({ error: "value required" });
    const before = db.registry.state(key);
    if (!before) return res.status(404).json({ error: `unknown setting: ${key}` });
    try {
      const after = db.registry.set(key, value);
      db.audit.record({
        event: "admin.settings.update",
        actor: { id: me.id, name: me.username },
        ip: clientIp(req),
        target: `setting:${key}`,
        detail: {
          before: before.def.secret ? "***" : before.value,
          after: after.def.secret ? "***" : after.value,
          source: after.source,
        },
      });
      res.json({ ok: true, value: after.value, source: after.source });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.delete("/registry/:key", (req, res) => {
    const me = req.user!;
    const key = req.params.key;
    const before = db.registry.state(key);
    if (!before) return res.status(404).json({ error: `unknown setting: ${key}` });
    const after = db.registry.reset(key)!;
    db.audit.record({
      event: "admin.settings.reset",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      target: `setting:${key}`,
      detail: { fellBackTo: after.source },
    });
    res.json({ ok: true, value: after.value, source: after.source });
  });

  // ----- audit log --------------------------------------------------------
  r.get("/audit", (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    const event = typeof req.query.event === "string" ? req.query.event : undefined;
    const actorId = req.query.actorId ? Number(req.query.actorId) : undefined;
    res.json({
      entries: db.audit.recent({
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
        event,
        actorId: Number.isFinite(actorId) ? actorId : undefined,
      }),
    });
  });

  // ----- lockouts ---------------------------------------------------------
  r.get("/lockouts", (_req, res) => {
    res.json(lockout.status());
  });

  r.post("/lockouts/clear", (req, res) => {
    const me = req.user!;
    const { username, ip } = req.body ?? {};
    lockout.clear({
      username: typeof username === "string" ? username : undefined,
      ip: typeof ip === "string" ? ip : undefined,
    });
    db.audit.record({
      event: "admin.lockout.clear",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      detail: { username, ip },
    });
    res.json({ ok: true });
  });

  // ----- users ------------------------------------------------------------
  r.get("/users", (_req, res) => {
    res.json({
      users: db.users.list().map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        disabled: !!u.disabled,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
      })),
    });
  });

  r.patch("/users/:id", (req, res) => {
    const me = req.user!;
    const id = Number(req.params.id);
    const target = db.users.findById(id);
    if (!target) return res.status(404).json({ error: "not found" });

    const { role, disabled } = req.body ?? {};
    const audit = (event: string, detail: Record<string, unknown>) =>
      db.audit.record({ event, actor: { id: me.id, name: me.username }, ip: clientIp(req), target: `user:${id}`, detail });

    if (typeof role === "string" && (role === "user" || role === "admin")) {
      if (target.id === me.id && role !== "admin") {
        return res.status(400).json({ error: "cannot demote yourself" });
      }
      if (target.role === "admin" && role === "user" && db.users.countAdmins() <= 1) {
        return res.status(400).json({ error: "cannot demote the last admin" });
      }
      if (target.role !== role) {
        db.users.setRole(id, role);
        // Demoting from admin invalidates outstanding admin-scope sessions.
        if (target.role === "admin" && role === "user") db.users.bumpTokenVersion(id);
        audit("admin.user.role", { before: target.role, after: role });
      }
    }

    if (typeof disabled === "boolean") {
      if (target.id === me.id && disabled) {
        return res.status(400).json({ error: "cannot disable yourself" });
      }
      if (target.role === "admin" && disabled && db.users.countAdmins() <= 1) {
        return res.status(400).json({ error: "cannot disable the last admin" });
      }
      if (!!target.disabled !== disabled) {
        db.users.setDisabled(id, disabled);
        if (disabled) db.users.bumpTokenVersion(id);
        audit(disabled ? "admin.user.disable" : "admin.user.enable", {});
      }
    }

    res.json({ user: db.users.findById(id) });
  });

  r.post("/users/:id/reset-password", async (req, res) => {
    const me = req.user!;
    const id = Number(req.params.id);
    const target = db.users.findById(id);
    if (!target) return res.status(404).json({ error: "not found" });
    const { password } = req.body ?? {};
    const minLen = db.registry.getInt("registration.passwordMinLength");
    if (typeof password !== "string" || password.length < minLen) {
      return res.status(400).json({ error: `password must be >= ${minLen} characters` });
    }
    const hash = await bcrypt.hash(password, db.registry.getInt("auth.bcryptCost"));
    db.raw.transaction(() => {
      db.users.setPassword(id, hash);
      db.users.bumpTokenVersion(id);
    })();
    db.audit.record({
      event: "admin.user.reset_password",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      target: `user:${id}`,
    });
    res.json({ ok: true });
  });

  r.post("/users/:id/revoke-sessions", (req, res) => {
    const me = req.user!;
    const id = Number(req.params.id);
    const target = db.users.findById(id);
    if (!target) return res.status(404).json({ error: "not found" });
    db.users.bumpTokenVersion(id);
    db.audit.record({
      event: "admin.user.revoke_sessions",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      target: `user:${id}`,
    });
    res.json({ ok: true });
  });

  r.delete("/users/:id", async (req, res) => {
    const me = req.user!;
    const id = Number(req.params.id);
    const target = db.users.findById(id);
    if (!target) return res.status(404).json({ error: "not found" });
    if (target.id === me.id) return res.status(400).json({ error: "cannot delete yourself" });
    if (target.role === "admin" && db.users.countAdmins() <= 1) {
      return res.status(400).json({ error: "cannot delete the last admin" });
    }
    db.users.delete(id);
    await fs.rm(path.join(cfg.dataDir, "projects", String(id)), { recursive: true, force: true });
    db.audit.record({
      event: "admin.user.delete",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
      target: `user:${id}`,
      detail: { username: target.username },
    });
    res.json({ ok: true });
  });

  return r;
}

function clientIp(req: Request): string | null {
  return (req.header("x-forwarded-for")?.split(",")[0].trim()) || req.ip || null;
}

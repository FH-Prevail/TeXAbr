import { Router } from "express";
import bcrypt from "bcrypt";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { issueSession } from "./auth";
import { generateRecoverySeed, hashRecoverySeed } from "../services/recoverySeed";

// One-shot endpoint to claim the bootstrap admin account using the token
// printed by install.sh. Disables itself once any admin exists.
export function setupRouter(cfg: Config, db: Db) {
  const r = Router();

  r.post("/", async (req, res) => {
    if (db.users.countAdmins() > 0) {
      return res.status(409).json({ error: "already initialised" });
    }
    if (!cfg.auth.bootstrapToken) {
      return res.status(409).json({ error: "no bootstrap token configured" });
    }

    const { token, username, password, email } = req.body ?? {};
    if (token !== cfg.auth.bootstrapToken) {
      db.audit.record({ event: "auth.bootstrap.fail", actor: { name: typeof username === "string" ? username : null }, outcome: "denied", detail: { reason: "bad_bootstrap_token" } });
      return res.status(403).json({ error: "bad bootstrap token" });
    }
    const minLen = db.registry.getInt("registration.passwordMinLength");
    if (!validUsername(username) || !validPassword(password, minLen)) {
      return res.status(400).json({ error: `username 3-32 chars, password >= ${minLen} chars` });
    }

    const cost = db.registry.getInt("auth.bcryptCost");
    const hash = await bcrypt.hash(password, cost);
    const recoverySeed = generateRecoverySeed();
    const recoverySeedHash = await hashRecoverySeed(recoverySeed, cost);

    const user = db.users.create({
      username,
      email: typeof email === "string" ? email : null,
      passwordHash: hash,
      role: "admin",
      recoverySeedHash,
    });

    issueSession(cfg, db, res, user.id);
    db.audit.record({ event: "auth.bootstrap.success", actor: { id: user.id, name: user.username } });
    res.json({ user: publicUser(user), recoverySeed });
  });

  return r;
}

function validUsername(u: unknown) {
  return typeof u === "string" && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}
function validPassword(p: unknown, minLen: number) {
  return typeof p === "string" && p.length >= minLen && p.length <= 256;
}
function publicUser(u: { id: number; username: string; role: string; email: string | null }) {
  return { id: u.id, username: u.username, role: u.role, email: u.email };
}

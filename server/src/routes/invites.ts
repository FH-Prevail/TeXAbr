import { Router } from "express";
import crypto from "node:crypto";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAdmin } from "../middleware/auth";

export function invitesRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAdmin(cfg, db));

  r.get("/", (_req, res) => {
    res.json({ invites: db.invites.list() });
  });

  r.post("/", (req, res) => {
    const admin = req.user!;
    const uses = clampInt(req.body?.uses, 1, 1, 1000);
    const ttlHours = req.body?.ttlHours == null ? null : clampInt(req.body.ttlHours, 0, 1, 24 * 365);
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : null;

    const token = crypto.randomBytes(18).toString("base64url");
    const expiresAt = ttlHours ? Date.now() + ttlHours * 3_600_000 : null;

    const invite = db.invites.create({
      token,
      createdBy: admin.id,
      uses,
      expiresAt,
      note,
    });
    res.json({ invite });
  });

  r.delete("/:id", (req, res) => {
    db.invites.delete(Number(req.params.id));
    res.json({ ok: true });
  });

  return r;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

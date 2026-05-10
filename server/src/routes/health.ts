import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config";
import type { Db } from "../db/db";

// Two endpoints for orchestrators / reverse proxies / monitoring:
//   /healthz - liveness:  process is alive and answering
//   /readyz  - readiness: DB pings, dataDir is writable, schema is migrated
//
// Neither requires auth. Neither leaks information beyond bool ok + bare
// reasons; details that could help an attacker enumerate config stay out.

export function healthRouter(cfg: Config, db: Db) {
  const r = Router();

  r.get("/healthz", (_req, res) => {
    res.json({ ok: true, app: "texabr" });
  });

  r.get("/readyz", async (_req, res) => {
    const checks: Record<string, boolean> = {};
    let ok = true;

    try {
      db.raw.prepare("SELECT 1").get();
      checks.db = true;
    } catch {
      checks.db = false; ok = false;
    }

    try {
      const probe = path.join(cfg.dataDir, ".readyz-probe");
      await fs.writeFile(probe, String(Date.now()));
      await fs.unlink(probe);
      checks.dataDir = true;
    } catch {
      checks.dataDir = false; ok = false;
    }

    try {
      const v = db.raw.prepare<[], { v: number }>(
        `SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`,
      ).get();
      checks.schema = (v?.v ?? 0) > 0;
      if (!checks.schema) ok = false;
    } catch {
      checks.schema = false; ok = false;
    }

    res.status(ok ? 200 : 503).json({ ok, checks });
  });

  return r;
}

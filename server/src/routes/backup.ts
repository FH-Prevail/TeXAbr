import { Router } from "express";
import type { Request } from "express";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAdmin } from "../middleware/auth";
import { runBackup, listBackupRuns } from "../services/backup";

export function backupRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAdmin(cfg, db));

  r.get("/runs", (_req, res) => {
    res.json({ runs: listBackupRuns(db) });
  });

  r.post("/run", async (req, res) => {
    const me = req.user!;
    db.audit.record({
      event: "admin.backup.trigger",
      actor: { id: me.id, name: me.username },
      ip: clientIp(req),
    });
    const result = await runBackup(cfg, db);
    res.status(result.ok ? 200 : 500).json(result);
  });

  return r;
}

function clientIp(req: Request): string | null {
  return (req.header("x-forwarded-for")?.split(",")[0].trim()) || req.ip || null;
}

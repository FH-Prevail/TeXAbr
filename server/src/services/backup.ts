import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Config } from "../config";
import type { Db } from "../db/db";

// Restic-based backups, gated by backup.enabled. The recipe:
//   1. Take an online SQLite snapshot via the better-sqlite3 backup API
//      (atomic from the engine's POV; doesn't block readers).
//   2. Push dataDir + snapshot into the restic repo (creating the repo if
//      it doesn't yet exist).
//   3. Forget snapshots beyond the retention window and prune.
//   4. Write a row to `backup_runs` so the admin panel has history.
//
// Errors at any stage fail the whole run and are recorded; the run row is
// updated to outcome='failure' with detail JSON.

export interface BackupResult {
  ok: boolean;
  runId: number;
  bytes?: number;
  snapshotId?: string;
  error?: string;
  durationMs: number;
}

export async function runBackup(cfg: Config, db: Db): Promise<BackupResult> {
  const log = db.log.child({ module: "backup" });
  if (!db.registry.getBool("backup.enabled")) {
    return { ok: false, runId: 0, error: "backup.enabled is false", durationMs: 0 };
  }

  const repoPath = db.registry.getString("backup.repoPath");
  const passwordFile = db.registry.getString("backup.passwordFile");
  const retentionDays = db.registry.getInt("backup.retentionDays");

  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  await ensureReadable(passwordFile, "backup.passwordFile");

  const startedAt = Date.now();
  const sInsertRun = db.raw.prepare<[number, "running"]>(
    `INSERT INTO backup_runs (started_at, outcome) VALUES (?, ?)`,
  );
  const sFinishRun = db.raw.prepare<[number, "success" | "failure", number | null, string | null, string | null, number]>(
    `UPDATE backup_runs SET ended_at = ?, outcome = ?, bytes = ?, snapshot_id = ?, detail = ? WHERE id = ?`,
  );

  const info = sInsertRun.run(startedAt, "running");
  const runId = Number(info.lastInsertRowid);

  log.info("backup start", { runId, repoPath });
  db.audit.record({ event: "backup.start", target: `run:${runId}`, detail: { repoPath } });

  try {
    await ensureRepo(repoPath, passwordFile, log);

    const snapshotPath = await snapshotSqlite(cfg, log);
    const snapshotsDir = path.dirname(snapshotPath);

    const result = await resticBackup({
      repoPath,
      passwordFile,
      paths: [cfg.dataDir, snapshotsDir],
      excludes: [
        path.join(cfg.dataDir, "tmp"),
        path.join(cfg.dataDir, "**/.git/objects/pack/*.idx"),  // pack idx is rebuildable
      ],
      log,
    });

    await resticForget({ repoPath, passwordFile, retentionDays, log });
    await fs.rm(snapshotPath, { force: true });

    const durationMs = Date.now() - startedAt;
    sFinishRun.run(Date.now(), "success", null, result.snapshotId ?? null, JSON.stringify({ durationMs }), runId);

    db.audit.record({
      event: "backup.finish", target: `run:${runId}`, outcome: "ok",
      detail: { snapshotId: result.snapshotId, durationMs },
    });
    return { ok: true, runId, snapshotId: result.snapshotId, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error).message;
    sFinishRun.run(Date.now(), "failure", null, null, JSON.stringify({ error: message }), runId);
    db.audit.record({ event: "backup.finish", target: `run:${runId}`, outcome: "error", detail: { error: message } });
    log.error("backup failed", { runId, err });
    return { ok: false, runId, error: message, durationMs };
  }
}

async function ensureReadable(p: string, label: string): Promise<void> {
  try {
    await fs.access(p, fs.constants.R_OK);
  } catch {
    throw new Error(`${label} not readable: ${p}`);
  }
}

async function snapshotSqlite(cfg: Config, log: { info: (m: string, f?: Record<string, unknown>) => void }): Promise<string> {
  const snapshotsDir = path.join(cfg.dataDir, "backups", "sqlite");
  await fs.mkdir(snapshotsDir, { recursive: true });
  // Replaceable single file — restic will dedup, so we don't keep multiple.
  const snapshotPath = path.join(snapshotsDir, "texabr.snapshot.sqlite");
  await fs.rm(snapshotPath, { force: true });

  // Use the connection currently open by the running service. Lazy-import
  // better-sqlite3 here to avoid coupling to the cfg-only context.
  // Instead of opening a fresh handle we route through whatever Db the caller
  // already constructed — done via a small contract: we just need a function
  // that snapshots. We pull it via the require cache.
  const Database = (await import("better-sqlite3")).default;
  const dbPath = path.join(cfg.dataDir, "texabr.sqlite");
  const tmp = new Database(dbPath, { readonly: true });
  try {
    await (tmp as unknown as { backup: (dest: string) => Promise<unknown> }).backup(snapshotPath);
  } finally {
    tmp.close();
  }
  log.info("sqlite snapshot taken", { path: snapshotPath });
  return snapshotPath;
}

interface ResticEnv {
  repoPath: string;
  passwordFile: string;
}

async function ensureRepo(repoPath: string, passwordFile: string, log: { info: (m: string) => void; warn?: (m: string, f?: Record<string, unknown>) => void }): Promise<void> {
  const env = resticEnv({ repoPath, passwordFile });
  // Check if the repo exists. `restic cat config` exits non-zero if not.
  const probe = await runRestic(["cat", "config"], env, /*captureStderr*/ true);
  if (probe.code === 0) return;
  log.info("initialising restic repo");
  const init = await runRestic(["init"], env);
  if (init.code !== 0) {
    throw new Error(`restic init failed: ${init.stderr.trim() || `exit ${init.code}`}`);
  }
}

interface BackupOpts {
  repoPath: string;
  passwordFile: string;
  paths: string[];
  excludes: string[];
  log: { info: (m: string, f?: Record<string, unknown>) => void };
}

async function resticBackup(opts: BackupOpts): Promise<{ snapshotId?: string }> {
  const args = ["backup", "--json", "--quiet"];
  for (const e of opts.excludes) args.push("--exclude", e);
  args.push(...opts.paths);
  const r = await runRestic(args, resticEnv(opts), true);
  if (r.code !== 0) throw new Error(`restic backup failed: ${r.stderr.trim() || `exit ${r.code}`}`);

  // Pull snapshot id out of the last JSON line that has summary type.
  let snapshotId: string | undefined;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.message_type === "summary" && typeof obj.snapshot_id === "string") {
        snapshotId = obj.snapshot_id;
      }
    } catch { /* skip non-JSON lines */ }
  }
  opts.log.info("restic backup ok", { snapshotId });
  return { snapshotId };
}

async function resticForget(args: { repoPath: string; passwordFile: string; retentionDays: number; log: { info: (m: string) => void } }): Promise<void> {
  const r = await runRestic(
    ["forget", `--keep-within=${args.retentionDays}d`, "--prune"],
    resticEnv(args),
    true,
  );
  if (r.code !== 0) throw new Error(`restic forget failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  args.log.info("restic forget+prune ok");
}

function resticEnv(env: ResticEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RESTIC_REPOSITORY: env.repoPath,
    RESTIC_PASSWORD_FILE: env.passwordFile,
  };
}

function runRestic(args: string[], env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("restic", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (capture) stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + (e as Error).message }));
  });
}

export interface BackupRunRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  outcome: "running" | "success" | "failure";
  bytes: number | null;
  snapshot_id: string | null;
  detail: string | null;
}

export function listBackupRuns(db: Db, limit = 50): BackupRunRow[] {
  return db.raw.prepare<[number], BackupRunRow>(
    `SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?`,
  ).all(Math.min(Math.max(limit, 1), 1000));
}

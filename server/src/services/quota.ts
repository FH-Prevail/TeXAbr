import path from "node:path";
import fs from "node:fs/promises";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { pathSizeBytes, mbToBytes } from "./projects";

// Per-user disk quota. dataDir/projects/<ownerId> is the canonical container
// for everything a single user can fill, including their own projects and any
// proposal worktrees we put alongside. Shared projects don't count against
// the reader/editor — only the owner.

export async function userDiskUsageBytes(cfg: Config, ownerId: number): Promise<number> {
  const userRoot = path.join(cfg.dataDir, "projects", String(ownerId));
  try {
    await fs.access(userRoot);
  } catch {
    return 0;
  }
  return pathSizeBytes(userRoot);
}

export async function ensureUserHasRoom(
  cfg: Config,
  db: Db,
  ownerId: number,
  addedBytes: number,
): Promise<void> {
  if (addedBytes <= 0) return;
  const cap = mbToBytes(db.registry.getInt("limits.maxUserDiskMb"));
  const used = await userDiskUsageBytes(cfg, ownerId);
  if (used + addedBytes > cap) {
    const e = new Error(
      `user disk quota exceeded (${db.registry.getInt("limits.maxUserDiskMb")} MB)`,
    );
    (e as Error & { status?: number }).status = 413;
    throw e;
  }
}

// Recursive file count under a directory. Used to enforce
// limits.maxFilesPerProject before creating a new file.
//
// Hidden entries (anything starting with ".") are skipped. The big one is
// .git/ — per-project git history stores one object per file per commit,
// so a 30-file project that's been edited a hundred times can easily have
// 3000+ files under .git/objects and falsely trip the cap. The cap exists
// to bound user-visible content (zip-bomb uploads, runaway backup loops),
// not internal storage. .latexmk caches and similar dot-dirs are excluded
// for the same reason.
export async function countFiles(root: string): Promise<number> {
  let n = 0;
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) n++;
    }
  }
  await walk(root);
  return n;
}

export async function ensureProjectHasFileSlot(
  db: Db,
  projectRoot: string,
  newPath: string,
): Promise<void> {
  // If the path already exists, it's a write to an existing file — no new slot
  // is needed.
  try {
    await fs.access(newPath);
    return;
  } catch { /* new file */ }

  const cap = db.registry.getInt("limits.maxFilesPerProject");
  const current = await countFiles(projectRoot);
  if (current >= cap) {
    const e = new Error(`project file count cap (${cap}) reached`);
    (e as Error & { status?: number }).status = 413;
    throw e;
  }
}

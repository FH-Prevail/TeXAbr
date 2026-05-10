import path from "node:path";
import fs from "node:fs/promises";
import type { Config } from "../config";

// All filesystem access goes through this module. Two responsibilities:
//   1. Map (userId, projectId) -> on-disk directory.
//   2. Refuse any path that escapes the project directory.

export class FsBoundaryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FsBoundaryError";
  }
}

export function projectDir(cfg: Config, ownerId: number, projectId: number): string {
  return path.join(cfg.dataDir, "projects", String(ownerId), String(projectId));
}

export async function ensureProjectDir(cfg: Config, ownerId: number, projectId: number) {
  const dir = projectDir(cfg, ownerId, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Resolve a relative path from a request, refusing anything that breaks out.
export function resolveSafe(root: string, rel: string): string {
  if (rel.includes("\0")) {
    throw new FsBoundaryError("path contains NUL byte");
  }
  const withoutDrive = rel.replace(/^[a-zA-Z]:[\\/]+/, "");
  const norm = path.normalize(withoutDrive.replace(/\\/g, "/")).replace(/^([/\\]+)/, "");
  const full = path.resolve(root, norm);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new FsBoundaryError(`path escapes project: ${rel}`);
  }
  return full;
}

export async function pathSizeBytes(target: string): Promise<number> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  const entries = await fs.readdir(target);
  let total = 0;
  for (const entry of entries) {
    total += await pathSizeBytes(path.join(target, entry));
  }
  return total;
}

export function mbToBytes(mb: number): number {
  return Math.max(0, mb) * 1024 * 1024;
}

export async function listTree(root: string): Promise<TreeNode[]> {
  async function walk(dir: string, rel: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({
          type: "dir",
          name: e.name,
          path: childRel,
          children: await walk(path.join(dir, e.name), childRel),
        });
      } else if (e.isFile()) {
        const stat = await fs.stat(path.join(dir, e.name));
        out.push({ type: "file", name: e.name, path: childRel, size: stat.size });
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }
  return walk(root, "");
}

export type TreeNode =
  | { type: "dir"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string; size: number };

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";
}

export const STARTER_TEX = `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

Hello from TeXAbr. Edit \\texttt{main.tex} and hit compile.

\\end{document}
`;

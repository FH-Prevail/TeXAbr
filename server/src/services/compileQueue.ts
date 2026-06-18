import type { Db } from "../db/db";
import { isShuttingDown } from "./shutdown";

// Fair compile queue. Three caps applied simultaneously:
//   - global active count    <= latex.maxConcurrent
//   - per-user active count  <= latex.maxConcurrentPerUser
//   - per-project active     == 0 or 1   (always serialized)
//
// Why per-project serialization: pdflatex writes aux/log/pdf/synctex into the
// same working tree and the autosave layer commits to the same .git index.
// Two collaborators compiling the same project at the same moment produce
// torn aux/bbl reads, garbage paper_ism.pdf bytes (we hit this with figures)
// and racing "Auto-checkpoint: last good compile" commits sometimes seconds
// apart. Serializing per-project costs nothing in practice (compiles take
// 1-3s, queue depth tiny) and removes the race entirely.

export interface CompileQueue {
  acquire(userId: number, projectId: number): Promise<void>;
  release(userId: number, projectId: number): void;
  status(): { active: number; perUser: Record<number, number>; perProject: Record<number, number>; waiting: number };
}

export function makeCompileQueue(db: Db): CompileQueue {
  let active = 0;
  const perUser = new Map<number, number>();
  const perProject = new Map<number, number>();
  let wakers: Array<() => void> = [];

  function getMax(): number {
    return db.registry.getInt("latex.maxConcurrent");
  }
  function getMaxPerUser(): number {
    return db.registry.getInt("latex.maxConcurrentPerUser");
  }
  function canProceed(userId: number, projectId: number): boolean {
    return active < getMax()
      && (perUser.get(userId) ?? 0) < getMaxPerUser()
      && (perProject.get(projectId) ?? 0) === 0;
  }

  return {
    async acquire(userId, projectId) {
      if (isShuttingDown()) throw new Error("server shutting down; compile rejected");
      while (!canProceed(userId, projectId)) {
        await new Promise<void>((r) => wakers.push(r));
        if (isShuttingDown()) throw new Error("server shutting down; compile rejected");
      }
      active++;
      perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
      perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
    },
    release(userId, projectId) {
      active = Math.max(0, active - 1);
      const left = (perUser.get(userId) ?? 0) - 1;
      if (left <= 0) perUser.delete(userId);
      else perUser.set(userId, left);
      const leftP = (perProject.get(projectId) ?? 0) - 1;
      if (leftP <= 0) perProject.delete(projectId);
      else perProject.set(projectId, leftP);

      const toWake = wakers;
      wakers = [];
      for (const w of toWake) w();
    },
    status() {
      const u: Record<number, number> = {};
      for (const [k, v] of perUser) u[k] = v;
      const p: Record<number, number> = {};
      for (const [k, v] of perProject) p[k] = v;
      return { active, perUser: u, perProject: p, waiting: wakers.length };
    },
  };
}

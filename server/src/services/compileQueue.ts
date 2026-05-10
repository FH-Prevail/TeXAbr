import type { Db } from "../db/db";
import { isShuttingDown } from "./shutdown";

// Fair compile queue. Two caps applied simultaneously:
//   - global active count   <= latex.maxConcurrent
//   - per-user active count <= latex.maxConcurrentPerUser
//
// Both reads through the registry on every check, so the admin can change the
// caps live and the next acquire/release respects the new value.
//
// Broadcast wake-up: every release() resolves all parked waiters; whoever
// can satisfy the predicate first wins, the rest re-park. O(N) per release
// where N is bounded by global cap + queue depth — tiny in practice.

export interface CompileQueue {
  acquire(userId: number): Promise<void>;
  release(userId: number): void;
  status(): { active: number; perUser: Record<number, number>; waiting: number };
}

export function makeCompileQueue(db: Db): CompileQueue {
  let active = 0;
  const perUser = new Map<number, number>();
  let wakers: Array<() => void> = [];

  function getMax(): number {
    return db.registry.getInt("latex.maxConcurrent");
  }
  function getMaxPerUser(): number {
    return db.registry.getInt("latex.maxConcurrentPerUser");
  }
  function canProceed(userId: number): boolean {
    return active < getMax() && (perUser.get(userId) ?? 0) < getMaxPerUser();
  }

  return {
    async acquire(userId) {
      if (isShuttingDown()) throw new Error("server shutting down; compile rejected");
      while (!canProceed(userId)) {
        await new Promise<void>((r) => wakers.push(r));
        if (isShuttingDown()) throw new Error("server shutting down; compile rejected");
      }
      active++;
      perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    },
    release(userId) {
      active = Math.max(0, active - 1);
      const left = (perUser.get(userId) ?? 0) - 1;
      if (left <= 0) perUser.delete(userId);
      else perUser.set(userId, left);

      const toWake = wakers;
      wakers = [];
      for (const w of toWake) w();
    },
    status() {
      const obj: Record<number, number> = {};
      for (const [k, v] of perUser) obj[k] = v;
      return { active, perUser: obj, waiting: wakers.length };
    },
  };
}

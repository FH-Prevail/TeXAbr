import type { Logger } from "./logger";

// Shared shutdown state. Three callers:
//   - index.ts on SIGTERM/SIGINT calls beginShutdown() then drain()
//   - compileQueue.acquire() consults isShuttingDown() and rejects
//   - latex.ts registers each compile child PID via trackProc / untrackProc
//
// Drain semantics: wait up to `graceMs` for the inflight set to empty, then
// SIGKILL whatever's left so systemd's TimeoutStopSec doesn't trigger an
// abort.

let _shuttingDown = false;
const inflight = new Set<number>();

export function isShuttingDown(): boolean {
  return _shuttingDown;
}

export function beginShutdown(): void {
  _shuttingDown = true;
}

export function trackProc(pid: number | undefined): void {
  if (pid) inflight.add(pid);
}

export function untrackProc(pid: number | undefined): void {
  if (pid) inflight.delete(pid);
}

export function activeCount(): number {
  return inflight.size;
}

export async function drain(graceMs: number, log: Logger): Promise<void> {
  const started = Date.now();
  while (inflight.size > 0 && Date.now() - started < graceMs) {
    log.info("draining compiles", { active: inflight.size, elapsedMs: Date.now() - started });
    await new Promise((r) => setTimeout(r, 250));
  }
  if (inflight.size === 0) return;

  log.warn("force-killing stragglers", { pids: [...inflight] });
  for (const pid of inflight) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  inflight.clear();
}

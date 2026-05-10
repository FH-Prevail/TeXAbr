import type Database from "better-sqlite3";
import type { Db } from "../db/db";

// Login throttling: every attempt is recorded in `login_attempts`. When the
// number of failures within the configured window crosses the threshold we
// write a row to `lockouts` keyed (scope, identity). Both the username and
// the IP are tracked separately, so an attacker can't lock a target out by
// guessing usernames — they get the lockout instead.

export type AttemptOutcome = "success" | "bad_password" | "no_user" | "locked" | "disabled";

export interface LockoutCheck {
  locked: boolean;
  scope?: "user" | "ip";
  until?: number;
  reason?: string;
}

export interface LockoutService {
  recordAttempt(input: { username?: string | null; ip?: string | null; outcome: AttemptOutcome }): void;
  check(input: { username?: string | null; ip?: string | null }): LockoutCheck;
  clear(input: { username?: string | null; ip?: string | null }): void;
  status(): { activeLockouts: number };
}

export function makeLockout(db: Db): LockoutService {
  const raw: Database.Database = db.raw;

  const sInsertAttempt = raw.prepare<[number, string | null, string | null, AttemptOutcome]>(
    `INSERT INTO login_attempts (ts, username, ip, outcome) VALUES (?, ?, ?, ?)`,
  );
  const sCountUserFails = raw.prepare<[string, number, number], { c: number }>(
    `SELECT COUNT(*) AS c FROM login_attempts
     WHERE username = ? AND ts > ? AND outcome IN ('bad_password','no_user') AND ts <= ?`,
  );
  const sCountIpFails = raw.prepare<[string, number, number], { c: number }>(
    `SELECT COUNT(*) AS c FROM login_attempts
     WHERE ip = ? AND ts > ? AND outcome IN ('bad_password','no_user') AND ts <= ?`,
  );
  const sUpsertLockout = raw.prepare<["user" | "ip", string, number, string]>(
    `INSERT INTO lockouts (scope, identity, locked_until, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, identity) DO UPDATE
       SET locked_until = MAX(lockouts.locked_until, excluded.locked_until),
           reason = excluded.reason`,
  );
  const sGetLockout = raw.prepare<["user" | "ip", string], { locked_until: number; reason: string | null }>(
    `SELECT locked_until, reason FROM lockouts WHERE scope = ? AND identity = ?`,
  );
  const sDeleteLockout = raw.prepare<["user" | "ip", string]>(
    `DELETE FROM lockouts WHERE scope = ? AND identity = ?`,
  );
  const sCountActive = raw.prepare<[number], { c: number }>(
    `SELECT COUNT(*) AS c FROM lockouts WHERE locked_until > ?`,
  );

  function activeLockoutFor(scope: "user" | "ip", identity: string | null | undefined): { until: number; reason: string | null } | null {
    if (!identity) return null;
    const row = sGetLockout.get(scope, identity);
    if (!row) return null;
    if (row.locked_until <= Date.now()) {
      sDeleteLockout.run(scope, identity);
      return null;
    }
    return { until: row.locked_until, reason: row.reason };
  }

  function trip(scope: "user" | "ip", identity: string, cooldownMs: number, reason: string): void {
    sUpsertLockout.run(scope, identity, Date.now() + cooldownMs, reason);
  }

  return {
    check({ username, ip }) {
      if (!db.registry.getBool("auth.lockout.enabled")) return { locked: false };
      const userLk = activeLockoutFor("user", username);
      if (userLk) return { locked: true, scope: "user", until: userLk.until, reason: userLk.reason ?? "user locked" };
      const ipLk = activeLockoutFor("ip", ip);
      if (ipLk) return { locked: true, scope: "ip", until: ipLk.until, reason: ipLk.reason ?? "ip locked" };
      return { locked: false };
    },

    recordAttempt({ username, ip, outcome }) {
      sInsertAttempt.run(Date.now(), username ?? null, ip ?? null, outcome);

      if (!db.registry.getBool("auth.lockout.enabled")) return;
      if (outcome === "success") {
        // Successful login clears all the counters for this identity pair.
        if (username) sDeleteLockout.run("user", username);
        if (ip) sDeleteLockout.run("ip", ip);
        return;
      }
      if (outcome !== "bad_password" && outcome !== "no_user") return;

      const windowMs = db.registry.getInt("auth.lockout.windowMinutes") * 60_000;
      const max = db.registry.getInt("auth.lockout.maxAttempts");
      const cooldownMs = db.registry.getInt("auth.lockout.cooldownMinutes") * 60_000;
      const now = Date.now();
      const since = now - windowMs;

      if (username) {
        const c = sCountUserFails.get(username, since, now)?.c ?? 0;
        if (c >= max) trip("user", username, cooldownMs, `>= ${max} failures in ${windowMs / 60_000}min`);
      }
      if (ip) {
        const c = sCountIpFails.get(ip, since, now)?.c ?? 0;
        if (c >= max) trip("ip", ip, cooldownMs, `>= ${max} failures in ${windowMs / 60_000}min`);
      }
    },

    clear({ username, ip }) {
      if (username) sDeleteLockout.run("user", username);
      if (ip) sDeleteLockout.run("ip", ip);
    },

    status() {
      const c = sCountActive.get(Date.now())?.c ?? 0;
      return { activeLockouts: c };
    },
  };
}

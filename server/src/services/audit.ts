import type Database from "better-sqlite3";
import type { Logger } from "./logger";

// Append-only audit trail of security-relevant events. Every record is also
// emitted to the structured log so journalctl / log aggregators see it too.
//
// Event names follow `<area>.<action>[.<outcome>]`, e.g.
//   auth.login.success, auth.login.fail, auth.logout, auth.password.change,
//   admin.user.disable, admin.user.delete, admin.invite.create,
//   compile.start, compile.finish, settings.update, settings.reset, ...

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditActor {
  id?: number | null;
  name?: string | null;
}

export interface AuditEvent {
  event: string;
  actor?: AuditActor | null;
  ip?: string | null;
  target?: string | null;
  outcome?: AuditOutcome;
  detail?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor_id: number | null;
  actor_name: string | null;
  ip: string | null;
  event: string;
  target: string | null;
  outcome: AuditOutcome;
  detail: string | null;
}

export interface AuditService {
  record(ev: AuditEvent): void;
  recent(opts?: { limit?: number; offset?: number; event?: string; actorId?: number }): AuditRow[];
}

export function makeAudit(raw: Database.Database, log: Logger): AuditService {
  const sInsert = raw.prepare<
    [number, number | null, string | null, string | null, string, string | null, AuditOutcome, string | null]
  >(
    `INSERT INTO audit_log (ts, actor_id, actor_name, ip, event, target, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    record(ev) {
      const outcome: AuditOutcome = ev.outcome ?? "ok";
      const detail = ev.detail ? JSON.stringify(ev.detail) : null;
      try {
        sInsert.run(
          Date.now(),
          ev.actor?.id ?? null,
          ev.actor?.name ?? null,
          ev.ip ?? null,
          ev.event,
          ev.target ?? null,
          outcome,
          detail,
        );
      } catch (err) {
        // Never let audit-write failures break the calling request. Fall back
        // to logging only and surface the issue so the admin can investigate.
        log.error("audit write failed", { event: ev.event, err });
      }
      log.info("audit", {
        audit: true,
        event: ev.event,
        actor: ev.actor?.name ?? null,
        actor_id: ev.actor?.id ?? null,
        ip: ev.ip ?? null,
        target: ev.target ?? null,
        outcome,
        ...(ev.detail ?? {}),
      });
    },

    recent(opts) {
      const limit = clamp(opts?.limit ?? 100, 1, 1000);
      const offset = Math.max(opts?.offset ?? 0, 0);

      const where: string[] = [];
      const params: (string | number)[] = [];
      if (opts?.event) { where.push("event = ?"); params.push(opts.event); }
      if (opts?.actorId !== undefined) { where.push("actor_id = ?"); params.push(opts.actorId); }
      const sql = `SELECT * FROM audit_log
                   ${where.length ? "WHERE " + where.join(" AND ") : ""}
                   ORDER BY ts DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      return raw.prepare<typeof params, AuditRow>(sql).all(...params);
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

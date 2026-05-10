import type Database from "better-sqlite3";
import type { Db } from "../db/db";

// Soft single-writer lock per (project_id, rel_path). The lock is advisory:
// the server enforces it on writes, but reads remain unrestricted. TTL-based,
// renewed implicitly by every successful write or by an explicit heartbeat.
//
// Why not a real CRDT/OT? Out of scope — this exists so that two editors
// hitting the same file don't silently overwrite each other while there is
// no real-time collab story. The owner of a stuck lock can be force-cleared
// from the admin panel.

export interface LockHolder {
  user_id: number;
  username: string | null;
  acquired_at: number;
  expires_at: number;
}

export interface FileLockService {
  acquire(projectId: number, relPath: string, userId: number): { ok: true } | { ok: false; held: LockHolder };
  renew(projectId: number, relPath: string, userId: number): { ok: true } | { ok: false; held: LockHolder | null };
  release(projectId: number, relPath: string, userId: number): void;
  forceRelease(projectId: number, relPath: string): void;
  holder(projectId: number, relPath: string): LockHolder | null;
  ttlMs(): number;
}

export function makeFileLock(db: Db): FileLockService {
  const raw: Database.Database = db.raw;

  const sGet = raw.prepare<[number, string], { user_id: number; acquired_at: number; expires_at: number; username: string | null }>(
    `SELECT fl.user_id, fl.acquired_at, fl.expires_at, u.username
     FROM file_locks fl LEFT JOIN users u ON u.id = fl.user_id
     WHERE fl.project_id = ? AND fl.rel_path = ?`,
  );
  const sUpsert = raw.prepare<[number, string, number, number, number]>(
    `INSERT INTO file_locks (project_id, rel_path, user_id, acquired_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, rel_path) DO UPDATE
       SET user_id = excluded.user_id,
           acquired_at = CASE WHEN file_locks.user_id = excluded.user_id THEN file_locks.acquired_at ELSE excluded.acquired_at END,
           expires_at = excluded.expires_at`,
  );
  const sDelete = raw.prepare<[number, string]>(`DELETE FROM file_locks WHERE project_id = ? AND rel_path = ?`);
  const sDeleteIfOwner = raw.prepare<[number, string, number]>(
    `DELETE FROM file_locks WHERE project_id = ? AND rel_path = ? AND user_id = ?`,
  );

  function ttl(): number {
    return db.registry.getInt("collab.fileLockTtlSeconds") * 1000;
  }

  function readLive(projectId: number, relPath: string): LockHolder | null {
    const row = sGet.get(projectId, relPath);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      sDelete.run(projectId, relPath);
      return null;
    }
    return row;
  }

  return {
    acquire(projectId, relPath, userId) {
      const live = readLive(projectId, relPath);
      if (live && live.user_id !== userId) return { ok: false, held: live };
      const now = Date.now();
      sUpsert.run(projectId, relPath, userId, now, now + ttl());
      return { ok: true };
    },
    renew(projectId, relPath, userId) {
      const live = readLive(projectId, relPath);
      if (live && live.user_id !== userId) return { ok: false, held: live };
      if (!live) return { ok: false, held: null };
      const now = Date.now();
      sUpsert.run(projectId, relPath, userId, now, now + ttl());
      return { ok: true };
    },
    release(projectId, relPath, userId) {
      sDeleteIfOwner.run(projectId, relPath, userId);
    },
    forceRelease(projectId, relPath) {
      sDelete.run(projectId, relPath);
    },
    holder(projectId, relPath) {
      return readLive(projectId, relPath);
    },
    ttlMs: ttl,
  };
}

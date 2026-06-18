import type { Db } from "../db/db";

// Per-file generation counter ("epoch"). Bumped on any server-authoritative
// mutation the live Yjs CRDT cannot have observed: revert, evict-sessions,
// HTTP file overwrite, manual disk edit + service restart, etc. The realtime
// room key and sidecar hash both include the epoch, so a stale client
// connecting with the OLD epoch is rejected at the WS upgrade — there's no
// merge, no duplication, no "I see your items as new items."
//
// On miss (never-bumped file), epoch defaults to 1. This means existing
// projects don't need a backfill: every file starts at 1, every browser
// tab opens at 1, and only an explicit bump moves them.

export interface FileEpochs {
  get(projectId: number, relPath: string): number;
  bump(projectId: number, relPath: string): number;
  bumpAllInProject(projectId: number): number;
}

export function makeFileEpochs(db: Db): FileEpochs {
  const raw = db.raw;

  const sGet = raw.prepare<[number, string], { epoch: number }>(
    `SELECT epoch FROM file_epoch WHERE project_id = ? AND rel_path = ?`,
  );

  // SQLite UPSERT: create the row at epoch=2 if missing (because the FIRST
  // mutation is by definition a bump from 1), otherwise increment. Returns
  // the new epoch via the same statement.
  const sBump = raw.prepare<[number, string, number, number, number]>(
    `INSERT INTO file_epoch (project_id, rel_path, epoch, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, rel_path) DO UPDATE
       SET epoch = epoch + 1, updated_at = ?`,
  );

  const sBumpAll = raw.prepare<[number, number]>(
    `UPDATE file_epoch SET epoch = epoch + 1, updated_at = ? WHERE project_id = ?`,
  );

  return {
    get(projectId, relPath) {
      const row = sGet.get(projectId, relPath);
      return row?.epoch ?? 1;
    },
    bump(projectId, relPath) {
      const now = Date.now();
      // On first bump for this (project, file), the row didn't exist yet, so
      // we insert at epoch=2 directly (the implicit pre-bump value was 1).
      sBump.run(projectId, relPath, 2, now, now);
      return sGet.get(projectId, relPath)?.epoch ?? 2;
    },
    bumpAllInProject(projectId) {
      const now = Date.now();
      const r = sBumpAll.run(now, projectId);
      return r.changes;
    },
  };
}

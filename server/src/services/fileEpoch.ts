import type { Db } from "../db/db";

// Document generation counter ("epoch"). A project baseline covers files that
// have never needed an individual row; per-file rows override that baseline
// after a targeted mutation. Both the realtime room key and sidecar hash
// include the effective epoch, so stale clients cannot merge pre-reset CRDT
// items into a server-authoritative document generation.
//
// bumpAllInProject() increments the baseline AND all per-file overrides. The
// old implementation only updated existing file_epoch rows, which meant an
// old file at implicit epoch=1 was never reset. That is exactly the shape of
// the "one old file is stuck but a newly uploaded file works" failure.

export interface FileEpochs {
  get(projectId: number, relPath: string): number;
  bump(projectId: number, relPath: string): number;
  bumpAllInProject(projectId: number): number;
}

export function makeFileEpochs(db: Db): FileEpochs {
  const raw = db.raw;

  const sGetFile = raw.prepare<[number, string], { epoch: number }>(
    `SELECT epoch FROM file_epoch WHERE project_id = ? AND rel_path = ?`,
  );
  const sGetProject = raw.prepare<[number], { epoch: number }>(
    `SELECT epoch FROM project_epoch WHERE project_id = ?`,
  );

  const sSetFile = raw.prepare<[number, string, number, number]>(
    `INSERT INTO file_epoch (project_id, rel_path, epoch, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, rel_path) DO UPDATE
       SET epoch = excluded.epoch, updated_at = excluded.updated_at`,
  );

  const sBumpProject = raw.prepare<[number, number, number]>(
    `INSERT INTO project_epoch (project_id, epoch, updated_at)
     SELECT id, 2, ? FROM projects WHERE id = ?
     ON CONFLICT(project_id) DO UPDATE
       SET epoch = project_epoch.epoch + 1, updated_at = ?`,
  );
  const sBumpFileRows = raw.prepare<[number, number]>(
    `UPDATE file_epoch SET epoch = epoch + 1, updated_at = ? WHERE project_id = ?`,
  );

  const effectiveEpoch = (projectId: number, relPath: string): number =>
    sGetFile.get(projectId, relPath)?.epoch
      ?? sGetProject.get(projectId)?.epoch
      ?? 1;

  const bumpFile = raw.transaction((projectId: number, relPath: string): number => {
    const next = effectiveEpoch(projectId, relPath) + 1;
    sSetFile.run(projectId, relPath, next, Date.now());
    return next;
  });

  const bumpProject = raw.transaction((projectId: number): number => {
    const now = Date.now();
    const baselineChanged = sBumpProject.run(now, projectId, now).changes;
    const changed = sBumpFileRows.run(now, projectId).changes;
    // Include the baseline itself. Returning zero used to imply that no
    // generation changed, even though implicit files are the important case.
    return changed + baselineChanged;
  });

  return {
    get(projectId, relPath) {
      return effectiveEpoch(projectId, relPath);
    },
    bump(projectId, relPath) {
      return bumpFile(projectId, relPath);
    },
    bumpAllInProject(projectId) {
      return bumpProject(projectId);
    },
  };
}

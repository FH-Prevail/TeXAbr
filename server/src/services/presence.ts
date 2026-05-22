import type Database from "better-sqlite3";

// Per-project presence: who else is looking at this project right now.
// Editor sends a POST /presence heartbeat every ~30s while the page is
// visible; the server upserts (project, user, last_seen=now). Other
// collaborators GET /presence to render a small "X is online" indicator.
//
// Status buckets:
//   online — heartbeat in the last ONLINE_MS
//   idle   — heartbeat in the last IDLE_MS but not ONLINE_MS
//   offline — older than IDLE_MS (not returned in the list at all)

export type PresenceStatus = "online" | "idle";

export interface PresenceRow {
  user_id: number;
  username: string;
  last_seen: number;
  status: PresenceStatus;
}

const ONLINE_MS = 60_000;          // 1 min
const IDLE_MS   = 5 * 60_000;      // 5 min

export interface PresenceService {
  heartbeat(projectId: number, userId: number): void;
  list(projectId: number, excludeUserId: number): PresenceRow[];
}

export function makePresence(raw: Database.Database): PresenceService {
  const sUpsert = raw.prepare<[number, number, number]>(
    `INSERT INTO project_presence (project_id, user_id, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET last_seen = excluded.last_seen`,
  );
  const sList = raw.prepare<
    [number, number, number],
    { user_id: number; username: string; last_seen: number }
  >(
    `SELECT pp.user_id, u.username, pp.last_seen
     FROM project_presence pp
     JOIN users u ON u.id = pp.user_id
     WHERE pp.project_id = ? AND pp.user_id != ? AND pp.last_seen >= ?
     ORDER BY pp.last_seen DESC`,
  );

  return {
    heartbeat(projectId, userId) {
      sUpsert.run(projectId, userId, Date.now());
    },
    list(projectId, excludeUserId) {
      const now = Date.now();
      const rows = sList.all(projectId, excludeUserId, now - IDLE_MS);
      return rows.map((r) => ({
        ...r,
        status: (now - r.last_seen <= ONLINE_MS ? "online" : "idle") as PresenceStatus,
      }));
    },
  };
}

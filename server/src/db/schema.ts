// Initial schema for fresh installs. Idempotent: uses IF NOT EXISTS everywhere
// so the file can be re-applied on every boot without harm. Schema CHANGES
// to existing installs (ALTER TABLE, data backfills) live in migrations.ts.
export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email              TEXT UNIQUE COLLATE NOCASE,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  disabled           INTEGER NOT NULL DEFAULT 0,
  token_version      INTEGER NOT NULL DEFAULT 1,
  recovery_seed_hash TEXT,
  created_at         INTEGER NOT NULL,
  last_login_at      INTEGER
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  main_file     TEXT NOT NULL DEFAULT 'main.tex',
  engine        TEXT NOT NULL DEFAULT 'pdflatex',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('reader','editor')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  branch_name   TEXT NOT NULL UNIQUE,
  worktree_path TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','closed','conflicted')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  merged_at     INTEGER,
  closed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,
  token_hash    TEXT UNIQUE,
  token_preview TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uses_remaining INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  consumed_count INTEGER NOT NULL DEFAULT 0
);

-- Runtime-mutable key/value store. Drives the typed settings registry; admin
-- writes here override config.json defaults.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Schema-version tracking for the migration runner.
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  name       TEXT NOT NULL
);

-- Append-only audit trail of security-relevant events.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  actor_id   INTEGER,                         -- nullable: anonymous events (failed login, etc.)
  actor_name TEXT,                            -- snapshotted for events where the user is later deleted
  ip         TEXT,
  event      TEXT NOT NULL,                   -- e.g. 'auth.login.success', 'admin.user.disable'
  target     TEXT,                            -- e.g. 'user:42', 'project:7'
  outcome    TEXT NOT NULL DEFAULT 'ok',      -- 'ok' | 'denied' | 'error'
  detail     TEXT                             -- JSON blob; small free-form payload
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts     ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor  ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event  ON audit_log(event);

-- Login-attempt ledger for rate-limit + lockout. Successful logins are also
-- recorded so admins can see "last 10 logins from this account/IP".
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  username    TEXT,                           -- as supplied (may not exist)
  ip          TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('success','bad_password','no_user','locked','disabled'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username, ts);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip       ON login_attempts(ip, ts);

-- Active lockouts. Keyed by username and IP separately so a brute-forcer can't
-- lock a victim out by guessing their username.
CREATE TABLE IF NOT EXISTS lockouts (
  scope       TEXT NOT NULL CHECK (scope IN ('user','ip')),
  identity    TEXT NOT NULL,
  locked_until INTEGER NOT NULL,
  reason      TEXT,
  PRIMARY KEY (scope, identity)
);

-- Soft single-writer lock on (project, file) so two editors don't silently
-- overwrite each other when no real-time collab exists. TTL based; renewed
-- by heartbeat from the active editor.
CREATE TABLE IF NOT EXISTS file_locks (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, rel_path)
);

-- Per-project presence ledger. Each collaborator hits a heartbeat endpoint
-- while they have the editor open; the server upserts (project, user) with
-- the current timestamp. Other collaborators query the list and render a
-- small "who else is here" badge. There is no chat / cursor data — just
-- "last time this user was viewing this project". Pruned by TTL at read time.
CREATE TABLE IF NOT EXISTS project_presence (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON project_presence(last_seen);

CREATE INDEX IF NOT EXISTS idx_file_locks_user ON file_locks(user_id);
CREATE INDEX IF NOT EXISTS idx_file_locks_expiry ON file_locks(expires_at);

-- Backup-run history surfaced in the admin panel.
CREATE TABLE IF NOT EXISTS backup_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  outcome    TEXT NOT NULL CHECK (outcome IN ('running','success','failure')),
  bytes      INTEGER,
  snapshot_id TEXT,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_proposals_project ON project_proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_project_proposals_creator ON project_proposals(created_by);
CREATE INDEX IF NOT EXISTS idx_invites_token  ON invites(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
`;

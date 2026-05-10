import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config";

// Schema-versioned migrations. Each entry is idempotent so that running it
// against a fresh install (where schema.ts already created the latest tables)
// is a no-op, and running it against an older install brings it forward.
//
// Rules:
//   - Never re-number, re-order, or delete an existing migration. Add new ones
//     at the end with the next version.
//   - Migrations that touch the same row twice must check before writing
//     (e.g. addColumnIfMissing, INSERT ... ON CONFLICT IGNORE).
//   - Writes happen inside a single transaction per migration.

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database, cfg: Config) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "invites_token_hash_backfill",
    up: (db, cfg) => {
      addColumnIfMissing(db, "invites", "token_hash", "TEXT");
      addColumnIfMissing(db, "invites", "token_preview", "TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash)");

      const legacyInvites = db.prepare<[], { id: number; token: string; token_hash: string | null }>(
        `SELECT id, token, token_hash FROM invites WHERE token_hash IS NULL`,
      ).all();
      const updateInvite = db.prepare<[string, string, string, number]>(
        `UPDATE invites SET token_hash = ?, token_preview = ?, token = ? WHERE id = ?`,
      );
      for (const row of legacyInvites) {
        const preview = previewToken(row.token);
        updateInvite.run(
          hashInviteToken(cfg, row.token),
          preview,
          `migrated:${row.id}:${preview}`,
          row.id,
        );
      }
    },
  },
  {
    version: 2,
    name: "registration_mode_seed",
    up: (db, cfg) => {
      const sGet = db.prepare<[string], { value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
      );
      const mode = sGet.get("registration.mode")?.value;
      if (isRegistrationMode(mode)) return;

      const open = readBool(sGet, "registration.open", cfg.registration.open);
      const requireInvite = readBool(sGet, "registration.requireInvite", cfg.registration.requireInvite);
      const next = open && !requireInvite ? "open" : requireInvite ? "invite" : "closed";

      db.prepare<[string, string]>(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run("registration.mode", next);
    },
  },
  {
    version: 3,
    name: "users_token_version",
    up: (db) => {
      addColumnIfMissing(db, "users", "token_version", "INTEGER NOT NULL DEFAULT 1");
    },
  },
];

export function migrate(raw: Database.Database, cfg: Config) {
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    name       TEXT NOT NULL
  )`);

  const sCheck = raw.prepare<[number], { version: number }>(
    `SELECT version FROM schema_version WHERE version = ?`,
  );
  const sApply = raw.prepare<[number, number, string]>(
    `INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)`,
  );

  for (const m of MIGRATIONS) {
    if (sCheck.get(m.version)) continue;
    raw.transaction(() => {
      m.up(raw, cfg);
      sApply.run(m.version, Date.now(), m.name);
    })();
  }
}

export function hashInviteToken(cfg: Config, token: string): string {
  return crypto.createHmac("sha256", cfg.auth.jwtSecret).update(token).digest("hex");
}

export function previewToken(token: string): string {
  if (token.length <= 10) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function addColumnIfMissing(raw: Database.Database, table: string, column: string, definition: string) {
  const columns = raw.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function readBool(
  sGet: Database.Statement<[string], { value: string }>,
  key: string,
  fallback: boolean,
): boolean {
  const value = sGet.get(key)?.value;
  if (value === undefined) return fallback;
  return value === "1" || value === "true";
}

function isRegistrationMode(value: unknown): value is "closed" | "invite" | "open" {
  return value === "closed" || value === "invite" || value === "open";
}

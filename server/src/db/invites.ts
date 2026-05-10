import type Database from "better-sqlite3";
import crypto from "node:crypto";
import type { Config } from "../config";
import { hashInviteToken, previewToken } from "./migrations";

export interface InviteRow {
  id: number;
  token: string | null;
  token_hash: string | null;
  token_preview: string | null;
  created_by: number;
  uses_remaining: number;
  expires_at: number | null;
  note: string | null;
  created_at: number;
  consumed_count: number;
}

export interface Invites {
  list(): InviteRow[];
  findByToken(token: string): InviteRow | undefined;
  create(input: {
    token: string;
    createdBy: number;
    uses: number;
    expiresAt: number | null;
    note: string | null;
  }): InviteRow;
  consume(token: string): boolean;
  delete(id: number): void;
}

export function makeInvites(db: Database.Database, cfg: Config): Invites {
  const sList = db.prepare<[], InviteRow>(
    `SELECT id, NULL AS token, NULL AS token_hash, token_preview, created_by, uses_remaining,
            expires_at, note, created_at, consumed_count
       FROM invites
      ORDER BY created_at DESC`,
  );
  const sFind = db.prepare<[string], InviteRow>(`SELECT * FROM invites WHERE token_hash = ?`);
  const sInsert = db.prepare<[string, string, string, number, number, number | null, string | null, number]>(
    `INSERT INTO invites (token, token_hash, token_preview, created_by, uses_remaining, expires_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sById = db.prepare<[number], InviteRow>(`SELECT * FROM invites WHERE id = ?`);
  const sConsume = db.prepare<[string]>(
    `UPDATE invites
     SET uses_remaining = uses_remaining - 1,
         consumed_count = consumed_count + 1
     WHERE token_hash = ? AND uses_remaining > 0
       AND (expires_at IS NULL OR expires_at > strftime('%s','now')*1000)`,
  );
  const sDelete = db.prepare<[number]>(`DELETE FROM invites WHERE id = ?`);

  return {
    list: () => sList.all(),
    findByToken: (t) => sFind.get(hashInviteToken(cfg, t)),
    create({ token, createdBy, uses, expiresAt, note }) {
      const tokenHash = hashInviteToken(cfg, token);
      const publicId = `invite:${crypto.randomBytes(9).toString("base64url")}`;
      const info = sInsert.run(publicId, tokenHash, previewToken(token), createdBy, uses, expiresAt, note, Date.now());
      return { ...sById.get(Number(info.lastInsertRowid))!, token, token_hash: null };
    },
    consume(token) {
      const result = sConsume.run(hashInviteToken(cfg, token));
      return result.changes > 0;
    },
    delete: (id) => void sDelete.run(id),
  };
}

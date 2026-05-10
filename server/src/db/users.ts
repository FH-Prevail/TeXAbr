import type Database from "better-sqlite3";

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  role: "user" | "admin";
  disabled: number;
  token_version: number;
  created_at: number;
  last_login_at: number | null;
}

export interface Users {
  countAdmins(): number;
  findById(id: number): UserRow | undefined;
  findByUsername(username: string): UserRow | undefined;
  list(): UserRow[];
  create(input: {
    username: string;
    email: string | null;
    passwordHash: string;
    role: "user" | "admin";
  }): UserRow;
  setRole(id: number, role: "user" | "admin"): void;
  setDisabled(id: number, disabled: boolean): void;
  setPassword(id: number, passwordHash: string): void;
  bumpTokenVersion(id: number): void;
  touchLogin(id: number): void;
  delete(id: number): void;
}

export function makeUsers(db: Database.Database): Users {
  const sCount = db.prepare<[], { c: number }>(
    `SELECT COUNT(*) AS c FROM users WHERE role='admin' AND disabled=0`,
  );
  const sById = db.prepare<[number], UserRow>(`SELECT * FROM users WHERE id = ?`);
  const sByUser = db.prepare<[string], UserRow>(`SELECT * FROM users WHERE username = ?`);
  const sList = db.prepare<[], UserRow>(`SELECT * FROM users ORDER BY id ASC`);
  const sInsert = db.prepare<
    [string, string | null, string, "user" | "admin", number]
  >(
    `INSERT INTO users (username, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const sSetRole = db.prepare<["user" | "admin", number]>(
    `UPDATE users SET role = ? WHERE id = ?`,
  );
  const sSetDisabled = db.prepare<[number, number]>(
    `UPDATE users SET disabled = ? WHERE id = ?`,
  );
  const sSetPwd = db.prepare<[string, number]>(
    `UPDATE users SET password_hash = ? WHERE id = ?`,
  );
  const sBumpTokenVersion = db.prepare<[number]>(
    `UPDATE users SET token_version = token_version + 1 WHERE id = ?`,
  );
  const sTouch = db.prepare<[number, number]>(
    `UPDATE users SET last_login_at = ? WHERE id = ?`,
  );
  const sDelete = db.prepare<[number]>(`DELETE FROM users WHERE id = ?`);

  return {
    countAdmins: () => sCount.get()?.c ?? 0,
    findById: (id) => sById.get(id),
    findByUsername: (u) => sByUser.get(u),
    list: () => sList.all(),
    create({ username, email, passwordHash, role }) {
      const info = sInsert.run(username, email, passwordHash, role, Date.now());
      return sById.get(Number(info.lastInsertRowid))!;
    },
    setRole: (id, role) => void sSetRole.run(role, id),
    setDisabled: (id, d) => void sSetDisabled.run(d ? 1 : 0, id),
    setPassword: (id, h) => void sSetPwd.run(h, id),
    bumpTokenVersion: (id) => void sBumpTokenVersion.run(id),
    touchLogin: (id) => void sTouch.run(Date.now(), id),
    delete: (id) => void sDelete.run(id),
  };
}

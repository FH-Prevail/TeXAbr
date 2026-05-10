import type Database from "better-sqlite3";

export interface Settings {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  getBool(key: string, fallback: boolean): boolean;
  setBool(key: string, value: boolean): void;
  all(): Map<string, string>;
}

export function makeSettings(db: Database.Database): Settings {
  const sGet = db.prepare<[string], { value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
  );
  const sSet = db.prepare<[string, string]>(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const sDel = db.prepare<[string]>(`DELETE FROM settings WHERE key = ?`);
  const sAll = db.prepare<[], { key: string; value: string }>(
    `SELECT key, value FROM settings`,
  );
  return {
    get: (k) => sGet.get(k)?.value,
    set: (k, v) => void sSet.run(k, v),
    delete: (k) => void sDel.run(k),
    getBool(k, fallback) {
      const v = sGet.get(k)?.value;
      if (v === undefined) return fallback;
      return v === "1" || v === "true";
    },
    setBool(k, v) {
      sSet.run(k, v ? "1" : "0");
    },
    all() {
      const m = new Map<string, string>();
      for (const row of sAll.all()) m.set(row.key, row.value);
      return m;
    },
  };
}

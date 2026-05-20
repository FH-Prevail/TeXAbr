import type { Settings } from "./settings";
import { readConfigPath, type Config } from "../config";

// Typed runtime-settings registry. Three-layer lookup:
//   1. value in `settings` table (admin panel overrides)
//   2. value at the mapped dotted path in /etc/texabr/config.json
//   3. registry default below
//
// Admin writes go to layer 1. "Reset to default" deletes the row, falling back
// to layer 2, then 3. The whole array drives the admin panel UI: groups, types,
// bounds, descriptions, requires-restart flags.

export type SettingType = "bool" | "int" | "string" | "string[]" | "enum";
export type SettingValue = boolean | number | string | string[];

interface BaseDef {
  key: string;
  group: string;
  label: string;
  description: string;
  requiresRestart?: boolean;
  configPath?: string;
  secret?: boolean;
}

export type SettingDef =
  | (BaseDef & { type: "bool";     default: boolean })
  | (BaseDef & { type: "int";      default: number; min?: number; max?: number })
  | (BaseDef & { type: "string";   default: string })
  | (BaseDef & { type: "string[]"; default: string[] })
  | (BaseDef & { type: "enum";     default: string; values: readonly string[] });

const REGISTRY: readonly SettingDef[] = [
  // ---------------- registration ----------------
  { key: "registration.mode", group: "registration", label: "Registration mode",
    description: "Who can create accounts. 'invite' requires a token; 'open' allows anyone; 'closed' rejects all signups.",
    type: "enum", values: ["closed", "invite", "open"], default: "invite" },
  { key: "registration.passwordMinLength", group: "registration", label: "Minimum password length",
    description: "Refuse new passwords shorter than this many characters.",
    type: "int", default: 8, min: 6, max: 128 },

  // ---------------- auth ----------------
  { key: "auth.sessionTtlHours", group: "auth", label: "Session TTL (hours)",
    description: "How long an issued JWT remains valid before the user must log in again.",
    type: "int", default: 168, min: 1, max: 24 * 30, configPath: "auth.sessionTtlHours" },
  { key: "auth.cookieSameSite", group: "auth", label: "Cookie SameSite policy",
    description: "Browser SameSite mode for the session cookie. 'strict' is most secure but blocks cross-site links.",
    type: "enum", values: ["lax", "strict", "none"], default: "lax" },
  { key: "auth.bcryptCost", group: "auth", label: "Bcrypt cost factor",
    description: "Higher = slower hashes = harder to brute-force, but slower login. 12 is the recommended baseline.",
    type: "int", default: 12, min: 10, max: 15 },
  { key: "auth.https.enforced", group: "auth", label: "Force HTTPS",
    description: "When on, redirect HTTP to HTTPS and emit HSTS. Only enable when a working TLS cert is configured.",
    type: "bool", default: false },
  { key: "auth.https.hstsMaxAge", group: "auth", label: "HSTS max-age (seconds)",
    description: "How long browsers should remember to always use HTTPS. Default 1 year.",
    type: "int", default: 31_536_000, min: 0, max: 63_072_000 },

  // ---------------- lockout ----------------
  { key: "auth.lockout.enabled", group: "lockout", label: "Lockout enabled",
    description: "Block login attempts from accounts and IPs that exceed the failure threshold.",
    type: "bool", default: true },
  { key: "auth.lockout.maxAttempts", group: "lockout", label: "Max attempts in window",
    description: "Failed logins per window that trigger a lockout.",
    type: "int", default: 5, min: 1, max: 100 },
  { key: "auth.lockout.windowMinutes", group: "lockout", label: "Window (minutes)",
    description: "Sliding window over which failed attempts are counted.",
    type: "int", default: 15, min: 1, max: 1440 },
  { key: "auth.lockout.cooldownMinutes", group: "lockout", label: "Cooldown (minutes)",
    description: "How long an account or IP stays locked once the threshold trips.",
    type: "int", default: 30, min: 1, max: 1440 },

  // ---------------- latex ----------------
  { key: "latex.engines", group: "latex", label: "Allowed engines",
    description: "Which LaTeX engines users may select per project.",
    type: "string[]", default: ["pdflatex", "xelatex", "lualatex"], configPath: "latex.engines" },
  { key: "latex.defaultEngine", group: "latex", label: "Default engine",
    description: "Engine used when a project does not pin one.",
    type: "enum", values: ["pdflatex", "xelatex", "lualatex"], default: "pdflatex", configPath: "latex.defaultEngine" },
  { key: "latex.timeoutMs", group: "latex", label: "Compile wall-clock timeout (ms)",
    description: "Per-pass wall-clock cutoff. The compile is SIGKILLed when exceeded.",
    type: "int", default: 60_000, min: 1_000, max: 600_000, configPath: "latex.timeoutMs" },
  { key: "latex.maxConcurrent", group: "latex", label: "Max concurrent compiles (server)",
    description: "Server-wide cap on simultaneous compiles.",
    type: "int", default: 4, min: 1, max: 64, configPath: "latex.maxConcurrent" },
  { key: "latex.maxConcurrentPerUser", group: "latex", label: "Max concurrent compiles per user",
    description: "Per-user cap so one user cannot starve everyone else.",
    type: "int", default: 2, min: 1, max: 64 },
  { key: "latex.shellEscape", group: "latex", label: "Shell escape mode",
    description: "'off' = -no-shell-escape (safe). 'restricted' = TeX Live's pre-approved list. Never expose 'unrestricted'.",
    type: "enum", values: ["off", "restricted"], default: "off" },

  // ---------------- sandbox ----------------
  { key: "latex.sandbox.enabled", group: "sandbox", label: "Sandbox enabled",
    description: "Wrap each compile in bubblewrap with no network and a read-only base filesystem.",
    type: "bool", default: true },
  { key: "latex.sandbox.cpuSeconds", group: "sandbox", label: "CPU seconds per compile",
    description: "RLIMIT_CPU. Killed by the kernel after this much CPU time, independent of wall clock.",
    type: "int", default: 60, min: 1, max: 3600 },
  { key: "latex.sandbox.memoryMb", group: "sandbox", label: "Memory cap (MB)",
    description: "RLIMIT_AS / cgroup memory.max. Process killed if it exceeds.",
    type: "int", default: 1024, min: 64, max: 16384 },
  { key: "latex.sandbox.fileSizeMb", group: "sandbox", label: "Single output-file cap (MB)",
    description: "RLIMIT_FSIZE. Stops \\write loops from filling the disk via one giant file.",
    type: "int", default: 200, min: 1, max: 4096 },
  { key: "latex.sandbox.maxProcesses", group: "sandbox", label: "Max processes",
    description: "RLIMIT_NPROC. TeX may spawn fontconfig / dvipdfmx; 64 is generous.",
    type: "int", default: 64, min: 4, max: 4096 },

  // ---------------- limits ----------------
  { key: "limits.maxProjectMb", group: "limits", label: "Max project size (MB)",
    description: "Per-project size cap, checked before write and after compile.",
    type: "int", default: 200, min: 1, max: 100_000, configPath: "limits.maxProjectMb" },
  { key: "limits.maxFileMb", group: "limits", label: "Max file size (MB)",
    description: "Per-file cap on uploads and saves.",
    type: "int", default: 25, min: 1, max: 1024, configPath: "limits.maxFileMb" },
  { key: "limits.maxFilesPerProject", group: "limits", label: "Max files per project",
    description: "Refuse new files once a project exceeds this count. Stops a malicious script from creating millions of tiny files.",
    type: "int", default: 1000, min: 10, max: 100_000 },
  { key: "limits.maxUserDiskMb", group: "limits", label: "Per-user disk quota (MB)",
    description: "Sum of all of a user's projects. Checked before write; the user sees their remaining headroom on the Projects page.",
    type: "int", default: 250, min: 1, max: 1_000_000 },

  // ---------------- backup ----------------
  { key: "backup.enabled", group: "backup", label: "Backups enabled",
    description: "When on, the systemd timer runs 'texabr backup' on the schedule below.",
    type: "bool", default: false },
  { key: "backup.repoPath", group: "backup", label: "Restic repository path",
    description: "Initialised on first run if missing. Use a separate disk or remote URL for real durability.",
    type: "string", default: "/var/lib/texabr/backups/repo" },
  { key: "backup.passwordFile", group: "backup", label: "Restic password file",
    description: "Path to a file containing the repository password. The installer creates it 0600 root:texabr.",
    type: "string", default: "/etc/texabr/backup-password" },
  { key: "backup.scheduleOnCalendar", group: "backup", label: "Schedule (systemd OnCalendar)",
    description: "When the timer fires. Edit then 'systemctl daemon-reload' to apply.",
    type: "string", default: "*-*-* 03:00:00", requiresRestart: true },
  { key: "backup.retentionDays", group: "backup", label: "Retention (days)",
    description: "Snapshots older than this are pruned by 'restic forget --keep-within'.",
    type: "int", default: 30, min: 1, max: 3650 },

  // ---------------- collab ----------------
  { key: "collab.fileLockTtlSeconds", group: "collab", label: "File lock TTL (seconds)",
    description: "How long a soft single-writer lock survives without a heartbeat from the editor.",
    type: "int", default: 120, min: 10, max: 3600 },

  // ---------------- logging ----------------
  { key: "logging.level", group: "logging", label: "Log level",
    description: "Minimum severity that ends up in the journal.",
    type: "enum", values: ["debug", "info", "warn", "error"], default: "info" },
];

const DEFS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(REGISTRY.map((d) => [d.key, d]));

export type SettingSource = "db" | "config" | "default";

export interface SettingState {
  def: SettingDef;
  value: SettingValue;
  source: SettingSource;
}

export interface SettingsRegistry {
  defs(): readonly SettingDef[];
  describe(key: string): SettingDef | undefined;

  getBool(key: string): boolean;
  getInt(key: string): number;
  getString(key: string): string;
  getStringList(key: string): string[];
  getEnum(key: string): string;

  state(key: string): SettingState | undefined;
  list(): SettingState[];

  set(key: string, raw: unknown): SettingState;
  reset(key: string): SettingState | undefined;
}

export function makeSettingsRegistry(settings: Settings, cfg: Config): SettingsRegistry {
  function resolve(def: SettingDef): { value: SettingValue; source: SettingSource } {
    const dbRaw = settings.get(def.key);
    if (dbRaw !== undefined) {
      const parsed = decode(def, dbRaw);
      if (parsed !== undefined) return { value: parsed, source: "db" };
    }
    if (def.configPath) {
      const cfgRaw = readConfigPath(cfg, def.configPath);
      if (cfgRaw !== undefined) {
        const coerced = coerce(def, cfgRaw);
        if (coerced !== undefined) return { value: coerced, source: "config" };
      }
    }
    return { value: def.default as SettingValue, source: "default" };
  }

  function getOrThrow(key: string): SettingDef {
    const d = DEFS_BY_KEY.get(key);
    if (!d) throw new Error(`unknown setting: ${key}`);
    return d;
  }

  return {
    defs: () => REGISTRY,
    describe: (k) => DEFS_BY_KEY.get(k),

    getBool(key) {
      const d = getOrThrow(key);
      if (d.type !== "bool") throw new Error(`setting ${key} is not bool`);
      return resolve(d).value as boolean;
    },
    getInt(key) {
      const d = getOrThrow(key);
      if (d.type !== "int") throw new Error(`setting ${key} is not int`);
      return resolve(d).value as number;
    },
    getString(key) {
      const d = getOrThrow(key);
      if (d.type !== "string") throw new Error(`setting ${key} is not string`);
      return resolve(d).value as string;
    },
    getStringList(key) {
      const d = getOrThrow(key);
      if (d.type !== "string[]") throw new Error(`setting ${key} is not string[]`);
      return resolve(d).value as string[];
    },
    getEnum(key) {
      const d = getOrThrow(key);
      if (d.type !== "enum") throw new Error(`setting ${key} is not enum`);
      return resolve(d).value as string;
    },

    state(key) {
      const d = DEFS_BY_KEY.get(key);
      if (!d) return undefined;
      const r = resolve(d);
      return { def: d, value: r.value, source: r.source };
    },
    list() {
      return REGISTRY.map((def) => {
        const r = resolve(def);
        return { def, value: r.value, source: r.source };
      });
    },

    set(key, raw) {
      const def = getOrThrow(key);
      const value = coerce(def, raw);
      if (value === undefined) {
        throw new Error(`invalid value for ${key}: ${JSON.stringify(raw)}`);
      }
      validate(def, value);
      settings.set(key, encode(def, value));
      return { def, value, source: "db" };
    },

    reset(key) {
      const def = DEFS_BY_KEY.get(key);
      if (!def) return undefined;
      settings.delete(key);
      const r = resolve(def);
      return { def, value: r.value, source: r.source };
    },
  };
}

function encode(def: SettingDef, value: SettingValue): string {
  switch (def.type) {
    case "bool":     return value ? "1" : "0";
    case "int":      return String(value);
    case "string":   return String(value);
    case "enum":     return String(value);
    case "string[]": return JSON.stringify(value);
  }
}

function decode(def: SettingDef, raw: string): SettingValue | undefined {
  switch (def.type) {
    case "bool": return raw === "1" || raw === "true";
    case "int": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "string": return raw;
    case "enum":   return def.values.includes(raw) ? raw : undefined;
    case "string[]": {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : undefined;
      } catch { return undefined; }
    }
  }
}

function coerce(def: SettingDef, raw: unknown): SettingValue | undefined {
  switch (def.type) {
    case "bool":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1" || raw === 1) return true;
      if (raw === "false" || raw === "0" || raw === 0) return false;
      return undefined;
    case "int": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
    }
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "enum":
      return typeof raw === "string" && def.values.includes(raw) ? raw : undefined;
    case "string[]":
      if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return raw as string[];
      return undefined;
  }
}

function validate(def: SettingDef, value: SettingValue) {
  if (def.type === "int") {
    const n = value as number;
    if (def.min !== undefined && n < def.min) throw new Error(`${def.key} below min ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new Error(`${def.key} above max ${def.max}`);
  }
  if (def.type === "enum") {
    if (!def.values.includes(value as string)) {
      throw new Error(`${def.key} must be one of ${def.values.join(", ")}`);
    }
  }
}

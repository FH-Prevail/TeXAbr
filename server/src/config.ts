import fs from "node:fs";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  https: { enabled: boolean; cert: string | null; key: string | null };
  dataDir: string;
  auth: {
    jwtSecret: string;
    sessionTtlHours: number;
    bootstrapToken: string | null;
  };
  registration: { open: boolean; requireInvite: boolean };
  latex: {
    engines: string[];
    defaultEngine: string;
    timeoutMs: number;
    maxConcurrent: number;
  };
  limits: { maxProjectMb: number; maxFileMb: number };

  // Raw parsed JSON, kept around so the runtime-settings registry can resolve
  // dotted paths the typed interface above does not name (e.g. arbitrary
  // auth.lockout.* / latex.sandbox.* keys the operator added in config.json).
  raw: Record<string, unknown>;
  configPath: string;
}

const CANDIDATES = [
  process.env.TEXABR_CONFIG,
  "/etc/texabr/config.json",
  path.resolve(__dirname, "../../config/default.json"),
].filter(Boolean) as string[];

export function loadConfig(): Config {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const cfg = { ...(parsed as object), raw: parsed, configPath: p } as Config;
      validate(cfg);
      return cfg;
    }
  }
  throw new Error(
    `no config found. Looked in: ${CANDIDATES.join(", ")}. ` +
      `Set TEXABR_CONFIG or place config.json at /etc/texabr/config.json.`,
  );
}

// Look up a dotted path in the raw config object, returning `undefined` if any
// segment is missing or a non-object is encountered along the way. Kept here
// (not in the registry) because config.ts already owns the file shape.
export function readConfigPath(cfg: Config, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let cur: unknown = cfg.raw;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function validate(cfg: Config) {
  if (!cfg.auth?.jwtSecret || cfg.auth.jwtSecret === "REPLACE_ME_WITH_A_SECRET") {
    throw new Error("config.auth.jwtSecret must be set to a strong random value");
  }
  if (!cfg.dataDir) throw new Error("config.dataDir is required");
  if (!Number.isInteger(cfg.port)) throw new Error("config.port must be integer");

  if (cfg.https?.enabled) {
    if (!cfg.https.cert || !cfg.https.key) {
      throw new Error("https.enabled is true but cert/key are not set");
    }
    if (!fs.existsSync(cfg.https.cert)) throw new Error(`https.cert not found: ${cfg.https.cert}`);
    if (!fs.existsSync(cfg.https.key)) throw new Error(`https.key not found: ${cfg.https.key}`);
  }
}

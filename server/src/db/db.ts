import path from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config";
import { schema } from "./schema";
import { makeUsers, type Users } from "./users";
import { makeProjects, type Projects } from "./projects";
import { makeInvites, type Invites } from "./invites";
import { makeSettings, type Settings } from "./settings";
import { makeSettingsRegistry, type SettingsRegistry } from "./settingsRegistry";
import { migrate } from "./migrations";
import { makeLogger, type Logger, type LogLevel } from "../services/logger";
import { makeAudit, type AuditService } from "../services/audit";
import { makeFileEpochs, type FileEpochs } from "../services/fileEpoch";

// Db doubles as the request-scoped service container: routers receive (cfg, db)
// and read whatever they need off it. Keeps existing route signatures stable.
export interface Db {
  raw: Database.Database;
  users: Users;
  projects: Projects;
  invites: Invites;
  settings: Settings;
  registry: SettingsRegistry;
  log: Logger;
  audit: AuditService;
  fileEpochs: FileEpochs;
}

export function initDb(cfg: Config): Db {
  const dbPath = path.join(cfg.dataDir, "texabr.sqlite");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(schema);
  migrate(raw, cfg);

  const settings = makeSettings(raw);
  const registry = makeSettingsRegistry(settings, cfg);
  const log = makeLogger(() => registry.getEnum("logging.level") as LogLevel);
  const audit = makeAudit(raw, log);

  const dbObj: Db = {
    raw,
    users: makeUsers(raw),
    projects: makeProjects(raw),
    invites: makeInvites(raw, cfg),
    settings,
    registry,
    log,
    audit,
    fileEpochs: undefined as unknown as FileEpochs,
  };
  dbObj.fileEpochs = makeFileEpochs(dbObj);
  return dbObj;
}

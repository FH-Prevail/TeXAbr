import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import { loadConfig } from "./config";
import { initDb } from "./db/db";
import { authRouter } from "./routes/auth";
import { projectsRouter } from "./routes/projects";
import { filesRouter } from "./routes/files";
import { compileRouter } from "./routes/compile";
import { synctexRouter } from "./routes/synctex";
import { adminRouter } from "./routes/admin";
import { invitesRouter } from "./routes/invites";
import { setupRouter } from "./routes/setup";
import { healthRouter } from "./routes/health";
import { backupRouter } from "./routes/backup";
import { getRegistrationMode, registrationFlags } from "./services/registration";

async function main() {
  const cfg = loadConfig();

  // CLI one-shots: `node dist/index.js --backup-now` runs a single backup
  // (used by the systemd timer) and exits with the run outcome.
  if (process.argv.includes("--backup-now")) {
    fs.mkdirSync(path.join(cfg.dataDir), { recursive: true });
    const db = initDb(cfg);
    const { runBackup } = await import("./services/backup");
    const r = await runBackup(cfg, db);
    db.log.info("one-shot backup result", { ...r });
    process.exit(r.ok ? 0 : 1);
  }

  // Make sure dataDir exists.
  fs.mkdirSync(path.join(cfg.dataDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, "tmp"), { recursive: true });

  const db = initDb(cfg);
  const log = db.log;

  const app = express();

  // The HTTPS-redirect middleware checks the registry on every request, so
  // toggling auth.https.enforced in the admin panel takes effect immediately.
  // forceHttps must run before any cookie/session work so we never leak a
  // Secure cookie to a plain-HTTP request.
  // (forceHttps imported below to avoid circular noise above.)
  const { forceHttps } = await import("./middleware/forceHttps");
  app.use(forceHttps(db));

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  const bodyLimit = `${db.registry.getInt("limits.maxFileMb")}mb`;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

  // CSRF guard runs after cookie-parser. Exempt the bootstrap and unauth
  // endpoints (login/register/setup are unauthenticated; healthz/meta are
  // safe reads). Everything else needs a matching cookie+header pair.
  const { csrfGuard } = await import("./middleware/csrf");
  const csrf = csrfGuard();
  const CSRF_EXEMPT = new Set([
    "/api/healthz", "/api/readyz", "/api/meta",
    "/api/auth/login", "/api/auth/register",
    "/api/setup", "/api/setup/",
  ]);
  app.use((req, res, next) => {
    if (CSRF_EXEMPT.has(req.path)) return next();
    return csrf(req, res, next);
  });

  // Public meta: clients hit this to know what auth modes are open.
  app.get("/api/meta", (_req, res) => {
    const registrationMode = getRegistrationMode(cfg, db);
    res.json({
      app: "texabr",
      version: "1.0.0",
      registration: registrationFlags(registrationMode),
      latex: {
        engines: db.registry.getStringList("latex.engines"),
        defaultEngine: db.registry.getEnum("latex.defaultEngine"),
      },
      bootstrapNeeded: db.users.countAdmins() === 0,
    });
  });

  app.use("/api", healthRouter(cfg, db));
  app.use("/api/setup", setupRouter(cfg, db));
  app.use("/api/auth", authRouter(cfg, db));
  app.use("/api/projects", projectsRouter(cfg, db));
  app.use("/api/files", filesRouter(cfg, db));
  app.use("/api/compile", compileRouter(cfg, db));
  app.use("/api/synctex", synctexRouter(cfg, db));
  app.use("/api/invites", invitesRouter(cfg, db));
  app.use("/api/admin", adminRouter(cfg, db));
  app.use("/api/admin/backup", backupRouter(cfg, db));

  // Serve built client.
  const clientDist = path.resolve(__dirname, "../../client/dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const server = cfg.https.enabled
    ? https.createServer(
        {
          cert: fs.readFileSync(cfg.https.cert!),
          key: fs.readFileSync(cfg.https.key!),
        },
        app,
      )
    : http.createServer(app);

  server.listen(cfg.port, cfg.host, () => {
    const proto = cfg.https.enabled ? "https" : "http";
    log.info("listening", {
      url: `${proto}://${cfg.host}:${cfg.port}`,
      configPath: cfg.configPath,
    });
    if (db.users.countAdmins() === 0 && cfg.auth.bootstrapToken) {
      log.warn("bootstrap pending: visit /setup with the bootstrap token to create the initial admin");
    }
  });

  const { beginShutdown, drain } = await import("./services/shutdown");
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal });
    beginShutdown();

    // Stop accepting new connections; existing ones (including in-flight
    // compiles) keep running until drain() decides their fate.
    server.close((err) => {
      if (err) log.warn("server.close error", { err });
    });

    // 30s grace for compiles. systemd's TimeoutStopSec defaults to 90s, so
    // this leaves headroom; tweak via `--shutdownGraceMs` env if needed.
    const graceMs = Number(process.env.TEXABR_SHUTDOWN_GRACE_MS ?? 30_000);
    await drain(graceMs, log);

    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Logger isn't built yet at very-early failures; fall back to stderr JSON.
  process.stderr.write(JSON.stringify({
    ts: new Date().toISOString(), level: "error", msg: "fatal",
    err: { name: (err as Error)?.name, message: (err as Error)?.message, stack: (err as Error)?.stack },
  }) + "\n");
  process.exit(1);
});

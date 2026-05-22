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

  // Realtime collab WebSocket service. Activated once the HTTP server is
  // created below — we attach to its 'upgrade' event so Express + WS share
  // the same port (8217) and the existing nginx proxy_set_header Upgrade
  // / Connection bits forward it transparently. initRealtime is idempotent
  // and stashes the singleton so latex.ts can flush rooms before a compile.
  const { initRealtime } = await import("./services/realtime");
  const realtime = initRealtime(log, cfg);

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

  // ── Yjs WebSocket upgrade ────────────────────────────────────────────────
  // URL: /api/projects/:id/files-yjs?path=<rel>
  // Auth: texabr.token cookie (JWT) + reader access on the project.
  // Bypasses Express's router so we can hand the raw socket to the WS lib.
  const { WebSocketServer } = await import("ws");
  const jwt = (await import("jsonwebtoken")).default;
  const { getProjectAccess } = await import("./services/access");
  const { ensureProjectDir, resolveSafe, FsBoundaryError } = await import("./services/projects");

  const wss = new (WebSocketServer as unknown as typeof import("ws").WebSocketServer)({ noServer: true });
  // y-websocket's WebsocketProvider builds URLs of the form
  //   <serverUrl>/<roomName>?query
  // so we accept anything after /files-yjs/ as the room (= relative path)
  // and ignore optional query string.
  const YJS_PATH_RE = /^\/api\/projects\/(\d+)\/files-yjs\/([^?]+)/;

  function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const pair of header.split(";")) {
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      out[k] = decodeURIComponent(v);
    }
    return out;
  }

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url || "";
    const m = url.match(YJS_PATH_RE);
    if (!m) {
      socket.destroy();
      return;
    }
    const projectId = Number(m[1]);
    const relPath = decodeURIComponent(m[2]);

    // Origin allow-list. Browsers DON'T enforce same-origin on WebSocket the
    // way they do on XHR/fetch, so a hostile site can otherwise spin up a WS
    // to this server with the user's auth cookie attached (cookie SameSite
    // mitigates but doesn't fully cover this). Explicit Origin check on
    // upgrade is the proper CSRF defense for cookie-authenticated sockets.
    // Allowed origins: any of texabr.org / editor.texabr.org plus localhost
    // for dev. To loosen, set the auth.csrf.allowedOrigins setting (TODO:
    // wire to the registry once we need per-host customisation).
    const allowedOrigins = new Set([
      "https://texabr.org",
      "https://editor.texabr.org",
      "http://localhost:8217",
      "http://127.0.0.1:8217",
    ]);
    const origin = (req.headers.origin || "").toLowerCase();
    if (origin && !allowedOrigins.has(origin)) {
      log.warn("ws upgrade: origin rejected", { origin, url });
      socket.destroy();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies["texabr.token"];
    if (!token) { socket.destroy(); return; }

    let decoded: { sub?: number } | null = null;
    try { decoded = jwt.verify(token, cfg.auth.jwtSecret) as { sub?: number }; }
    catch { socket.destroy(); return; }
    if (!decoded?.sub) { socket.destroy(); return; }

    const user = db.users.findById(decoded.sub);
    if (!user || user.disabled) { socket.destroy(); return; }
    if (user.token_version !== ((decoded as unknown) as { tv?: number }).tv) {
      // Session was revoked since the JWT was issued.
      socket.destroy(); return;
    }

    // Same access check the HTTP routes use, but without writing to a response.
    const project = getProjectAccess(db, user, projectId, "reader");
    if (!project) { socket.destroy(); return; }

    let filePath: string;
    try {
      const root = await ensureProjectDir(cfg, project.owner_id, project.id);
      filePath = resolveSafe(root, relPath);
    } catch (err) {
      if (err instanceof FsBoundaryError) { socket.destroy(); return; }
      log.warn("yjs upgrade: filePath resolve failed", { err, projectId, relPath });
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const scopedLog = log.child({ module: "yjs", user: user.username, projectId, relPath });
      scopedLog.info("yjs: client joined");
      realtime.handleConnection(ws, filePath, { projectId, relPath }, scopedLog);
    });
  });

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

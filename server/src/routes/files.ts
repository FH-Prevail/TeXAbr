import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import type { Config } from "../config";
import type { Db } from "../db/db";
import type { ProjectProposalRow, ProjectWithAccess } from "../db/projects";
import { requireAuth } from "../middleware/auth";
import { canProjectRole, requireProjectAccess } from "../services/access";
import { commitProject } from "../services/git";
import {
  ensureProjectDir,
  listTree,
  resolveSafe,
  FsBoundaryError,
  mbToBytes,
  pathSizeBytes,
} from "../services/projects";
import { ensureUserHasRoom, ensureProjectHasFileSlot } from "../services/quota";
import { makeFileLock, type FileLockService } from "../services/fileLock";
import { getRealtime } from "../services/realtime";

let _fileLock: FileLockService | null = null;
function fileLock(db: Db): FileLockService {
  if (!_fileLock) _fileLock = makeFileLock(db);
  return _fileLock;
}

function lockClaim(db: Db, projectId: number, relPath: string, userId: number) {
  const r = fileLock(db).acquire(projectId, relPath, userId);
  if (!r.ok) {
    const e = new Error(`file is locked by ${r.held.username ?? "another user"}`);
    (e as Error & { status?: number; held?: LockHolderShape }).status = 409;
    (e as Error & { status?: number; held?: LockHolderShape }).held = r.held;
    throw e;
  }
}
type LockHolderShape = { user_id: number; username: string | null; acquired_at: number; expires_at: number };

function evictFileRooms(projectId: number, relPath: string) {
  return getRealtime()?.evictFile(projectId, relPath) ?? { rooms: 0, sidecars: 0 };
}

function evictProjectRooms(projectId: number) {
  return getRealtime()?.evictProject(projectId) ?? { rooms: 0, sidecars: 0 };
}

function finishFileMutation(db: Db, projectId: number, relPath: string) {
  const epoch = db.fileEpochs.bump(projectId, relPath);
  const evicted = evictFileRooms(projectId, relPath);
  db.log.info("realtime: authoritative file mutation", { projectId, relPath, epoch, ...evicted });
}

function finishProjectMutation(db: Db, projectId: number) {
  const epochBumped = db.fileEpochs.bumpAllInProject(projectId);
  const evicted = evictProjectRooms(projectId);
  db.log.info("realtime: authoritative project mutation", { projectId, epochBumped, ...evicted });
}

export function filesRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAuth(cfg, db));

  // Project-scoped paths so we can validate access in one place.
  r.use("/:projectId", (req, res, next) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.projectId), "reader", res);
    if (!p) return;
    res.locals.project = p;
    next();
  });

  // List the file tree.
  r.get("/:projectId/tree", async (req, res) => {
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, false);
    if (!target) return;
    res.json({ tree: await listTree(target.root) });
  });

  // Read file content (text only — binaries should use /raw).
  r.get("/:projectId/content", async (req, res) => {
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, false);
    if (!target) return;
    const root = target.root;
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path required" });
    try {
      const full = resolveSafe(root, rel);
      const content = await fs.readFile(full, "utf8");
      res.json({ path: rel, content });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      return res.status(404).json({ error: "not found" });
    }
  });

  // Stream binary file (e.g. .pdf, images).
  r.get("/:projectId/raw", async (req, res) => {
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, false);
    if (!target) return;
    const root = target.root;
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path required" });
    try {
      const full = resolveSafe(root, rel);
      res.sendFile(full);
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      return res.status(404).json({ error: "not found" });
    }
  });

  // Write text file.
  r.put("/:projectId/content", async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== "string" || typeof content !== "string") {
      return res.status(400).json({ error: "path and content required" });
    }
    let resetRealtime = false;
    try {
      const full = resolveSafe(root, rel);
      const bytes = Buffer.byteLength(content, "utf8");
      lockClaim(db, p.id, rel, u.id);
      await enforceWriteLimits(cfg, db, p.owner_id, root, full, bytes);
      if (!target.proposal) {
        // Retire the live room before the async filesystem/git work. A second
        // eviction in finally catches clients that reconnect during the write.
        evictFileRooms(p.id, rel);
        resetRealtime = true;
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Edit ${rel}`, u);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    } finally {
      if (resetRealtime) finishFileMutation(db, p.id, rel);
    }
  });

  // Delete file or directory.
  r.delete("/:projectId/entry", async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path required" });
    let resetRealtime = false;
    try {
      const full = resolveSafe(root, rel);
      if (!target.proposal) {
        // rel may be a directory, so retire the whole project rather than
        // leaving rooms for deleted descendants alive.
        evictProjectRooms(p.id);
        resetRealtime = true;
      }
      await fs.rm(full, { recursive: true, force: true });
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Delete ${rel}`, u);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    } finally {
      if (resetRealtime) finishProjectMutation(db, p.id);
    }
  });

  // Create an empty directory (files are auto-created on write).
  r.post("/:projectId/mkdir", async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const rel = String(req.body?.path ?? "");
    if (!rel) return res.status(400).json({ error: "path required" });
    try {
      const full = resolveSafe(root, rel);
      await fs.mkdir(full, { recursive: true });
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Create directory ${rel}`, u);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    }
  });

  // Rename / move a file or directory inside the project.
  r.post("/:projectId/rename", async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const { from, to } = req.body ?? {};
    if (typeof from !== "string" || typeof to !== "string") {
      return res.status(400).json({ error: "from and to required" });
    }
    let resetRealtime = false;
    try {
      const src = resolveSafe(root, from);
      const dst = resolveSafe(root, to);
      if (!target.proposal) {
        // from/to may be directories. A project reset guarantees every
        // descendant room is retired and re-resolved at its new path.
        evictProjectRooms(p.id);
        resetRealtime = true;
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Rename ${from} to ${to}`, u);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    } finally {
      if (resetRealtime) finishProjectMutation(db, p.id);
    }
  });

  // Copy one or more files/dirs to a destination directory.
  r.post("/:projectId/copy", async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const { sources, destination } = req.body ?? {};
    if (!Array.isArray(sources) || typeof destination !== "string") {
      return res.status(400).json({ error: "sources[] and destination required" });
    }
    let resetRealtime = false;
    try {
      const dstDir = resolveSafe(root, destination);
      let addedBytes = 0;
      for (const s of sources) {
        if (typeof s !== "string") continue;
        addedBytes += await pathSizeBytes(resolveSafe(root, s));
      }
      await enforceProjectRoom(cfg, db, root, addedBytes);
      await ensureUserHasRoom(cfg, db, p.owner_id, addedBytes);
      if (!target.proposal) {
        evictProjectRooms(p.id);
        resetRealtime = true;
      }
      await fs.mkdir(dstDir, { recursive: true });
      for (const s of sources) {
        if (typeof s !== "string") continue;
        const src = resolveSafe(root, s);
        const target = path.join(dstDir, path.basename(src));
        await fs.cp(src, target, { recursive: true, force: false, errorOnExist: true });
      }
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Copy files to ${destination}`, u);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    } finally {
      if (resetRealtime) finishProjectMutation(db, p.id);
    }
  });

  // Upload (binary) — images, bibs, etc.
  // Multer's hard limit is fixed at construction; the registry value is
  // sampled at module load. This is acceptable: changing maxFileMb at runtime
  // takes effect on next service restart, which is signposted in the panel.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: db.registry.getInt("limits.maxFileMb") * 1024 * 1024 },
  });
  const uploadOne = upload.single("file");
  r.post("/:projectId/upload", (req, res, next) => {
    uploadOne(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        const cap = db.registry.getInt("limits.maxFileMb");
        return res.status(413).json({ error: `file exceeds maxFileMb (${cap} MB)` });
      }
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const target = await resolveRequestRoot(cfg, db, req, res, p, true);
    if (!target) return;
    const root = target.root;
    const rel = String(req.body.path ?? req.file?.originalname ?? "");
    if (!rel || !req.file) return res.status(400).json({ error: "file and path required" });
    let resetRealtime = false;
    try {
      const full = resolveSafe(root, rel);
      lockClaim(db, p.id, rel, u.id);
      await enforceWriteLimits(cfg, db, p.owner_id, root, full, req.file.size);
      if (!target.proposal) {
        evictFileRooms(p.id, rel);
        resetRealtime = true;
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, req.file.buffer);
      db.projects.touch(p.id);
      if (target.proposal) db.projects.touchProposal(p.id, target.proposal.id);
      await commitProject(root, `Upload ${rel}`, u);
      res.json({ ok: true, path: rel });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      const tagged = err as Error & { status?: number; held?: LockHolderShape };
      if (tagged.status) {
        return res.status(tagged.status).json({ error: tagged.message, ...(tagged.held ? { held: tagged.held } : {}) });
      }
      throw err;
    } finally {
      if (resetRealtime) finishFileMutation(db, p.id, rel);
    }
  });

  // Lock endpoints. The editor calls these on focus/blur and on a periodic
  // heartbeat to prevent a stale lock from blocking the next writer.
  r.post("/:projectId/lock", (req, res) => {
    const u = req.user!;
    const p = res.locals.project as ProjectWithAccess;
    const { path: rel, action } = req.body ?? {};
    if (typeof rel !== "string") return res.status(400).json({ error: "path required" });

    const lock = fileLock(db);
    if (action === "acquire" || action === "renew") {
      const r1 = action === "acquire"
        ? lock.acquire(p.id, rel, u.id)
        : lock.renew(p.id, rel, u.id);
      if (!r1.ok) {
        return res.status(409).json({ error: "file is locked", held: r1.held });
      }
      return res.json({ ok: true, ttlMs: lock.ttlMs() });
    }
    if (action === "release") {
      lock.release(p.id, rel, u.id);
      return res.json({ ok: true });
    }
    if (action === "status") {
      return res.json({ holder: lock.holder(p.id, rel) });
    }
    res.status(400).json({ error: "action must be acquire/renew/release/status" });
  });

  return r;
}

async function resolveRequestRoot(
  cfg: Config,
  db: Db,
  req: Request,
  res: Response,
  project: ProjectWithAccess,
  write: boolean,
): Promise<{ root: string; proposal: ProjectProposalRow | null } | null> {
  const proposalId = requestedProposalId(req);
  if (proposalId == null) {
    if (write && !canProjectRole(project.access_role, "editor")) {
      res.status(403).json({ error: "editor access required" });
      return null;
    }
    return { root: await ensureProjectDir(cfg, project.owner_id, project.id), proposal: null };
  }

  const proposal = db.projects.findProposal(project.id, proposalId);
  if (!proposal) {
    res.status(404).json({ error: "proposal not found" });
    return null;
  }
  if (proposal.status !== "open" && proposal.status !== "conflicted") {
    res.status(410).json({ error: `proposal is ${proposal.status}` });
    return null;
  }
  if (write) {
    if (!canProjectRole(project.access_role, "editor")) {
      res.status(403).json({ error: "editor access required" });
      return null;
    }
    if (proposal.status !== "open" && proposal.status !== "conflicted") {
      res.status(409).json({ error: `proposal is ${proposal.status}` });
      return null;
    }
    if (proposal.created_by !== req.user!.id && project.access_role !== "owner") {
      res.status(403).json({ error: "proposal creator or owner access required" });
      return null;
    }
  }
  return { root: proposal.worktree_path, proposal };
}

function requestedProposalId(req: Request): number | null {
  const raw = req.method === "GET" ? req.query.proposalId : req.body?.proposalId;
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function enforceWriteLimits(
  cfg: Config,
  db: Db,
  ownerId: number,
  root: string,
  target: string,
  nextSize: number,
) {
  const maxFileMb = db.registry.getInt("limits.maxFileMb");
  const maxFile = mbToBytes(maxFileMb);
  if (nextSize > maxFile) {
    const err = new Error(`file exceeds maxFileMb (${maxFileMb} MB)`);
    (err as Error & { status?: number }).status = 413;
    throw err;
  }

  const existingSize = await pathSizeBytes(target);
  const delta = nextSize - existingSize;

  await enforceProjectRoom(cfg, db, root, delta);
  await ensureUserHasRoom(cfg, db, ownerId, delta);
  await ensureProjectHasFileSlot(db, root, target);
}

async function enforceProjectRoom(cfg: Config, db: Db, root: string, addedBytes: number) {
  if (addedBytes <= 0) return;
  const maxProjectMb = db.registry.getInt("limits.maxProjectMb");
  const maxProject = mbToBytes(maxProjectMb);
  const currentSize = await pathSizeBytes(root);
  if (currentSize + addedBytes > maxProject) {
    const err = new Error(`project exceeds maxProjectMb (${maxProjectMb} MB)`);
    (err as Error & { status?: number }).status = 413;
    throw err;
  }
}

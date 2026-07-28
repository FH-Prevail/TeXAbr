import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAuth } from "../middleware/auth";
import { requireProjectAccess } from "../services/access";
import {
  commitProject,
  createProposalWorktree,
  deleteBranch,
  diffProposal,
  diffProposalPatch,
  ensureGitRepo,
  getLastGoodCompile,
  lastGoodCompileTagName,
  listFilesAtCommit,
  listHistory,
  mergeProposal,
  readFileAtCommit,
  removeProposalWorktree,
  revertToCommit,
} from "../services/git";
import { getRealtime } from "../services/realtime";
import { ensureProjectDir, projectDir, resolveSafe, slugify, STARTER_TEX, FsBoundaryError } from "../services/projects";
import { makePresence } from "../services/presence";
import { publishProjectEvent, subscribeToProjectEvents } from "../services/projectEvents";

function evictProjectRooms(projectId: number) {
  return getRealtime()?.evictProject(projectId) ?? { rooms: 0, sidecars: 0 };
}

function finishProjectReset(db: Db, projectId: number) {
  const epochBumped = db.fileEpochs.bumpAllInProject(projectId);
  const evicted = evictProjectRooms(projectId);
  return { epochBumped, evicted };
}

export function projectsRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAuth(cfg, db));
  const presence = makePresence(db.raw);

  r.get("/", (req, res) => {
    const u = req.user!;
    res.json({ projects: db.projects.listForUser(u.id) });
  });

  r.post("/", async (req, res) => {
    const u = req.user!;
    const { name, engine } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    const e = typeof engine === "string" && cfg.latex.engines.includes(engine)
      ? engine
      : cfg.latex.defaultEngine;

    let slug = slugify(name);
    let i = 1;
    while (db.projects.findByOwnerSlug(u.id, slug)) {
      slug = `${slugify(name)}-${++i}`;
    }

    const project = db.projects.create({ ownerId: u.id, slug, name: name.trim(), engine: e });
    const dir = await ensureProjectDir(cfg, u.id, project.id);
    await fs.writeFile(path.join(dir, "main.tex"), STARTER_TEX, "utf8");
    await ensureGitRepo(dir);
    await commitProject(dir, "Create project", u);

    res.json({ project: db.projects.accessForUser(project.id, u.id) ?? project });
  });

  r.get("/:id", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    res.json({ project: p });
  });

  r.get("/:id/events", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    subscribeToProjectEvents(req, res, p.id);
  });

  r.patch("/:id", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "editor", res);
    if (!p) return;

    const { name, mainFile, engine } = req.body ?? {};
    if (typeof name === "string" && name.trim()) {
      if (p.access_role !== "owner") return res.status(403).json({ error: "owner access required" });
      db.projects.rename(p.id, name.trim());
    }
    if (typeof mainFile === "string" && mainFile.trim()) {
      try {
        resolveSafe(projectDir(cfg, p.owner_id, p.id), mainFile.trim());
      } catch (err) {
        if (err instanceof FsBoundaryError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
      db.projects.setMainFile(p.id, mainFile.trim());
    }
    if (typeof engine === "string" && cfg.latex.engines.includes(engine)) {
      db.projects.setEngine(p.id, engine);
    }
    res.json({ project: db.projects.accessForUser(p.id, u.id) ?? db.projects.findById(p.id) });
  });

  r.delete("/:id", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    evictProjectRooms(p.id);
    db.projects.delete(p.id);
    await fs.rm(projectDir(cfg, p.owner_id, p.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  r.get("/:id/shares", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    res.json({ members: db.projects.listMembers(p.id) });
  });

  r.post("/:id/shares", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;

    const { username, role } = req.body ?? {};
    if (typeof username !== "string" || !username.trim()) {
      return res.status(400).json({ error: "username required" });
    }
    if (role !== "reader" && role !== "editor") {
      return res.status(400).json({ error: "role must be reader or editor" });
    }

    const target = db.users.findByUsername(username.trim());
    if (!target || target.disabled) return res.status(404).json({ error: "user not found" });
    if (target.id === p.owner_id) return res.status(400).json({ error: "owner already has full access" });

    db.projects.grantAccess(p.id, target.id, role);
    res.json({ members: db.projects.listMembers(p.id) });
  });

  r.delete("/:id/shares/:userId", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    const targetId = Number(req.params.userId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: "invalid user id" });
    }
    db.projects.revokeAccess(p.id, targetId);
    res.json({ members: db.projects.listMembers(p.id) });
  });

  // Per-file epoch lookup. Clients call this once before opening a Yjs WS
  // so they can tag the upgrade URL with ?epoch=N. Reader access is enough
  // (epoch is just a generation counter, not a secret).
  r.get("/:id/file-epoch", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) return res.status(400).json({ error: "path required" });
    res.set("Cache-Control", "no-store");
    try {
      const root = await ensureProjectDir(cfg, p.owner_id, p.id);
      const stat = await fs.stat(resolveSafe(root, rel));
      if (!stat.isFile()) return res.status(404).json({ error: "file not found" });
    } catch (err) {
      if (err instanceof FsBoundaryError) return res.status(400).json({ error: err.message });
      return res.status(404).json({ error: "file not found" });
    }
    res.json({ epoch: db.fileEpochs.get(p.id, rel) });
  });

  r.get("/:id/history", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    res.json({ history: await listHistory(root) });
  });

  // Browse a past commit (read-only). Reader access is enough — viewing
  // history doesn't change anything, and the same content was visible
  // when that commit was HEAD.
  r.get("/:id/history/:hash/files", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    try {
      const files = await listFilesAtCommit(root, req.params.hash);
      res.json({ files });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get("/:id/history/:hash/file", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) return res.status(400).json({ error: "path required" });
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    try {
      const content = await readFileAtCommit(root, req.params.hash, rel);
      res.json({ content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // "Last good compile" snapshot: tag refreshed by services/latex.ts on every
  // successful compile. Editor+ can read and revert to it. Lower-friction
  // than the owner-only history revert above: a bad save is a normal
  // editing accident, and recovering shouldn't require pinging the owner.
  r.get("/:id/last-good-compile", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    const info = await getLastGoodCompile(root);
    res.json({ lastGood: info });
  });

  r.post("/:id/last-good-compile/revert", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "editor", res);
    if (!p) return;
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    const info = await getLastGoodCompile(root);
    if (!info) {
      return res.status(404).json({ error: "no good compile recorded yet" });
    }
    if (info.isCurrentHead) {
      return res.status(409).json({ error: "already at last good compile" });
    }
    // Retire rooms before the async git reset so none can flush stale text
    // during it. finishProjectReset() bumps the generation and evicts again
    // to catch any client that reconnects while git is running.
    const preEvicted = evictProjectRooms(p.id);
    try {
      const result = await revertToCommit(root, info.hash, u);
      const reset = finishProjectReset(db, p.id);
      db.log.info("revert to last good compile", {
        projectId: p.id, actor: u.username, target: result.newHead,
        safetyTag: result.safetyTag, lastGoodTag: lastGoodCompileTagName(),
        preEvicted, ...reset,
      });
      publishProjectEvent(p.id, { type: "resync" });
      res.json({ ok: true, ...result, preEvicted, ...reset, target: info });
    } catch (err) {
      finishProjectReset(db, p.id);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Owner-only: force every live editing session for the project to reload.
  // Closes all WS clients with code 4000, AND bumps every file's epoch so
  // the surviving stale clients cannot reconnect into the same room — they
  // refetch the new epoch and start fresh.
  r.post("/:id/evict-sessions", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    const { epochBumped, evicted } = finishProjectReset(db, p.id);
    db.log.info("force-evict-sessions", { projectId: p.id, actor: u.username, ...evicted, epochBumped });
    res.json({ ok: true, evicted, epochBumped });
  });

  // Owner-only: rewind the working tree to a past commit.
  r.post("/:id/history/:hash/revert", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    const root = await ensureProjectDir(cfg, p.owner_id, p.id);
    const preEvicted = evictProjectRooms(p.id);
    try {
      const result = await revertToCommit(root, req.params.hash, u);
      const reset = finishProjectReset(db, p.id);
      db.log.info("project reverted", {
        projectId: p.id, actor: u.username, target: result.newHead,
        safetyTag: result.safetyTag, preEvicted, ...reset,
      });
      publishProjectEvent(p.id, { type: "resync" });
      res.json({ ok: true, ...result, preEvicted, ...reset });
    } catch (err) {
      finishProjectReset(db, p.id);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Presence: who else is looking at this project right now.
  // Heartbeat: editor pings ~30s while visible. List: editor polls similarly.
  r.post("/:id/presence", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    presence.heartbeat(p.id, u.id);
    res.json({ ok: true });
  });
  r.get("/:id/presence", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    // Mark the caller present too so /presence doubles as a heartbeat for
    // simple clients that only poll the GET and never POST.
    presence.heartbeat(p.id, u.id);
    res.json({ users: presence.list(p.id, u.id) });
  });

  // Per-(user, project) opaque JSON blob: which tabs were open, which one was
  // active, etc. Client owns the schema; server caps the payload size to keep
  // misuse cheap. Reader access only — your state isn't accessible to other
  // collaborators on the same project.
  const sGetState = db.raw.prepare<[number, number], { state: string }>(
    `SELECT state FROM user_project_state WHERE user_id = ? AND project_id = ?`,
  );
  const sPutState = db.raw.prepare<[number, number, string, number]>(
    `INSERT INTO user_project_state (user_id, project_id, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, project_id) DO UPDATE
       SET state = excluded.state, updated_at = excluded.updated_at`,
  );

  r.get("/:id/state", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const row = sGetState.get(u.id, p.id);
    let parsed: unknown = null;
    if (row?.state) {
      try { parsed = JSON.parse(row.state); } catch { parsed = null; }
    }
    res.json({ state: parsed });
  });

  r.put("/:id/state", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const state = req.body?.state;
    if (state == null || typeof state !== "object") {
      return res.status(400).json({ error: "state object required" });
    }
    const serialised = JSON.stringify(state);
    // 64 KB ceiling; tab lists for sane projects are well under 1 KB.
    if (serialised.length > 65_536) {
      return res.status(413).json({ error: "state too large (>64KB)" });
    }
    sPutState.run(u.id, p.id, serialised, Date.now());
    res.json({ ok: true });
  });

  r.get("/:id/proposals", (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    res.json({ proposals: db.projects.listProposals(p.id) });
  });

  r.post("/:id/proposals", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "editor", res);
    if (!p) return;

    const { title, description } = req.body ?? {};
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title required" });
    }

    const token = crypto.randomBytes(6).toString("hex");
    const branchName = `proposal/${p.id}/${u.id}/${slugify(title)}-${token}`;
    const worktreePath = path.join(cfg.dataDir, "worktrees", String(p.id), `${u.id}-${token}`);
    const projectRoot = await ensureProjectDir(cfg, p.owner_id, p.id);

    try {
      await createProposalWorktree(projectRoot, worktreePath, branchName);
      const proposal = db.projects.createProposal({
        projectId: p.id,
        createdBy: u.id,
        title: title.trim(),
        description: typeof description === "string" && description.trim() ? description.trim() : null,
        branchName,
        worktreePath,
      });
      res.json({ proposal });
    } catch (err) {
      await removeProposalWorktree(projectRoot, worktreePath).catch(() => {});
      await deleteBranch(projectRoot, branchName).catch(() => {});
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.get("/:id/proposals/:proposalId/diff", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const proposal = db.projects.findProposal(p.id, Number(req.params.proposalId));
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(410).json({ error: `proposal is ${proposal.status}` });
    }
    const projectRoot = await ensureProjectDir(cfg, p.owner_id, p.id);
    res.json({ files: await diffProposal(projectRoot, proposal.branch_name) });
  });

  r.get("/:id/proposals/:proposalId/patch", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const proposal = db.projects.findProposal(p.id, Number(req.params.proposalId));
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(410).json({ error: `proposal is ${proposal.status}` });
    }
    const projectRoot = await ensureProjectDir(cfg, p.owner_id, p.id);
    res.type("text/plain").send(await diffProposalPatch(projectRoot, proposal.branch_name));
  });

  r.post("/:id/proposals/:proposalId/merge", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "owner", res);
    if (!p) return;
    const proposal = db.projects.findProposal(p.id, Number(req.params.proposalId));
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal.status !== "open") return res.status(409).json({ error: `proposal is ${proposal.status}` });

    const projectRoot = await ensureProjectDir(cfg, p.owner_id, p.id);
    // The merge preserves current main-branch work, so materialise any
    // debounced Yjs edits before git snapshots the working tree.
    await getRealtime()?.flushAll();
    const preEvicted = evictProjectRooms(p.id);
    let result: Awaited<ReturnType<typeof mergeProposal>>;
    try {
      result = await mergeProposal(projectRoot, proposal.branch_name, u, proposal.title);
    } finally {
      const reset = finishProjectReset(db, p.id);
      db.log.info("proposal merge: realtime reset", { projectId: p.id, preEvicted, ...reset });
    }
    if (!result.ok) {
      db.projects.setProposalStatus(p.id, proposal.id, "conflicted");
      return res.status(409).json({ error: "merge conflict", details: result.conflict });
    }

    db.projects.setProposalStatus(p.id, proposal.id, "merged");
    db.projects.touch(p.id);
    publishProjectEvent(p.id, { type: "resync" });
    await removeProposalWorktree(projectRoot, proposal.worktree_path).catch(() => {});
    await deleteBranch(projectRoot, proposal.branch_name).catch(() => {});
    res.json({ proposal: db.projects.findProposal(p.id, proposal.id) });
  });

  r.post("/:id/proposals/:proposalId/close", async (req, res) => {
    const u = req.user!;
    const p = requireProjectAccess(db, u, Number(req.params.id), "reader", res);
    if (!p) return;
    const proposal = db.projects.findProposal(p.id, Number(req.params.proposalId));
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal.created_by !== u.id && p.access_role !== "owner") {
      return res.status(403).json({ error: "creator or owner access required" });
    }
    if (proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(409).json({ error: `proposal is ${proposal.status}` });
    }

    const projectRoot = await ensureProjectDir(cfg, p.owner_id, p.id);
    db.projects.setProposalStatus(p.id, proposal.id, "closed");
    await removeProposalWorktree(projectRoot, proposal.worktree_path).catch(() => {});
    await deleteBranch(projectRoot, proposal.branch_name).catch(() => {});
    res.json({ proposal: db.projects.findProposal(p.id, proposal.id) });
  });

  return r;
}

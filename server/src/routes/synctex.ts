import { Router } from "express";
import type { Config } from "../config";
import type { Db } from "../db/db";
import type { ProjectWithAccess } from "../db/projects";
import { requireAuth } from "../middleware/auth";
import { requireProjectAccess } from "../services/access";
import { ensureProjectDir } from "../services/projects";
import { forwardSearch, inverseSearch } from "../services/synctex";

export function synctexRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAuth(cfg, db));

  r.use("/:projectId", (req, res, next) => {
    const u = req.user!;
    const project = requireProjectAccess(db, u, Number(req.params.projectId), "reader", res);
    if (!project) return;
    res.locals.project = project;
    next();
  });

  r.post("/:projectId/forward", async (req, res) => {
    const { file, line, column, pdf } = req.body ?? {};
    if (typeof file !== "string" || typeof line !== "number") {
      return res.status(400).json({ error: "file and line required" });
    }

    const project = res.locals.project as ProjectWithAccess;
    const proposalId = Number(req.body?.proposalId ?? 0);
    const proposal = Number.isInteger(proposalId) && proposalId > 0
      ? db.projects.findProposal(project.id, proposalId)
      : undefined;
    if (proposalId > 0 && !proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal && proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(410).json({ error: `proposal is ${proposal.status}` });
    }
    const root = proposal ? proposal.worktree_path : await ensureProjectDir(cfg, project.owner_id, project.id);
    const result = await forwardSearch(
      cfg,
      root,
      file,
      line,
      typeof column === "number" ? column : 1,
      typeof pdf === "string" ? pdf : undefined,
    );
    res.status(result.success ? 200 : 404).json(result);
  });

  r.post("/:projectId/inverse", async (req, res) => {
    const { pdf, page, h, v } = req.body ?? {};
    if (typeof pdf !== "string" || typeof page !== "number" || typeof h !== "number" || typeof v !== "number") {
      return res.status(400).json({ error: "pdf, page, h and v required" });
    }

    const project = res.locals.project as ProjectWithAccess;
    const proposalId = Number(req.body?.proposalId ?? 0);
    const proposal = Number.isInteger(proposalId) && proposalId > 0
      ? db.projects.findProposal(project.id, proposalId)
      : undefined;
    if (proposalId > 0 && !proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal && proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(410).json({ error: `proposal is ${proposal.status}` });
    }
    const root = proposal ? proposal.worktree_path : await ensureProjectDir(cfg, project.owner_id, project.id);
    const result = await inverseSearch(cfg, root, pdf, page, h, v);
    res.status(result.success ? 200 : 404).json(result);
  });

  return r;
}

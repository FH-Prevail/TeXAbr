import { Router } from "express";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { requireAuth } from "../middleware/auth";
import { requireProjectAccess } from "../services/access";
import { ensureProjectDir } from "../services/projects";
import { compile } from "../services/latex";

export function compileRouter(cfg: Config, db: Db) {
  const r = Router();
  r.use(requireAuth(cfg, db));

  r.post("/:projectId", async (req, res) => {
    const u = req.user!;
    const project = requireProjectAccess(db, u, Number(req.params.projectId), "reader", res);
    if (!project) return;

    const proposalId = Number(req.body?.proposalId ?? 0);
    const proposal = Number.isInteger(proposalId) && proposalId > 0
      ? db.projects.findProposal(project.id, proposalId)
      : undefined;
    if (proposalId > 0 && !proposal) return res.status(404).json({ error: "proposal not found" });
    if (proposal && proposal.status !== "open" && proposal.status !== "conflicted") {
      return res.status(410).json({ error: `proposal is ${proposal.status}` });
    }
    const root = proposal ? proposal.worktree_path : await ensureProjectDir(cfg, project.owner_id, project.id);
    const engine = typeof req.body?.engine === "string" && cfg.latex.engines.includes(req.body.engine)
      ? req.body.engine
      : project.engine;
    const mainFile = typeof req.body?.mainFile === "string" && req.body.mainFile
      ? req.body.mainFile
      : project.main_file;

    try {
      const result = await compile(cfg, db, root, {
        engine,
        mainFile,
        userId: u.id,
        projectId: project.id,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}

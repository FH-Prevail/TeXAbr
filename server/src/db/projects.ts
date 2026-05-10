import type Database from "better-sqlite3";

export interface ProjectRow {
  id: number;
  owner_id: number;
  slug: string;
  name: string;
  main_file: string;
  engine: string;
  created_at: number;
  updated_at: number;
}

export type ProjectRole = "owner" | "editor" | "reader";

export interface ProjectWithAccess extends ProjectRow {
  access_role: ProjectRole;
  owner_username: string;
}

export interface ProjectMemberRow {
  project_id: number;
  user_id: number;
  username: string;
  email: string | null;
  role: Exclude<ProjectRole, "owner">;
  created_at: number;
  updated_at: number;
}

export type ProposalStatus = "open" | "merged" | "closed" | "conflicted";

export interface ProjectProposalRow {
  id: number;
  project_id: number;
  created_by: number;
  creator_username: string;
  title: string;
  description: string | null;
  branch_name: string;
  worktree_path: string;
  status: ProposalStatus;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  closed_at: number | null;
}

export interface Projects {
  listForOwner(ownerId: number): ProjectRow[];
  listForUser(userId: number): ProjectWithAccess[];
  findById(id: number): ProjectRow | undefined;
  accessForUser(projectId: number, userId: number): ProjectWithAccess | undefined;
  findByOwnerSlug(ownerId: number, slug: string): ProjectRow | undefined;
  create(input: { ownerId: number; slug: string; name: string; engine: string }): ProjectRow;
  listMembers(projectId: number): ProjectMemberRow[];
  grantAccess(projectId: number, userId: number, role: "reader" | "editor"): void;
  revokeAccess(projectId: number, userId: number): void;
  listProposals(projectId: number): ProjectProposalRow[];
  findProposal(projectId: number, proposalId: number): ProjectProposalRow | undefined;
  createProposal(input: {
    projectId: number;
    createdBy: number;
    title: string;
    description: string | null;
    branchName: string;
    worktreePath: string;
  }): ProjectProposalRow;
  setProposalStatus(projectId: number, proposalId: number, status: ProposalStatus): void;
  touchProposal(projectId: number, proposalId: number): void;
  rename(id: number, name: string): void;
  setMainFile(id: number, mainFile: string): void;
  setEngine(id: number, engine: string): void;
  touch(id: number): void;
  delete(id: number): void;
}

export function makeProjects(db: Database.Database): Projects {
  const sList = db.prepare<[number], ProjectRow>(
    `SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC`,
  );
  const sListForUser = db.prepare<[number, number], ProjectWithAccess>(
    `SELECT p.*, 'owner' AS access_role, u.username AS owner_username
       FROM projects p
       JOIN users u ON u.id = p.owner_id
      WHERE p.owner_id = ?
     UNION ALL
     SELECT p.*, pm.role AS access_role, u.username AS owner_username
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN users u ON u.id = p.owner_id
      WHERE pm.user_id = ?
      ORDER BY updated_at DESC`,
  );
  const sById = db.prepare<[number], ProjectRow>(`SELECT * FROM projects WHERE id = ?`);
  const sAccess = db.prepare<[number, number, number, number], ProjectWithAccess>(
    `SELECT p.*,
            CASE WHEN p.owner_id = ? THEN 'owner' ELSE pm.role END AS access_role,
            u.username AS owner_username
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
      WHERE p.id = ?
        AND (p.owner_id = ? OR pm.user_id IS NOT NULL)`,
  );
  const sBySlug = db.prepare<[number, string], ProjectRow>(
    `SELECT * FROM projects WHERE owner_id = ? AND slug = ?`,
  );
  const sInsert = db.prepare<[number, string, string, string, number, number]>(
    `INSERT INTO projects (owner_id, slug, name, engine, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const sRename = db.prepare<[string, number, number]>(
    `UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`,
  );
  const sMain = db.prepare<[string, number, number]>(
    `UPDATE projects SET main_file = ?, updated_at = ? WHERE id = ?`,
  );
  const sEng = db.prepare<[string, number, number]>(
    `UPDATE projects SET engine = ?, updated_at = ? WHERE id = ?`,
  );
  const sTouch = db.prepare<[number, number]>(
    `UPDATE projects SET updated_at = ? WHERE id = ?`,
  );
  const sDelete = db.prepare<[number]>(`DELETE FROM projects WHERE id = ?`);
  const sMembers = db.prepare<[number], ProjectMemberRow>(
    `SELECT pm.project_id, pm.user_id, u.username, u.email, pm.role, pm.created_at, pm.updated_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ?
      ORDER BY u.username COLLATE NOCASE`,
  );
  const sGrant = db.prepare<[number, number, "reader" | "editor", number, number]>(
    `INSERT INTO project_members (project_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE
       SET role = excluded.role, updated_at = excluded.updated_at`,
  );
  const sRevoke = db.prepare<[number, number]>(
    `DELETE FROM project_members WHERE project_id = ? AND user_id = ?`,
  );
  const proposalSelect = `
    SELECT pp.*, u.username AS creator_username
      FROM project_proposals pp
      JOIN users u ON u.id = pp.created_by
  `;
  const sProposals = db.prepare<[number], ProjectProposalRow>(
    `${proposalSelect}
      WHERE pp.project_id = ?
      ORDER BY pp.updated_at DESC`,
  );
  const sProposal = db.prepare<[number, number], ProjectProposalRow>(
    `${proposalSelect}
      WHERE pp.project_id = ? AND pp.id = ?`,
  );
  const sInsertProposal = db.prepare<[number, number, string, string | null, string, string, number, number]>(
    `INSERT INTO project_proposals
       (project_id, created_by, title, description, branch_name, worktree_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sProposalStatus = db.prepare<[ProposalStatus, number | null, number | null, number, number, number]>(
    `UPDATE project_proposals
        SET status = ?, merged_at = ?, closed_at = ?, updated_at = ?
      WHERE project_id = ? AND id = ?`,
  );
  const sProposalTouch = db.prepare<[number, number, number]>(
    `UPDATE project_proposals SET updated_at = ? WHERE project_id = ? AND id = ?`,
  );

  return {
    listForOwner: (id) => sList.all(id),
    listForUser: (id) => sListForUser.all(id, id),
    findById: (id) => sById.get(id),
    accessForUser: (projectId, userId) => sAccess.get(userId, userId, projectId, userId),
    findByOwnerSlug: (ownerId, slug) => sBySlug.get(ownerId, slug),
    create({ ownerId, slug, name, engine }) {
      const now = Date.now();
      const info = sInsert.run(ownerId, slug, name, engine, now, now);
      return sById.get(Number(info.lastInsertRowid))!;
    },
    listMembers: (projectId) => sMembers.all(projectId),
    grantAccess: (projectId, userId, role) => {
      const now = Date.now();
      sGrant.run(projectId, userId, role, now, now);
    },
    revokeAccess: (projectId, userId) => void sRevoke.run(projectId, userId),
    listProposals: (projectId) => sProposals.all(projectId),
    findProposal: (projectId, proposalId) => sProposal.get(projectId, proposalId),
    createProposal(input) {
      const now = Date.now();
      const info = sInsertProposal.run(
        input.projectId,
        input.createdBy,
        input.title,
        input.description,
        input.branchName,
        input.worktreePath,
        now,
        now,
      );
      return sProposal.get(input.projectId, Number(info.lastInsertRowid))!;
    },
    setProposalStatus(projectId, proposalId, status) {
      const now = Date.now();
      sProposalStatus.run(
        status,
        status === "merged" ? now : null,
        status === "closed" ? now : null,
        now,
        projectId,
        proposalId,
      );
    },
    touchProposal: (projectId, proposalId) => void sProposalTouch.run(Date.now(), projectId, proposalId),
    rename: (id, name) => void sRename.run(name, Date.now(), id),
    setMainFile: (id, m) => void sMain.run(m, Date.now(), id),
    setEngine: (id, e) => void sEng.run(e, Date.now(), id),
    touch: (id) => void sTouch.run(Date.now(), id),
    delete: (id) => void sDelete.run(id),
  };
}

import type { Response } from "express";
import type { Db } from "../db/db";
import type { ProjectRole, ProjectWithAccess } from "../db/projects";
import type { UserRow } from "../db/users";

const ROLE_RANK: Record<ProjectRole, number> = {
  reader: 1,
  editor: 2,
  owner: 3,
};

export function canProjectRole(actual: ProjectRole, required: ProjectRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function getProjectAccess(
  db: Db,
  user: UserRow,
  projectId: number,
  required: ProjectRole = "reader",
): ProjectWithAccess | undefined {
  if (!Number.isInteger(projectId) || projectId <= 0) return undefined;
  const project = db.projects.accessForUser(projectId, user.id);
  if (!project || !canProjectRole(project.access_role, required)) return undefined;
  return project;
}

export function requireProjectAccess(
  db: Db,
  user: UserRow,
  projectId: number,
  required: ProjectRole,
  res: Response,
): ProjectWithAccess | undefined {
  const project = getProjectAccess(db, user, projectId, required);
  if (!project) {
    res.status(required === "reader" ? 404 : 403).json({
      error: required === "reader" ? "project not found" : `${required} access required`,
    });
  }
  return project;
}

import "server-only";

import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getSessionUser, type AuthUser } from "@/lib/auth";
import { getBoardWorkflow, type BoardWorkflow } from "@/lib/board-workflows";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";

export type ProjectAccess = {
  user: AuthUser;
  project: typeof projects.$inferSelect;
};

export type BoardWorkflowAccess = {
  user: AuthUser;
  workflow: BoardWorkflow;
};

export async function getAuthenticatedRequestUser(req: NextRequest): Promise<AuthUser | null> {
  return getSessionUser(req);
}

export async function canAccessOptionalProject(
  req: NextRequest,
  projectId: unknown
): Promise<{ user: AuthUser; project: typeof projects.$inferSelect | null } | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  if (typeof projectId !== "string" || !projectId.trim()) return { user, project: null };

  const access = await getOwnedProjectAccess(req, projectId);
  return access ? { user: access.user, project: access.project } : null;
}

/**
 * Route handlers use this before reading or mutating a project resource.
 * Returning null for both anonymous and foreign resources avoids leaking IDs.
 */
export async function getOwnedProjectAccess(req: NextRequest, projectId: string): Promise<ProjectAccess | null> {
  const user = await getSessionUser(req);
  if (!user || !projectId) return null;

  const [project] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, user.id)))
    .limit(1);

  return project ? { user, project } : null;
}

/**
 * Board workflows currently live in a JSON store, so ownership is checked
 * against the persisted owner before any node operation or file access.
 */
export async function getOwnedBoardWorkflowAccess(
  req: NextRequest,
  workflowId: string
): Promise<BoardWorkflowAccess | null> {
  const user = await getSessionUser(req);
  if (!user || !workflowId) return null;

  const workflow = await getBoardWorkflow(workflowId, user.id);
  return workflow ? { user, workflow } : null;
}

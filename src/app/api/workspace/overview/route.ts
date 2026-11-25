import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { listBoardWorkflows } from "@/lib/board-workflows";
import { getDb } from "@/lib/db";
import {
  analyticsImports,
  assets,
  compositions,
  projects,
  quickCutTasks,
  scripts,
  videoClips,
} from "@/lib/db/schema";
import { buildWorkspaceOverview } from "@/lib/workspace-overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusCounts = Record<string, number>;

function addCount(map: Map<string, StatusCounts>, projectId: string, status = "total") {
  const current = map.get(projectId) || {};
  current.total = (current.total || 0) + 1;
  current[status] = (current[status] || 0) + 1;
  map.set(projectId, current);
}

function countFor(map: Map<string, StatusCounts>, projectId: string, status: string) {
  return map.get(projectId)?.[status] || 0;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = getDb();
    const [projectRows, boardRows, quickCutRows, analyticsRows] = await Promise.all([
      db.select().from(projects).where(eq(projects.ownerId, user.id)).orderBy(desc(projects.updatedAt)),
      listBoardWorkflows(user.id),
      db.select().from(quickCutTasks).where(eq(quickCutTasks.ownerId, user.id)).orderBy(desc(quickCutTasks.updatedAt)),
      db.select().from(analyticsImports).where(eq(analyticsImports.ownerId, user.id)).orderBy(desc(analyticsImports.createdAt)).limit(6),
    ]);

    const projectIds = projectRows.map((project) => project.id);
    const [scriptRows, assetRows, clipRows, compositionRows] = projectIds.length > 0
      ? await Promise.all([
          db.select({ projectId: scripts.projectId }).from(scripts).where(inArray(scripts.projectId, projectIds)),
          db.select({ projectId: assets.projectId, status: assets.status }).from(assets).where(inArray(assets.projectId, projectIds)),
          db.select({ projectId: videoClips.projectId, status: videoClips.status }).from(videoClips).where(inArray(videoClips.projectId, projectIds)),
          db.select({ projectId: compositions.projectId, status: compositions.status }).from(compositions).where(inArray(compositions.projectId, projectIds)),
        ])
      : [[], [], [], []];

    const scriptCounts = new Map<string, number>();
    for (const row of scriptRows) scriptCounts.set(row.projectId, (scriptCounts.get(row.projectId) || 0) + 1);

    const assetCounts = new Map<string, StatusCounts>();
    const clipCounts = new Map<string, StatusCounts>();
    const compositionCounts = new Map<string, StatusCounts>();
    for (const row of assetRows) addCount(assetCounts, row.projectId, row.status);
    for (const row of clipRows) addCount(clipCounts, row.projectId, row.status);
    for (const row of compositionRows) addCount(compositionCounts, row.projectId, row.status);

    const overview = buildWorkspaceOverview({
      projects: projectRows.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        sourceType: project.sourceType,
        currentVersionId: project.currentVersionId,
        productName: project.productName,
        updatedAt: project.updatedAt,
        scriptCount: scriptCounts.get(project.id) || 0,
        assetCount: countFor(assetCounts, project.id, "total"),
        assetDoneCount: countFor(assetCounts, project.id, "done"),
        assetFailedCount: countFor(assetCounts, project.id, "failed"),
        assetRunningCount: countFor(assetCounts, project.id, "generating"),
        clipCount: countFor(clipCounts, project.id, "total"),
        clipDoneCount: countFor(clipCounts, project.id, "done"),
        clipFailedCount: countFor(clipCounts, project.id, "failed"),
        clipRunningCount: countFor(clipCounts, project.id, "generating"),
        compositionCount: countFor(compositionCounts, project.id, "total"),
        compositionDoneCount: countFor(compositionCounts, project.id, "done"),
        compositionFailedCount: countFor(compositionCounts, project.id, "failed"),
        compositionRunningCount: countFor(compositionCounts, project.id, "composing"),
      })),
      boards: boardRows.map((board) => ({
        id: board.id,
        name: board.name,
        status: board.status,
        description: board.description,
        updatedAt: board.updatedAt,
        nodes: board.nodes.map((node) => ({ status: node.status, execution: node.execution ? { status: node.execution.status } : undefined })),
      })),
      quickCuts: quickCutRows.map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        stage: task.stage,
        progress: task.progress,
        total: task.total,
        completed: task.completed,
        failed: task.failed,
        updatedAt: task.updatedAt,
      })),
      analytics: analyticsRows.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        status: item.status,
        stage: item.stage,
        progress: item.progress,
        reconciliationStatus: item.reconciliationStatus,
        issueCount: item.issueCount,
        updatedAt: item.completedAt || item.committedAt || item.previewedAt || item.createdAt,
      })),
    });

    return NextResponse.json({ generatedAt: new Date().toISOString(), ...overview });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "读取指挥中心任务失败" },
      { status: 500 },
    );
  }
}

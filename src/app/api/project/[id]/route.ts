import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projectVersions, projects } from "@/lib/db/schema";
import { getOrCreateDefaultProjectVersion, listProjectVersions } from "@/lib/project-versions";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

async function getOwnedProject(id: string, ownerId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
    .limit(1);
  return project ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser(req);
    const project = await getOwnedProject(id, user.id);

    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const requestedVersionId = req.nextUrl.searchParams.get("versionId");
    const versions = await listProjectVersions(project.id);
    const currentVersion = (requestedVersionId ? versions.find((version) => version.id === requestedVersionId) : null)
      ?? versions.find((version) => version.id === project.currentVersionId)
      ?? versions.find((version) => version.isDefault)
      ?? await getOrCreateDefaultProjectVersion(project);

    return NextResponse.json({
      ...project,
      status: currentVersion.status ?? project.status,
      productAnalysis: currentVersion.productAnalysis ?? null,
      sourceType: currentVersion.versionType === "clone" ? "clone" : "manual",
      versions,
      currentVersion,
    });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "获取项目失败" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser(req);
    const body = await req.json();
    const db = getDb();
    const project = await getOwnedProject(id, user.id);
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

    const requestedVersionId = typeof body.versionId === "string" ? body.versionId : null;
    const projectPatch = { ...body };
    delete projectPatch.versionId;
    delete projectPatch.ownerId;
    if (requestedVersionId) {
      delete projectPatch.productAnalysis;
      delete projectPatch.status;
    }
    const [updatedProject] = await db
      .update(projects)
      .set({ ...projectPatch, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.ownerId, user.id)))
      .returning();

    if (!updatedProject) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    if (typeof body.productAnalysis === "string" || typeof body.status === "string") {
      const versions = await listProjectVersions(id);
      const targetVersion = requestedVersionId
        ? versions.find((version) => version.id === requestedVersionId)
        : versions.find((version) => version.id === updatedProject.currentVersionId) ?? versions.find((version) => version.isDefault);
      if (targetVersion) {
        await db
          .update(projectVersions)
          .set({
            productAnalysis: typeof body.productAnalysis === "string" ? body.productAnalysis : targetVersion.productAnalysis,
            status: typeof body.status === "string" ? body.status : targetVersion.status,
            updatedAt: new Date(),
          })
          .where(eq(projectVersions.id, targetVersion.id));
      }
    }

    return NextResponse.json(updatedProject);
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新项目失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser(req);
    const db = getDb();
    await db.delete(projects).where(and(eq(projects.id, id), eq(projects.ownerId, user.id)));
    return NextResponse.json({ success: true });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除项目失败" },
      { status: 500 }
    );
  }
}

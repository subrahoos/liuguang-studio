import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, compositions, videoClips } from "@/lib/db/schema";
import { countExistingProjectFiles, ensureProjectArchiveById } from "@/lib/project-local-archive";
import { resolveProjectVersion, versionIdFromRequest } from "@/lib/project-versions";

function publicCompositionPath(projectId: string, outputPath: string | null) {
  if (!outputPath) return null;
  const fileName = outputPath.split(/[\\/]/).pop();
  return fileName ? `/api/project/${projectId}/compositions/file/${encodeURIComponent(fileName)}` : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  try {
    const db = getDb();
    const { project, version } = await resolveProjectVersion(id, versionIdFromRequest(req));
    if (!project || !version) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const savedAssets = await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.versionId, version.id))).orderBy(asc(assets.shotId));
    const savedClips = await db.select().from(videoClips).where(and(eq(videoClips.projectId, id), eq(videoClips.versionId, version.id))).orderBy(asc(videoClips.shotId));
    const savedCompositions = await db.select().from(compositions).where(and(eq(compositions.projectId, id), eq(compositions.versionId, version.id))).orderBy(asc(compositions.createdAt));

    const assetCount = await countExistingProjectFiles(id, "assets", savedAssets.map((asset) => asset.filePath), version.id);
    const clipCount = await countExistingProjectFiles(id, "videos", savedClips.map((clip) => clip.filePath), version.id);
    const compositionCount = await countExistingProjectFiles(
      id,
      "compositions",
      savedCompositions.map((composition) => publicCompositionPath(id, composition.outputPath)),
      version.id
    );
    const paths = await ensureProjectArchiveById(id, version.id);

    return NextResponse.json({
      version,
      paths: {
        root: paths.root,
        versionDir: paths.versionDir,
        assetsDir: paths.versionDir,
        videosDir: paths.versionDir,
        compositionsDir: paths.versionDir,
      },
      synced: {
        assets: assetCount,
        videos: clipCount,
        compositions: compositionCount,
      },
    });
  } catch (error) {
    console.error("local archive status failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "local archive status failed" },
      { status: 500 }
    );
  }
}

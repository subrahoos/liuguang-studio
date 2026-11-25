import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { compositions, projects, projectVersions, videoClips } from "@/lib/db/schema";
import { composeVideo, type ClipInput } from "@/lib/video-composer/composer";
import { copyProjectFileFromLocal, resolvePublicProjectFilePath } from "@/lib/project-local-archive";
import { resolveProjectVersion, versionIdFromRequest } from "@/lib/project-versions";
import { storagePaths } from "@/lib/storage-root";

const CLONE_FULL_VIDEO_SHOT_ID = 9999;

async function localVideoPath(projectId: string, filePath: string | null, versionId?: string | null) {
  if (!filePath) return null;
  const match = filePath.match(/\/api\/project\/([^/]+)\/video-clips\/file\/([^?]+)/);
  if (!match) return null;
  const safeProjectId = match[1];
  const fileName = decodeURIComponent(match[2]);
  if (safeProjectId !== projectId) return null;
  return resolvePublicProjectFilePath(projectId, filePath, "videos", versionId)
    ?? storagePaths.projects("_legacy", "videos", projectId, fileName);
}

function publicCompositionPath(projectId: string, outputPath: string, versionId?: string | null) {
  const fileName = outputPath.split(/[\\/]/).pop();
  if (!fileName) return outputPath;
  const basePath = `/api/project/${projectId}/compositions/file/${encodeURIComponent(fileName)}`;
  return versionId ? `${basePath}?versionId=${encodeURIComponent(versionId)}` : basePath;
}

function normalizedFinalFileName(outputPath: string) {
  const rawName = outputPath.split(/[\\/]/).pop() || `composition-${Date.now()}.mp4`;
  const cleanName = rawName.replace(/^(final_)+/i, "");
  return `final_${cleanName}`;
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

    const rows = await db
      .select()
      .from(compositions)
      .where(and(eq(compositions.projectId, id), eq(compositions.versionId, version.id)))
      .orderBy(asc(compositions.createdAt));

    return NextResponse.json({
      compositions: rows.map((row) => ({
        ...row,
        filePath: row.outputPath ? publicCompositionPath(id, row.outputPath, version.id) : null,
      })),
    });
  } catch (error) {
    console.error("get compositions failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "get compositions failed" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const requestedVersionId = typeof body.versionId === "string" ? body.versionId : null;
  const resolution = body.resolution === "720p" ? "720p" : "1080p";
  const aspectRatio = ["9:16", "16:9", "1:1"].includes(body.aspectRatio) ? body.aspectRatio : "9:16";

  try {
    const db = getDb();
    const { project, version } = await resolveProjectVersion(id, requestedVersionId);
    if (!project || !version) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const clips = await db
      .select()
      .from(videoClips)
      .where(and(eq(videoClips.projectId, id), eq(videoClips.versionId, version.id)))
      .orderBy(asc(videoClips.shotId));

    const readyClips = clips.filter((clip) => clip.status === "done" && clip.filePath && clip.shotId !== CLONE_FULL_VIDEO_SHOT_ID);
    if (readyClips.length === 0) {
      return NextResponse.json({ error: "no ready single-shot videos to compose" }, { status: 400 });
    }

    const composeClips: ClipInput[] = await Promise.all(readyClips.map(async (clip) => {
      const path = await localVideoPath(id, clip.filePath, version.id);
      if (!path) throw new Error(`invalid clip file path for shot ${clip.shotId}`);
      return {
        type: "video" as const,
        filePath: path,
        duration: clip.duration ? Math.max(1, Math.round(clip.duration / 1000)) : 4,
        transition: clip.transitionType || "direct_concat",
        hasAudio: true,
      };
    }));

    const outputPath = await composeVideo({
      projectId: id,
      clips: composeClips,
      output: {
        resolution,
        aspectRatio,
      },
    });

    if (!outputPath) {
      throw new Error("compose tool did not return output path");
    }
    const storedOutputPath = await copyProjectFileFromLocal(
      project.id,
      "compositions",
      normalizedFinalFileName(outputPath),
      outputPath,
      { versionId: version.id }
    );

    const totalDurationMs = readyClips.reduce((sum, clip) => sum + (clip.duration ?? 0), 0);
    const [saved] = await db
      .insert(compositions)
      .values({
        projectId: id,
        versionId: version.id,
        outputPath: storedOutputPath,
        resolution,
        aspectRatio,
        duration: totalDurationMs || null,
        ttsEnabled: false,
        status: "done",
      })
      .returning();

    await db
      .update(projects)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(projects.id, id));
    await db
      .update(projectVersions)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(projectVersions.id, version.id));

    return NextResponse.json({
      ...saved,
      filePath: publicCompositionPath(id, storedOutputPath, version.id),
    });
  } catch (error) {
    console.error("compose final video failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "compose final video failed" },
      { status: 500 }
    );
  }
}

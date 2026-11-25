import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, projectVersions, videoClips } from "@/lib/db/schema";
import { writeProjectFile } from "@/lib/project-local-archive";
import { resolveProjectVersion, versionIdFromRequest } from "@/lib/project-versions";

type SaveVideoClipPayload = {
  versionId?: string | null;
  shotId: number;
  assetId?: string | null;
  videoUrl: string;
  duration?: number;
  provider?: string | null;
  model?: string | null;
  transitionType?: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade";
};

function extFromContentType(contentType: string | null) {
  if (!contentType) return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  return "mp4";
}

async function downloadVideoToLocal(projectId: string, versionId: string, shotId: number, videoUrl: string) {
  const dataUrlMatch = videoUrl.match(/^data:(video\/[^;,]+);base64,(.+)$/);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1];
    const bytes = Buffer.from(dataUrlMatch[2], "base64");
    if (!mimeType.startsWith("video/") || bytes.length === 0 || bytes.length > 800 * 1024 * 1024) {
      throw new Error("decoded video data is empty");
    }

    const ext = extFromContentType(mimeType);
    const fileName = `shot_${String(shotId).padStart(2, "0")}_${Date.now()}.${ext}`;
    await writeProjectFile(projectId, "videos", fileName, bytes, { versionId });
    return `/api/project/${projectId}/video-clips/file/${encodeURIComponent(fileName)}`;
  }

  if (!/^https?:\/\//i.test(videoUrl)) {
    if (!videoUrl.startsWith("/api/")) throw new Error("videoUrl must be a project API path or HTTPS URL");
    return videoUrl;
  }

  const parsed = new URL(videoUrl);
  if (parsed.username || parsed.password) throw new Error("video URL credentials are not allowed");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(hostname)) {
    throw new Error("private video URL host is not allowed");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("private video URL address is not allowed");
  }

  const response = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`download video failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 800 * 1024 * 1024) throw new Error("downloaded video exceeds 800MB");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("downloaded video has no response body");
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > 800 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("downloaded video exceeds 800MB");
    }
    chunks.push(Buffer.from(next.value));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) {
    throw new Error("downloaded video is empty");
  }

  if (!response.headers.get("content-type")?.toLowerCase().startsWith("video/")) {
    throw new Error("downloaded response is not a video");
  }

  const ext = extFromContentType(response.headers.get("content-type"));
  const fileName = `shot_${String(shotId).padStart(2, "0")}_${Date.now()}.${ext}`;
  await writeProjectFile(projectId, "videos", fileName, bytes, { versionId });
  return `/api/project/${projectId}/video-clips/file/${encodeURIComponent(fileName)}`;
}

function isPrivateNetworkAddress(address: string) {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [first, second] = parts;
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31
      || first === 192 && second === 168
      || first === 100 && second >= 64 && second <= 127
      || first === 198 && (second === 18 || second === 19)
      || first >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.");
  }
  return true;
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
    if (!project || !version) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }

    const clips = await db
      .select()
      .from(videoClips)
      .where(and(eq(videoClips.projectId, id), eq(videoClips.versionId, version.id)))
      .orderBy(asc(videoClips.shotId), asc(videoClips.createdAt));

    return NextResponse.json({ clips });
  } catch (error) {
    console.error("get video clips failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "get video clips failed" },
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
  const body = (await req.json()) as SaveVideoClipPayload;

  if (!body.shotId || !body.videoUrl) {
    return NextResponse.json({ error: "missing shotId or videoUrl" }, { status: 400 });
  }

  try {
    const db = getDb();
    const { project, version } = await resolveProjectVersion(id, body.versionId ?? null);
    if (!project || !version) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }

    const localFilePath = await downloadVideoToLocal(id, version.id, body.shotId, body.videoUrl);

    await db
      .delete(videoClips)
      .where(and(eq(videoClips.projectId, id), eq(videoClips.versionId, version.id), eq(videoClips.shotId, body.shotId)));

    const [saved] = await db
      .insert(videoClips)
      .values({
        projectId: id,
        versionId: version.id,
        shotId: body.shotId,
        assetId: body.assetId ?? null,
        filePath: localFilePath,
        duration: body.duration ? Math.round(body.duration * 1000) : null,
        provider: body.provider ?? "openai-seedance",
        model: body.model ?? null,
        transitionType: body.transitionType ?? "ai_start_end",
        status: "done",
      })
      .returning();

    await db
      .update(projects)
      .set({ status: "video", updatedAt: new Date() })
      .where(eq(projects.id, id));
    await db
      .update(projectVersions)
      .set({ status: "video", updatedAt: new Date() })
      .where(eq(projectVersions.id, version.id));

    return NextResponse.json(saved);
  } catch (error) {
    console.error("save video clip failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save video clip failed" },
      { status: 500 }
    );
  }
}

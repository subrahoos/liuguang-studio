import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { and, eq } from "drizzle-orm";
import { resolveStoredProjectFile } from "@/lib/project-local-archive";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { handleAuthRouteError, isAdmin, requireUser } from "@/lib/auth";

function versionIdFromRequest(req: NextRequest) {
  const direct = req.nextUrl.searchParams.get("versionId");
  if (direct) return direct;
  const referer = req.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).searchParams.get("versionId");
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const user = await requireUser(req);
    const { path } = await params;
    const [projectId, fileName] = path;

    if (!projectId || !fileName) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    const canReadLegacyLibrary = projectId === "product-library" && isAdmin(user);
    const canReadOwnLibrary = projectId === `product-library-${user.id}`;

    if (!canReadLegacyLibrary && !canReadOwnLibrary) {
      const [owned] = await getDb()
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.ownerId, user.id)))
        .limit(1);
      if (!owned) return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    const versionId = versionIdFromRequest(req);
    const filePath = await resolveStoredProjectFile(projectId, "assets", fileName, versionId);

    if (!existsSync(filePath)) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    const buffer = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
    };

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mimeTypes[ext || ""] || "application/octet-stream",
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取文件失败" }, { status: 500 });
  }
}

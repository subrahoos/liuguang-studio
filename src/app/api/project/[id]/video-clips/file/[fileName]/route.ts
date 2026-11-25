import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename } from "path";
import { resolveStoredProjectFile } from "@/lib/project-local-archive";

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
  { params }: { params: Promise<{ id: string; fileName: string }> }
) {
  const { id, fileName } = await params;
  const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const safeFileName = basename(decodeURIComponent(fileName));
  const filePath = await resolveStoredProjectFile(id, "videos", safeFileName, versionIdFromRequest(req));

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "video file not found" }, { status: 404 });
  }

  const buffer = await readFile(filePath);
  const ext = safeFileName.split(".").pop()?.toLowerCase();
  const contentType = ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store, max-age=0",
  });

  if (req.nextUrl.searchParams.get("download") === "1") {
    headers.set("Content-Disposition", `attachment; filename="${safeFileName}"`);
  }

  return new NextResponse(buffer, { headers });
}

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { writeProjectFile } from "@/lib/project-local-archive";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const ALLOWED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "svg", "bmp",
  "mp4", "webm", "mov",
]);

const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 300 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    const projectId = formData.get("projectId") as string;

    if (!files.length) {
      return NextResponse.json({ error: "请上传至少一个文件" }, { status: 400 });
    }

    if (!projectId) {
      return NextResponse.json({ error: "缺少项目ID" }, { status: 400 });
    }

    if (!/^[a-zA-Z0-9\-]+$/.test(projectId)) {
      return NextResponse.json({ error: "无效的项目ID格式" }, { status: 400 });
    }

    const storageProjectId = projectId === "product-library" ? `product-library-${user.id}` : projectId;

    if (projectId !== "product-library") {
      const [owned] = await getDb()
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.ownerId, user.id)))
        .limit(1);
      if (!owned) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    const savedPaths: string[] = [];

    for (const file of files) {
      const isVideo = file.type.startsWith("video/");
      const maxFileSize = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_IMAGE_FILE_SIZE;

      if (file.size > maxFileSize) {
        return NextResponse.json(
          { error: `文件 ${file.name} 超过 ${isVideo ? "300MB" : "20MB"} 大小限制` },
          { status: 400 }
        );
      }

      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        return NextResponse.json(
          { error: `文件 ${file.name} 类型不支持，仅允许图片或 MP4/WebM/MOV 视频` },
          { status: 400 }
        );
      }

      const rawName = file.name.replace(/[/\\]/g, "");
      const ext = rawName.split(".").pop()?.toLowerCase() || "jpg";
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return NextResponse.json(
          { error: `文件 ${file.name} 扩展名不支持` },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await writeProjectFile(storageProjectId, "assets", fileName, buffer);
      savedPaths.push(`/api/files/${storageProjectId}/${fileName}`);
    }

    return NextResponse.json({ paths: savedPaths });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败" },
      { status: 500 }
    );
  }
}

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { extname, join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { storagePaths } from "@/lib/storage-root";

export const runtime = "nodejs";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const MAX_IMAGE_FILE_SIZE = 30 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 500 * 1024 * 1024;

function backgroundDir(userId: string) {
  return storagePaths.backgrounds(userId);
}

function extensionFor(file: File) {
  const fromMime = MIME_EXTENSION[file.type];
  if (fromMime) return fromMime;
  const fromName = extname(file.name).replace(".", "").toLowerCase();
  return fromName || "bin";
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const formData = await req.formData();
    const file = formData.get("file");
    const expectedSize = formData.get("expectedSize");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传背景图片或视频" }, { status: 400 });
    }

    if (typeof expectedSize === "string") {
      const expectedBytes = Number(expectedSize);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        return NextResponse.json({ error: "背景素材上传参数无效" }, { status: 400 });
      }
      if (file.size !== expectedBytes) {
        return NextResponse.json({ error: "背景视频上传不完整，请重新导入后再试" }, { status: 400 });
      }
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json({ error: "仅支持 JPG、PNG、WebP、GIF、BMP、MP4、WebM 或 MOV" }, { status: 400 });
    }

    const isVideo = file.type.startsWith("video/");
    const maxSize = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_IMAGE_FILE_SIZE;
    if (file.size > maxSize) {
      return NextResponse.json({ error: `文件超过 ${isVideo ? "500MB" : "30MB"} 大小限制` }, { status: 400 });
    }

    await mkdir(backgroundDir(user.id), { recursive: true });

    const fileName = `${Date.now()}-${randomUUID()}.${extensionFor(file)}`;
    const target = join(backgroundDir(user.id), fileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(target, buffer);

    return NextResponse.json({
      type: isVideo ? "video" : "image",
      url: `/api/home-backgrounds/${user.id}/${fileName}`,
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "背景素材保存失败" },
      { status: 500 }
    );
  }
}

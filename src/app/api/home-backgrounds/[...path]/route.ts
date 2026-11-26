import { readFile } from "fs/promises";
import { basename, extname, join, resolve, sep } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ADMIN_USER_ID } from "@/lib/auth-constants";
import { storagePaths } from "@/lib/storage-root";

export const runtime = "nodejs";

function backgroundRoot() {
  return resolve(storagePaths.backgrounds());
}

function mimeFromName(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const root = backgroundRoot();
  if (path.length < 1 || path.length > 2 || path.some((part) => !part || part === "." || part === ".." || basename(part) !== part)) {
    return NextResponse.json({ error: "背景文件不存在" }, { status: 404 });
  }
  const safePath = path.length >= 2
    ? [basename(path[0]), basename(path[1])]
    : [basename(path[0] || "")];
  const ownerId = safePath.length === 2 ? safePath[0] : ADMIN_USER_ID;
  const user = await getSessionUser(req);

  if (!user || user.id !== ownerId) {
    return NextResponse.json({ error: "背景文件不存在" }, { status: 404 });
  }
  const target = resolve(join(root, ...safePath));

  if (!target.startsWith(root + sep)) {
    return NextResponse.json({ error: "无效的背景文件路径" }, { status: 400 });
  }

  try {
    const buffer = await readFile(target);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mimeFromName(target),
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch {
    return NextResponse.json({ error: "背景文件不存在" }, { status: 404 });
  }
}

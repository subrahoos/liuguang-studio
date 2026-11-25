import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { extname } from "path";
import { resolveIdentityImageFile } from "@/lib/identity-pack";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

function mimeFromName(name: string) {
  const ext = extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ fileName: string }> }) {
  try {
    const user = await requireUser(req);
    const { fileName } = await params;
    const target = resolveIdentityImageFile(user.id, `/api/identity-pack/file/${encodeURIComponent(fileName)}`);
    if (!target) return NextResponse.json({ error: "人物包图片不存在。" }, { status: 404 });
    const buffer = await readFile(target);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mimeFromName(target),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "人物包图片读取失败。" }, { status: 404 });
  }
}

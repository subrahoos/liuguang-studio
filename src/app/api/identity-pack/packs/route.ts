import { NextRequest, NextResponse } from "next/server";
import { createIdentityPack, identityImageTitleFromFileName, saveIdentitySourceImage } from "@/lib/identity-pack";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const form = await req.formData();
    const packName = String(form.get("packName") || "").trim();
    const resolvedPackName = packName || "未命名人物包";
    const source = form.get("source");
    if (!(source instanceof File) || source.size === 0) {
      return NextResponse.json({ error: "请上传主模特身份来源图。" }, { status: 400 });
    }
    if (!ACCEPTED_IMAGE_TYPES.has(source.type)) {
      return NextResponse.json({ error: "人物来源图仅支持 PNG、JPG 或 WebP。" }, { status: 400 });
    }
    if (source.size > MAX_SOURCE_IMAGE_BYTES) {
      return NextResponse.json({ error: "人物来源图不能超过 12MB。" }, { status: 400 });
    }

    const saved = await saveIdentitySourceImage(user.id, user.username, source.name, Buffer.from(await source.arrayBuffer()));
    const result = await createIdentityPack({
      ownerId: user.id,
      packName: resolvedPackName,
      source: {
        title: identityImageTitleFromFileName(saved.fileName),
        role: "该人物包唯一的人脸身份来源图，用于锁定脸型、五官、发型与肤色，并生成白底定型组。",
        url: saved.url,
        aspectRatio: "3:4",
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "创建人物包失败" },
      { status: 500 }
    );
  }
}

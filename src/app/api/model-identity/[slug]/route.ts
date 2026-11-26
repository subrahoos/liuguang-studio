import { legacyIdentityReferenceRoot } from "@/lib/runtime-tools";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const IDENTITY_PACK_DIR = legacyIdentityReferenceRoot();

const IDENTITY_FILES: Record<string, string> = {
  "main-model-v2.png": "白底棚拍运动服模特-参考脸型身材-4K-v2.png",
  "five-angles-v1.png": "模特身份五视角校准-v1.png",
  "pitch-angle-v1.png": "模特身份俯仰角校准-v1.png",
  "expression-mouth-v1.png": "模特身份表情口型校准-v1.png",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    await requireAdmin(req);
    const { slug } = await params;
    const fileName = IDENTITY_FILES[slug];

    if (!fileName) {
      return NextResponse.json({ error: "Identity reference not found" }, { status: 404 });
    }

    const buffer = await readFile(join(/*turbopackIgnore: true*/ IDENTITY_PACK_DIR, fileName));
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "Identity reference file missing" }, { status: 404 });
  }
}

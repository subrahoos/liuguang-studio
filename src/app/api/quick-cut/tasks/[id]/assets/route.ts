import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { clearQuickCutOptionalAssets, storeQuickCutAssetStream, toPublicQuickCutTask, type QuickCutAssetKind } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assetKind(value: string | null): QuickCutAssetKind | null {
  return value === "source" || value === "product" || value === "bgm" ? value : null;
}

function withSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const kind = assetKind(searchParams.get("kind"));
    const relativePath = searchParams.get("relativePath") || "";
    const expectedSizeText = req.headers.get("x-luma-quick-cut-size");
    const expectedSize = expectedSizeText === null ? null : Number(expectedSizeText);
    if (!kind) return withSecurityHeaders(NextResponse.json({ error: "素材类型无效" }, { status: 400 }));
    if (!req.body) {
      return withSecurityHeaders(NextResponse.json({ error: "缺少上传文件" }, { status: 400 }));
    }
    const saved = await storeQuickCutAssetStream({ ownerId: user.id, taskId: id, kind, content: req.body, relativePath, expectedSize });
    return withSecurityHeaders(NextResponse.json({ asset: saved }));
  } catch (error) {
    return withSecurityHeaders(handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "导入素材失败" }, { status: 500 }));
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const kind = assetKind(new URL(req.url).searchParams.get("kind"));
    if (kind !== "product" && kind !== "bgm") return withSecurityHeaders(NextResponse.json({ error: "只能清除商品主图或背景音乐" }, { status: 400 }));
    const task = await clearQuickCutOptionalAssets(user.id, id, kind);
    return withSecurityHeaders(NextResponse.json({ task: await toPublicQuickCutTask(task) }));
  } catch (error) {
    return withSecurityHeaders(handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "清除素材失败" }, { status: 500 }));
  }
}

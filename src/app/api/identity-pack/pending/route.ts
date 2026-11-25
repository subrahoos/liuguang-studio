import { NextRequest, NextResponse } from "next/server";
import {
  finalizeIdentityPendingResult,
  getIdentityPendingResult,
  summarizeIdentityPendingResult,
  updateIdentityPendingResult,
} from "@/lib/identity-pack";
import { readIdentityImageBytes } from "@/lib/identity-pack-result";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const pendingId = String(body.pendingId || "");
    if (!pendingId) return NextResponse.json({ error: "缺少待处理结果编号。" }, { status: 400 });

    const pending = await getIdentityPendingResult(user.id, pendingId);
    if (!pending) return NextResponse.json({ error: "待处理生图结果不存在、已完成或已删除。" }, { status: 404 });

    try {
      const image = await readIdentityImageBytes(pending.payload);
      const finalized = await finalizeIdentityPendingResult({ ownerId: user.id, ownerName: user.username, pendingId, image });
      return NextResponse.json({
        pack: finalized.pack,
        reference: finalized.reference,
        imageUrl: finalized.reference.url,
        pendingId,
        message: `“${pending.title}”已完成本地保存，现为待验收图片。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "待处理结果下载失败";
      await updateIdentityPendingResult(user.id, pendingId, { lastError: message });
      return NextResponse.json({
        pending: true,
        pendingId,
        pendingResult: { ...summarizeIdentityPendingResult(pending), lastError: message },
        error: `“${pending.title}”暂时仍未保存成功，原始结果已保留。${message}`,
      }, { status: 502 });
    }
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "继续下载人物图片失败" },
      { status: 500 }
    );
  }
}

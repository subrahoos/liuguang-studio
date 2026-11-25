import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { startQuickCutMaterialProcessing, toPublicQuickCutTask, type QuickCutProcessingMode } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const mode = body.mode as QuickCutProcessingMode;
    const task = await startQuickCutMaterialProcessing(user.id, id, mode);
    return NextResponse.json({ started: true, task: await toPublicQuickCutTask(task) }, { status: 202 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "启动素材处理失败" }, { status: 500 });
  }
}

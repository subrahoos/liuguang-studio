import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { clearQuickCutProcessingSources, selectQuickCutProcessingSources, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const task = await selectQuickCutProcessingSources(user.id, id);
    return NextResponse.json({ cancelled: !task, task: task ? await toPublicQuickCutTask(task) : null });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "选择本地视频失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const task = await clearQuickCutProcessingSources(user.id, id);
    if (!task) return NextResponse.json({ error: "清除后无法读取任务" }, { status: 500 });
    return NextResponse.json({ task: await toPublicQuickCutTask(task) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "清除本地视频失败" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { getQuickCutTaskForRead, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const task = await getQuickCutTaskForRead(user.id, id);
    if (!task) return NextResponse.json({ error: "任务不存在或无权访问" }, { status: 404 });
    return NextResponse.json({ task: await toPublicQuickCutTask(task) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取流光快剪任务失败" }, { status: 500 });
  }
}

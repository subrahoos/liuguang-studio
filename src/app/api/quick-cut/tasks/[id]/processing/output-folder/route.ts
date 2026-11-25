import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { selectQuickCutProcessingOutputFolder, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const task = await selectQuickCutProcessingOutputFolder(user.id, id);
    return NextResponse.json({ cancelled: !task, task: task ? await toPublicQuickCutTask(task) : null });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "选择输出位置失败" }, { status: 500 });
  }
}

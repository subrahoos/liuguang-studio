import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { getOwnedQuickCutTask, scanQuickCutTask, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const scan = await scanQuickCutTask(user.id, id);
    const task = await getOwnedQuickCutTask(user.id, id);
    return NextResponse.json({ scan, task: task ? await toPublicQuickCutTask(task) : null });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "扫描素材失败" }, { status: 500 });
  }
}

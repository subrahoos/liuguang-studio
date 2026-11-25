import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { clearQuickCutSources, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const task = await clearQuickCutSources(user.id, id);
    return NextResponse.json({ task: await toPublicQuickCutTask(task) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "清除视频素材失败" }, { status: 500 });
  }
}

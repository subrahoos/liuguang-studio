import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { startQuickCutTask, toPublicQuickCutTask, type QuickCutStartRequest } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const request = await req.json() as QuickCutStartRequest;
    const task = await startQuickCutTask(user.id, id, request);
    return NextResponse.json({ started: true, task: await toPublicQuickCutTask(task) }, { status: 202 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "启动流光快剪失败" }, { status: 500 });
  }
}

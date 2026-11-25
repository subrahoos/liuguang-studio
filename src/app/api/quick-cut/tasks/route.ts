import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { createQuickCutTask, listQuickCutTasks, toPublicQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const tasks = await listQuickCutTasks(user.id);
    return NextResponse.json({ tasks: await Promise.all(tasks.map(toPublicQuickCutTask)) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取流光快剪任务失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const task = await createQuickCutTask(user.id, String(body.name || "流光快剪"));
    return NextResponse.json({ task: await toPublicQuickCutTask(task) }, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "创建流光快剪任务失败" }, { status: 500 });
  }
}

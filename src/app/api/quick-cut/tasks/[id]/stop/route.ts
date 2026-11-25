import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { stopQuickCutTask } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    const stopping = await stopQuickCutTask(user.id, id);
    return NextResponse.json({ stopping });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "停止流光快剪失败" }, { status: 500 });
  }
}

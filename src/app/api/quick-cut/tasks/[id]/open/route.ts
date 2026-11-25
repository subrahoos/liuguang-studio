import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireUser } from "@/lib/auth";
import { openQuickCutOutput } from "@/lib/quick-cut";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    await openQuickCutOutput(user.id, id);
    return NextResponse.json({ opened: true });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "打开输出目录失败" }, { status: 500 });
  }
}

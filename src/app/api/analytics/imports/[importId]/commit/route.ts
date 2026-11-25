import { NextRequest, NextResponse } from "next/server";
import { commitAnalyticsImport } from "@/lib/analytics/service";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ importId: string }> }) {
  try {
    const user = await requireUser(req);
    const { importId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const batch = await commitAnalyticsImport(importId, user, {
      snapshotDate: typeof body.snapshotDate === "string" ? body.snapshotDate : null,
      maturityDays: typeof body.maturityDays === "number" ? body.maturityDays : null,
    });
    return NextResponse.json({ import: batch, message: "预检批次已确认并正式导入。" });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "批次确认失败" }, { status: 400 });
  }
}

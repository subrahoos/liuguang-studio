import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsAuditLog } from "@/lib/analytics/service";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
    return NextResponse.json({ logs: await getAnalyticsAuditLog(user, limit) });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "审计日志读取失败" }, { status: 403 });
  }
}

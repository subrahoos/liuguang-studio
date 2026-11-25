import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsOrderTrace } from "@/lib/analytics/service";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const importId = req.nextUrl.searchParams.get("importId")?.trim() ?? "";
    const query = req.nextUrl.searchParams.get("query")?.trim() ?? "";
    if (!importId) return NextResponse.json({ error: "缺少导入批次" }, { status: 400 });
    return NextResponse.json(await getAnalyticsOrderTrace({ importId, user, query }));
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "原始行追溯失败" }, { status: 400 });
  }
}

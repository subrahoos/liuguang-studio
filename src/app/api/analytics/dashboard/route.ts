import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsDashboard, resolveAnalyticsOwnerIds } from "@/lib/analytics/service";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

function validDate(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const ownerIds = await resolveAnalyticsOwnerIds(user, req.nextUrl.searchParams.get("ownerId"));
    const storeNames = req.nextUrl.searchParams.getAll("store").map((value) => value.trim()).filter(Boolean);
    const dashboard = await getAnalyticsDashboard({
      ownerIds,
      dateFrom: validDate(req.nextUrl.searchParams.get("from")),
      dateTo: validDate(req.nextUrl.searchParams.get("to")),
      storeNames,
      baselineImportId: req.nextUrl.searchParams.get("compareFrom")?.trim() || null,
      targetImportId: req.nextUrl.searchParams.get("compareTo")?.trim() || null,
      forceRefresh: req.nextUrl.searchParams.get("refresh") === "1",
    });
    return NextResponse.json(dashboard);
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "经营复盘读取失败" }, { status: 400 });
  }
}

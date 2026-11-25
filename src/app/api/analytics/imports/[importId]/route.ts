import { NextRequest, NextResponse } from "next/server";
import { deleteAnalyticsImport, getAnalyticsImportStatus } from "@/lib/analytics/service";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ importId: string }> }) {
  try {
    const user = await requireUser(req);
    const { importId } = await context.params;
    return NextResponse.json({ import: await getAnalyticsImportStatus(importId, user) });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "批次状态读取失败" }, { status: 404 });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ importId: string }> }) {
  try {
    const user = await requireUser(req);
    const { importId } = await context.params;
    return NextResponse.json({ deleted: await deleteAnalyticsImport(importId, user) });
  } catch (error) {
    const authResponse = handleAuthRouteError(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : "利润表删除失败" }, { status: 400 });
  }
}

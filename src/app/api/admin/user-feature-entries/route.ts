import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import {
  listUserFeatureEntries,
  setUserFeatureEntry,
} from "@/lib/workspace-feature-entries";
import { isWorkspaceModuleId, type WorkspaceFeatureEntryState } from "@/lib/workspace-navigation";

export const runtime = "nodejs";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "FEATURE_ENTRY_USER_NOT_FOUND") {
    return noStore(NextResponse.json({ error: "普通用户不存在或已停用。" }, { status: 404 }));
  }
  return noStore(NextResponse.json({ error: "用户功能入口操作失败" }, { status: 500 }));
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const userId = req.nextUrl.searchParams.get("userId")?.trim() || "";
    if (!userId) return noStore(NextResponse.json({ error: "缺少用户" }, { status: 400 }));
    return noStore(NextResponse.json({ entries: await listUserFeatureEntries(userId) }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const featureKey = typeof body.featureKey === "string" ? body.featureKey.trim() : "";
    const entryState = body.entryState as WorkspaceFeatureEntryState | undefined;
    if (!userId || !isWorkspaceModuleId(featureKey) || (entryState !== "open" && entryState !== "waiting")) {
      return noStore(NextResponse.json({ error: "用户、功能和入口状态不合法" }, { status: 400 }));
    }
    return noStore(NextResponse.json({
      ok: true,
      entries: await setUserFeatureEntry(userId, featureKey, entryState),
    }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import { listModelApiCalls, type ModelApiCallStatus, type ModelApiCallType } from "@/lib/model-api-audit";

export const runtime = "nodejs";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]) {
  return value && allowed.includes(value as T) ? value as T : undefined;
}

function dateValue(value: string | null, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const params = req.nextUrl.searchParams;
    const userId = params.get("userId")?.trim() || undefined;
    const callType = oneOf(params.get("type"), ["llm", "image", "video"] as const) as ModelApiCallType | undefined;
    const status = oneOf(params.get("status"), ["success", "error"] as const) as ModelApiCallStatus | undefined;
    const channelId = params.get("channelId")?.trim() || undefined;
    const limit = boundedInteger(params.get("limit"), 50, 1, 100);
    const offset = boundedInteger(params.get("offset"), 0, 0, 10_000);
    const logs = await listModelApiCalls({
      userId,
      callType,
      status,
      channelId,
      from: dateValue(params.get("from")),
      to: dateValue(params.get("to"), true),
      limit,
      offset,
    });
    return noStore(NextResponse.json({ logs, limit, offset }));
  } catch (error) {
    return noStore(handleAuthRouteError(error) ?? NextResponse.json({ error: "读取模型 API 调用记录失败" }, { status: 500 }));
  }
}

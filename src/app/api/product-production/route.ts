import { NextRequest, NextResponse } from "next/server";
import { createProductProductionTask, listProductProductionTasks, summarizeProductProductionTask } from "@/lib/product-production";
import { getProductProductionRequestUser } from "@/lib/server/product-production-access";
import { wakeProductProductionWorker } from "@/lib/product-production-worker";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getProductProductionRequestUser(req);
  if (!user) return NextResponse.json({ error: "未登录或商品生产线尚未开放。" }, { status: 403 });
  wakeProductProductionWorker(user.id);
  const tasks = await listProductProductionTasks(user.id);
  return NextResponse.json({ tasks: tasks.map(summarizeProductProductionTask) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const user = await getProductProductionRequestUser(req);
  if (!user) return NextResponse.json({ error: "未登录或商品生产线尚未开放。" }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { name?: string; productionMode?: string };
  const productionMode = body.productionMode === "video" || body.productionMode === "detail" || body.productionMode === "both"
    ? body.productionMode
    : "both";
  try {
    return NextResponse.json({ task: await createProductProductionTask(user.id, body.name, productionMode) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "新建任务失败，请刷新后重试；若仍失败，请检查 3100 服务状态。" }, { status: 500 });
  }
}

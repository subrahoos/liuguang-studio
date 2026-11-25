import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { retryFailedProductProduction } from "@/lib/product-production-worker";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  const body = await req.json().catch(() => ({})) as { confirmUncertain?: boolean; includeProductMaster?: boolean; jobId?: string };
  try {
    return NextResponse.json({ task: await retryFailedProductProduction(id, access.user.id, {
      includeUncertain: body.confirmUncertain === true,
      includeProductMaster: body.confirmUncertain === true && body.includeProductMaster === true,
      jobId: typeof body.jobId === "string" ? body.jobId : undefined,
    }) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "重试失败。" }, { status: 400 });
  }
}

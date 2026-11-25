import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { duplicateProductProductionTask } from "@/lib/product-production";

export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  try {
    return NextResponse.json({ task: await duplicateProductProductionTask(access.user.id, id) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "新建批次失败。" }, { status: 400 });
  }
}

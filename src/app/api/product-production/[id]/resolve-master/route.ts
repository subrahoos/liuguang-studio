import { NextRequest, NextResponse } from "next/server";
import { getOwnedProductProductionAccess } from "@/lib/server/product-production-access";
import { resolveUncertainProductMasterWithUpload } from "@/lib/product-production-worker";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedProductProductionAccess(req, id);
  if (!access) return NextResponse.json({ error: "任务不存在或无权访问。" }, { status: 404 });
  try { return NextResponse.json({ task: await resolveUncertainProductMasterWithUpload(id, access.user.id) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法核实白底图。" }, { status: 400 }); }
}

import { NextRequest, NextResponse } from "next/server";
import { resetIdentityCalibrationReferences } from "@/lib/identity-pack";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const pack = await resetIdentityCalibrationReferences(user.id, String(body.packId || ""));
    return NextResponse.json({ pack, message: "已将该人物包的历史校准图归档，来源图已保留。" });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "归档人物包校准图失败" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createBoardWorkflow, listBoardWorkflows } from "@/lib/board-workflows";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    return NextResponse.json({ workflows: await listBoardWorkflows(user.id) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取画板工作流失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const workflow = await createBoardWorkflow({
      name: String(body.name || "画板工作流"),
      description: String(body.description || ""),
      ownerId: user.id,
    });
    return NextResponse.json({ workflow });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "创建画板工作流失败" },
      { status: 500 }
    );
  }
}

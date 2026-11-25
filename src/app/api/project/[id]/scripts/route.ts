import { getOwnedProjectAccess } from "@/lib/server/resource-access";
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { scripts } from "@/lib/db/schema";
import { resolveProjectVersion, versionIdFromRequest } from "@/lib/project-versions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });

  try {
    const db = getDb();
    const { version } = await resolveProjectVersion(id, versionIdFromRequest(req));
    if (!version) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    const result = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.projectId, id), eq(scripts.versionId, version.id)))
      .orderBy(asc(scripts.version));

    return NextResponse.json(result);
  } catch (error) {
    console.error("鑾峰彇椤圭洰鑴氭湰澶辫触:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "鑾峰彇椤圭洰鑴氭湰澶辫触" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
    const access = await getOwnedProjectAccess(req, id);
  if (!access) return NextResponse.json({ error: "项目不存在或无权访问" }, { status: 404 });
  const { selectedScriptId, versionId } = await req.json();

  if (!selectedScriptId) {
    return NextResponse.json({ error: "缺少 selectedScriptId" }, { status: 400 });
  }

  try {
    const db = getDb();
    const { version } = await resolveProjectVersion(id, typeof versionId === "string" ? versionId : null);
    if (!version) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    await db
      .update(scripts)
      .set({ selected: false })
      .where(and(eq(scripts.projectId, id), eq(scripts.versionId, version.id)));
    await db
      .update(scripts)
      .set({ selected: true })
      .where(and(eq(scripts.projectId, id), eq(scripts.versionId, version.id), eq(scripts.id, selectedScriptId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("鏇存柊閫変腑鑴氭湰澶辫触:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "鏇存柊閫変腑鑴氭湰澶辫触" },
      { status: 500 }
    );
  }
}

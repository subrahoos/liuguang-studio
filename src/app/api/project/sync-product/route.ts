import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth";

function buildSyncedProjectName(project: typeof projects.$inferSelect, productName: string) {
  if (project.sourceType === "clone" || project.name.endsWith("高相似复刻")) {
    return `${productName} 高相似复刻`;
  }
  if (project.name.endsWith("推广")) {
    return `${productName} 推广`;
  }
  return project.name;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const body = await req.json();
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    const productName = typeof body.productName === "string" ? body.productName.trim() : "";

    if (!productId || !productName) {
      return NextResponse.json({ error: "缺少商品 ID 或商品名称" }, { status: 400 });
    }

    const db = getDb();
    const linkedProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.productId, productId), eq(projects.ownerId, user.id)));

    for (const project of linkedProjects) {
      await db
        .update(projects)
        .set({
          name: buildSyncedProjectName(project, productName),
          productName,
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, project.id), eq(projects.ownerId, user.id)));
    }

    return NextResponse.json({ success: true, updatedCount: linkedProjects.length });
  } catch (error) {
    console.error("同步商品到项目失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "同步商品到项目失败" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authSessions, authUsers } from "@/lib/db/schema";
import { ADMIN_USER_ID } from "@/lib/auth-constants";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (id === ADMIN_USER_ID && body.disabled === true) {
      return NextResponse.json({ error: "不能禁用初始管理员账号" }, { status: 400 });
    }
    const user = getDb().transaction((tx) => {
      const updated = tx
      .update(authUsers)
      .set({
        disabled: typeof body.disabled === "boolean" ? body.disabled : undefined,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, id))
      .returning().get();
      if (updated && body.disabled === true) tx.delete(authSessions).where(eq(authSessions.userId, id)).run();
      return updated;
    });
    if (!user) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    const safeUser = Object.fromEntries(
      Object.entries(user).filter(([key]) => key !== "passwordHash"),
    );
    return NextResponse.json({ user: safeUser });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "更新用户失败" }, { status: 500 });
  }
}

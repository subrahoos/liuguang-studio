import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authUsers } from "@/lib/db/schema";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const users = await getDb()
      .select({
        id: authUsers.id,
        accountId: authUsers.accountId,
        username: authUsers.username,
        role: authUsers.role,
        disabled: authUsers.disabled,
        createdAt: authUsers.createdAt,
        lastLoginAt: authUsers.lastLoginAt,
      })
      .from(authUsers)
      .orderBy(asc(authUsers.accountId));
    return NextResponse.json({ users });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取用户失败" }, { status: 500 });
  }
}

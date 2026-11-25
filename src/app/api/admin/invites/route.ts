import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authInvites } from "@/lib/db/schema";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import { hashInviteCode, randomToken } from "@/lib/auth-crypto";

export const runtime = "nodejs";

function invitePayload(invite: typeof authInvites.$inferSelect) {
  return {
    id: invite.id,
    label: invite.label,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    usedByUserId: invite.usedByUserId,
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const invites = await getDb()
      .select({
        id: authInvites.id,
        label: authInvites.label,
        createdAt: authInvites.createdAt,
        expiresAt: authInvites.expiresAt,
        usedAt: authInvites.usedAt,
        usedByUserId: authInvites.usedByUserId,
      })
      .from(authInvites)
      .orderBy(desc(authInvites.createdAt));
    return NextResponse.json({ invites });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取邀请码失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim().toUpperCase() || `LUMA-${randomToken(9).toUpperCase()}`;
    const days = Number.isFinite(Number(body.days)) ? Math.max(1, Math.min(365, Number(body.days))) : 30;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const [invite] = await getDb()
      .insert(authInvites)
      .values({
        id: crypto.randomUUID(),
        codeHash: hashInviteCode(code),
        label: String(body.label || "").trim() || null,
        createdByUserId: admin.id,
        expiresAt,
      })
      .returning();
    return NextResponse.json({ invite: invitePayload(invite), code });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "生成邀请码失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    if (!id) return NextResponse.json({ error: "缺少邀请码记录 ID" }, { status: 400 });

    const [deletedInvite] = await getDb()
      .delete(authInvites)
      .where(eq(authInvites.id, id))
      .returning({ id: authInvites.id });
    if (!deletedInvite) return NextResponse.json({ error: "邀请码记录不存在" }, { status: 404 });

    return NextResponse.json({ deletedId: deletedInvite.id });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "删除邀请码失败" }, { status: 500 });
  }
}

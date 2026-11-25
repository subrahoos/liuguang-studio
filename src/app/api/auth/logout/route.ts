import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { clearSessionCookie, getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { authSessions } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (user) {
    await getDb().delete(authSessions).where(eq(authSessions.userId, user.id));
  }
  return clearSessionCookie(NextResponse.json({ ok: true }));
}

import { NextRequest, NextResponse } from "next/server";
import { createSessionResponse, registerInvitedUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const user = await registerInvitedUser({
      username: String(body.username || ""),
      password: String(body.password || ""),
      inviteCode: String(body.inviteCode || ""),
    });
    return createSessionResponse(user.id, { user });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "注册失败" },
      { status: 400 }
    );
  }
}

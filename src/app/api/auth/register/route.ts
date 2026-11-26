import { NextRequest, NextResponse } from "next/server";
import { createSessionResponse, registerInvitedUser } from "@/lib/auth";
import { consumeAuthAttempt } from "@/lib/server/login-rate-limit";
import { trustedClientIp } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const limit = consumeAuthAttempt("register", trustedClientIp(req), String(body.inviteCode || "").slice(0, 256));
  if (!limit.allowed) return NextResponse.json({ error: "注册尝试过多，请稍后再试" }, {
    status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) },
  });
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

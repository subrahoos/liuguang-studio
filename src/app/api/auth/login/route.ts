import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, createSessionResponse } from "@/lib/auth";
import { canAttemptLogin, clearFailedLogins, loginAttemptKey, recordFailedLogin } from "@/lib/server/login-rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const identity = String(body.username || body.identity || "").trim();
  const password = String(body.password || "");

  if (!identity || !password) {
    return NextResponse.json({ error: "请输入用户名或账户 ID 和密码" }, { status: 400 });
  }

  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  const clientIp = forwardedFor.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  const attemptKey = loginAttemptKey(clientIp, identity);
  const limit = canAttemptLogin(attemptKey);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "登录尝试过多，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const user = await authenticateUser(identity, password);
  if (!user) {
    recordFailedLogin(attemptKey);
    return NextResponse.json({ error: "用户名、账户 ID 或密码不正确" }, { status: 401 });
  }

  clearFailedLogins(attemptKey);
  return createSessionResponse(user.id, {
    user: {
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      role: user.role,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import {
  listUserCredentialStates,
  replaceUserChannelCredential,
  revealUserChannelCredential,
} from "@/lib/model-pool";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "MODEL_CHANNEL_NOT_FOUND") return NextResponse.json({ error: "模型通道不存在" }, { status: 404 });
  if (code === "MODEL_CREDENTIAL_USER_NOT_FOUND") return NextResponse.json({ error: "账户不存在或已禁用。" }, { status: 404 });
  if (code === "MODEL_CREDENTIAL_ENCRYPTION_KEY_MISSING") {
    return NextResponse.json({ error: "未配置 LUMA_CREDENTIAL_ENCRYPTION_KEY，无法迁移或保存用户 Key" }, { status: 503 });
  }
  if (code === "MODEL_CREDENTIAL_ENCRYPTION_KEY_INVALID") {
    return NextResponse.json({ error: "LUMA_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值" }, { status: 503 });
  }
  return NextResponse.json({ error: "用户通道凭证操作失败" }, { status: 500 });
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const userId = req.nextUrl.searchParams.get("userId")?.trim() || "";
    if (!userId) return NextResponse.json({ error: "缺少用户" }, { status: 400 });
    const revealChannelId = req.nextUrl.searchParams.get("revealChannelId")?.trim() || "";
    if (revealChannelId) {
      const apiKey = await revealUserChannelCredential(userId, revealChannelId);
      return noStore(NextResponse.json({ channelId: revealChannelId, apiKey }));
    }
    return noStore(NextResponse.json({ credentials: await listUserCredentialStates(userId) }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!userId || !channelId || typeof body.apiKey !== "string") {
      return NextResponse.json({ error: "用户、通道和 Key 均为必填项" }, { status: 400 });
    }
    await replaceUserChannelCredential(userId, channelId, body.apiKey);
    return noStore(NextResponse.json({ ok: true, credentials: await listUserCredentialStates(userId) }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!userId || !channelId) return NextResponse.json({ error: "缺少用户或通道" }, { status: 400 });
    await replaceUserChannelCredential(userId, channelId, "");
    return noStore(NextResponse.json({ ok: true, credentials: await listUserCredentialStates(userId) }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

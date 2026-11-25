import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, requireAdmin } from "@/lib/auth";
import {
  clearUserVideoReferenceHostingCredentials,
  getUserVideoReferenceHostingCredentialState,
  replaceUserVideoReferenceHostingCredentials,
  revealUserVideoReferenceHostingCredential,
  type HostingCredentialField,
} from "@/lib/user-video-reference-hosting-credentials";

export const runtime = "nodejs";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function errorResponse(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "HOSTING_CREDENTIAL_USER_NOT_FOUND") {
    return NextResponse.json({ error: "普通用户不存在或已禁用" }, { status: 404 });
  }
  if (code === "HOSTING_CREDENTIAL_VALUE_REQUIRED") {
    return NextResponse.json({ error: "至少填写一个要更新的凭证字段" }, { status: 400 });
  }
  if (code === "HOSTING_CREDENTIAL_PAIR_REQUIRED") {
    return NextResponse.json({ error: "首次配置必须同时填写 API Key 和 API Secret" }, { status: 400 });
  }
  if (code === "MODEL_CREDENTIAL_ENCRYPTION_KEY_MISSING") {
    return NextResponse.json({ error: "未配置 LUMA_CREDENTIAL_ENCRYPTION_KEY，无法保存用户公网托管凭证" }, { status: 503 });
  }
  if (code === "MODEL_CREDENTIAL_ENCRYPTION_KEY_INVALID") {
    return NextResponse.json({ error: "LUMA_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值" }, { status: 503 });
  }
  return NextResponse.json({ error: "用户公网托管凭证操作失败" }, { status: 500 });
}

function targetUserId(value: string | null) {
  return value?.trim() || "";
}

function hostingField(value: string | null): HostingCredentialField | null {
  return value === "apiKey" || value === "apiSecret" ? value : null;
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const userId = targetUserId(req.nextUrl.searchParams.get("userId"));
    if (!userId) return NextResponse.json({ error: "缺少普通用户" }, { status: 400 });
    const revealFieldValue = req.nextUrl.searchParams.get("revealField");
    if (revealFieldValue) {
      const field = hostingField(revealFieldValue);
      if (!field) return NextResponse.json({ error: "不支持的公网托管凭证字段" }, { status: 400 });
      return noStore(NextResponse.json({ field, value: await revealUserVideoReferenceHostingCredential(userId, field) }));
    }
    return noStore(NextResponse.json({ credential: await getUserVideoReferenceHostingCredentialState(userId) }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) return NextResponse.json({ error: "缺少普通用户" }, { status: 400 });
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
    const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : undefined;
    return noStore(NextResponse.json({
      credential: await replaceUserVideoReferenceHostingCredentials(userId, { apiKey, apiSecret }),
    }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) return NextResponse.json({ error: "缺少普通用户" }, { status: 400 });
    await clearUserVideoReferenceHostingCredentials(userId);
    return noStore(NextResponse.json({ ok: true }));
  } catch (error) {
    return handleAuthRouteError(error) ?? errorResponse(error);
  }
}

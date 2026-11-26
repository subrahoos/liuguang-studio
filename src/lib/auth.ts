import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authInvites, authSessions, authUsers, userModelSettings } from "@/lib/db/schema";
import { hashInviteCode, hashPassword, hashToken, randomToken, verifyPassword } from "@/lib/auth-crypto";
import type { LLMSetting, ProviderSetting } from "@/lib/stores/settings-store";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";
import { AUTH_COOKIE_NAME, AUTH_SESSION_MS, SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";
import { unsafeRequestReason } from "@/lib/request-security";
export { AUTH_COOKIE_NAME, AUTH_SESSION_MS, SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";

export type AuthUser = {
  id: string;
  accountId: string;
  username: string;
  role: "admin" | "user";
  disabled: boolean | null;
};

export type UserModelSettingsValue = {
  providers: Record<string, ProviderSetting>;
  llm: LLMSetting;
  videoReferenceHosting?: VideoReferenceHostingSetting;
};

function shouldUseSecureCookies() {
  return process.env.LUMA_SECURE_COOKIES === "1";
}

export function authError(message = "未登录", status = 401) {
  return NextResponse.json({ error: message }, { status });
}

export function isAdmin(user: AuthUser | null | undefined) {
  return user?.role === "admin";
}

export async function getSessionUser(req: NextRequest): Promise<AuthUser | null> {
  if (unsafeRequestReason(req)) return null;
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token || token.length > 256) return null;

  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: authUsers.id,
      accountId: authUsers.accountId,
      username: authUsers.username,
      role: authUsers.role,
      disabled: authUsers.disabled,
    })
    .from(authSessions)
    .innerJoin(authUsers, eq(authSessions.userId, authUsers.id))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), sql`${authSessions.expiresAt} > ${nowSeconds}`))
    .limit(1);

  const user = rows[0] as AuthUser | undefined;
  if (!user || user.disabled) return null;
  return user;
}

export async function requireUser(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) throw new Error("AUTH_REQUIRED");
  return user;
}

export async function requireAdmin(req: NextRequest) {
  const user = await requireUser(req);
  if (!isAdmin(user)) throw new Error("ADMIN_REQUIRED");
  return user;
}

export function handleAuthRouteError(error: unknown) {
  if (error instanceof Error && error.message === "AUTH_REQUIRED") return authError();
  if (error instanceof Error && error.message === "ADMIN_REQUIRED") return authError("需要管理员权限", 403);
  if (error instanceof Error && error.message === "HOST_DESKTOP_REQUIRED") return authError("服务器本地文件选择和桌面操作仅限管理员；请使用浏览器上传或下载。", 403);
  return null;
}

export async function createSessionResponse(userId: string, body: unknown) {
  const db = getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_MS);
  await db.insert(authSessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const response = NextResponse.json(body);
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    expires: expiresAt,
  });
  return response;
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: "/",
    expires: new Date(0),
  });
  return response;
}

export async function authenticateUser(identity: string, password: string) {
  if (!identity || identity.length > 64 || !password || password.length > 256) return null;
  const db = getDb();
  const credential = identity.trim();
  const [user] = await db
    .select()
    .from(authUsers)
    .where(or(
      sql`lower(${authUsers.username}) = lower(${credential})`,
      eq(authUsers.accountId, credential.toUpperCase())
    ))
    .limit(1);
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) return null;
  await db.update(authUsers).set({ lastLoginAt: new Date() }).where(eq(authUsers.id, user.id));
  return user;
}

export async function generateAccountId() {
  const db = getDb();
  const result = await db.select({ accountId: authUsers.accountId }).from(authUsers);
  const max = result.reduce((current, item) => {
    const match = item.accountId.match(/^LUMA-(\d+)$/);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `LUMA-${String(max + 1).padStart(6, "0")}`;
}

export async function registerInvitedUser(input: { username: string; password: string; inviteCode: string }) {
  const username = input.username.trim();
  const password = input.password;
  if (!input.inviteCode || input.inviteCode.length > 256) throw new Error("邀请码无效或已使用");
  const codeHash = hashInviteCode(input.inviteCode);
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,32}$/.test(username)) {
    throw new Error("用户名需为 2-32 位中文、英文、数字、下划线或连字符");
  }
  if (password.length < 6 || password.length > 256) throw new Error("密码需为 6-256 位");

  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [existing] = await db
    .select()
    .from(authUsers)
    .where(sql`lower(${authUsers.username}) = lower(${username})`)
    .limit(1);
  if (existing) throw new Error("用户名已存在");

  const [invite] = await db
    .select()
    .from(authInvites)
    .where(and(eq(authInvites.codeHash, codeHash), isNull(authInvites.usedAt), sql`${authInvites.expiresAt} > ${nowSeconds}`))
    .limit(1);
  if (!invite) throw new Error("邀请码无效或已使用");

  const passwordHash = hashPassword(password);
  return db.transaction((tx) => {
    const available = tx.select().from(authInvites).where(and(
      eq(authInvites.id, invite.id), isNull(authInvites.usedAt),
      sql`${authInvites.expiresAt} > ${Math.floor(Date.now() / 1000)}`,
    )).get();
    if (!available) throw new Error("邀请码无效或已使用");
    const usedName = tx.select({ id: authUsers.id }).from(authUsers)
      .where(sql`lower(${authUsers.username}) = lower(${username})`).get();
    if (usedName) throw new Error("用户名已存在");
    const max = tx.select({ accountId: authUsers.accountId }).from(authUsers).all()
      .reduce((value, item) => Math.max(value, Number(item.accountId.match(/^LUMA-(\d+)$/)?.[1]) || 0), 0);
    const id = crypto.randomUUID();
    const accountId = `LUMA-${String(max + 1).padStart(6, "0")}`;
    tx.insert(authUsers).values({ id, accountId, username, passwordHash, role: "user", disabled: false }).run();
    const claimed = tx.update(authInvites).set({ usedAt: new Date(), usedByUserId: id })
      .where(and(eq(authInvites.id, invite.id), isNull(authInvites.usedAt))).run();
    if (claimed.changes !== 1) throw new Error("邀请码无效或已使用");
    return { id, accountId, username, role: "user" as const, disabled: false };
  }, { behavior: "immediate" });
}

export function maskModelSettings(settings: UserModelSettingsValue, revealSecrets: boolean): UserModelSettingsValue {
  const maskProvider = (provider: ProviderSetting): ProviderSetting => ({
    ...provider,
    apiKey: provider.apiKey ? SERVER_MANAGED_API_KEY : "",
    imageApiKey: provider.imageApiKey ? SERVER_MANAGED_API_KEY : "",
    videoApiKey: provider.videoApiKey ? SERVER_MANAGED_API_KEY : "",
    imageChannels: provider.imageChannels?.map((channel) => ({
      ...channel,
      apiKey: channel.apiKey ? SERVER_MANAGED_API_KEY : "",
    })),
    videoChannels: provider.videoChannels?.map((channel) => ({
      ...channel,
      apiKey: channel.apiKey ? SERVER_MANAGED_API_KEY : "",
    })),
  });
  const modelSettings = revealSecrets
    ? { llm: settings.llm, providers: settings.providers }
    : {
        llm: {
          ...settings.llm,
          apiKey: settings.llm.apiKey ? SERVER_MANAGED_API_KEY : "",
        },
        providers: Object.fromEntries(Object.entries(settings.providers).map(([key, provider]) => [key, maskProvider(provider)])),
      };
  return {
    ...modelSettings,
    videoReferenceHosting: settings.videoReferenceHosting
      ? {
          ...settings.videoReferenceHosting,
          apiKey: settings.videoReferenceHosting.apiKey ? SERVER_MANAGED_API_KEY : "",
          apiSecret: settings.videoReferenceHosting.apiSecret ? SERVER_MANAGED_API_KEY : "",
        }
      : undefined,
  };
}

export async function getUserModelSettings(userId: string): Promise<UserModelSettingsValue | null> {
  const db = getDb();
  const [row] = await db.select().from(userModelSettings).where(eq(userModelSettings.userId, userId)).limit(1);
  return (row?.settings as unknown as UserModelSettingsValue | null) ?? null;
}

export async function upsertUserModelSettings(userId: string, settings: UserModelSettingsValue) {
  const db = getDb();
  const jsonSettings = settings as unknown as {
    providers: Record<string, unknown>;
    llm: Record<string, unknown>;
    videoReferenceHosting?: Record<string, unknown>;
  };
  const [existing] = await db.select({ userId: userModelSettings.userId }).from(userModelSettings).where(eq(userModelSettings.userId, userId)).limit(1);
  if (existing) {
    await db.update(userModelSettings).set({ settings: jsonSettings, updatedAt: new Date() }).where(eq(userModelSettings.userId, userId));
  } else {
    await db.insert(userModelSettings).values({ userId, settings: jsonSettings, updatedAt: new Date() });
  }
}

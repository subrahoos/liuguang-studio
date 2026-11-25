import { NextRequest, NextResponse } from "next/server";
import { handleAuthRouteError, isAdmin, requireUser, getUserModelSettings, upsertUserModelSettings } from "@/lib/auth";
import { mergeVideoReferenceHostingSetting } from "@/lib/cloudinary-video-reference-hosting";
import {
  getGlobalModelSettings,
  replaceGlobalVideoReferenceHostingCredentials,
  resolveGlobalVideoReferenceHostingCredentials,
  saveGlobalModelSettings,
  type GlobalModelSettings,
} from "@/lib/model-pool";

export const runtime = "nodejs";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const revealHostingCredential = req.nextUrl.searchParams.get("revealHostingCredential")?.trim() || "";
    if (revealHostingCredential) {
      if (revealHostingCredential !== "apiKey" && revealHostingCredential !== "apiSecret") {
        return NextResponse.json({ error: "不支持的公网托管凭证字段" }, { status: 400 });
      }
      const credentials = await resolveGlobalVideoReferenceHostingCredentials();
      const value = credentials?.[revealHostingCredential] || "";
      return noStore(NextResponse.json({ field: revealHostingCredential, value }));
    }
    const settings = await getGlobalModelSettings();
    return NextResponse.json({
      settings,
      canManage: true,
    });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取模型配置失败" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (!body.settings?.providers || !body.settings?.llm) {
      return NextResponse.json({ error: "模型配置不完整" }, { status: 400 });
    }
    const incoming = body.settings as GlobalModelSettings;
    await saveGlobalModelSettings(incoming, user.id);
    if (incoming.videoReferenceHosting) {
      const existing = await getUserModelSettings(user.id);
      const existingCredentials = await resolveGlobalVideoReferenceHostingCredentials();
      const existingHosting = existing?.videoReferenceHosting
        ? { ...existing.videoReferenceHosting, ...existingCredentials }
        : undefined;
      const mergedHosting = mergeVideoReferenceHostingSetting(
        incoming.videoReferenceHosting,
        existingHosting,
      );
      if (mergedHosting?.apiKey || mergedHosting?.apiSecret) {
        await replaceGlobalVideoReferenceHostingCredentials({
          apiKey: mergedHosting.apiKey,
          apiSecret: mergedHosting.apiSecret,
        });
      }
      await upsertUserModelSettings(user.id, {
        providers: existing?.providers ?? {},
        llm: existing?.llm ?? { provider: "", baseUrl: "", apiKey: "", model: "" },
        videoReferenceHosting: mergedHosting
          ? { ...mergedHosting, apiKey: "", apiSecret: "" }
          : undefined,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "保存模型配置失败" }, { status: 500 });
  }
}

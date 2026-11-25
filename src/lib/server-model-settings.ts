import { NextRequest } from "next/server";
import {
  getSessionUser,
} from "@/lib/auth";
import {
  type ImageModelChannel,
  type LLMSetting,
  type ProviderSetting,
  type VideoModelChannel,
  type VideoTaskType,
} from "@/lib/stores/settings-store";
import {
  getGlobalModelSettings,
  resolveGlobalImageChannel,
  resolveGlobalLLMSetting,
  resolveGlobalVideoChannel,
  resolveGlobalVideoReferenceHosting,
  resolveGlobalVideoReferenceHostingCredentials,
} from "@/lib/model-pool";
import { resolveUserVideoReferenceHostingCredentials } from "@/lib/user-video-reference-hosting-credentials";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";

export async function currentModelSettings(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return null;
  return getGlobalModelSettings();
}

export async function resolveLLMSetting(req: NextRequest, _incoming?: Partial<LLMSetting> | null): Promise<LLMSetting | null> {
  void _incoming;
  const user = await getSessionUser(req);
  if (!user) return null;
  return resolveGlobalLLMSetting(user.id);
}

export async function resolveProviderSetting(req: NextRequest, providerKey = "openai-seedance"): Promise<ProviderSetting | null> {
  const settings = await currentModelSettings(req);
  return settings?.providers?.[providerKey] ?? null;
}

export async function resolveVideoReferenceHosting(
  req: NextRequest,
): Promise<VideoReferenceHostingSetting | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  const globalSetting = await resolveGlobalVideoReferenceHosting();
  if (!globalSetting) return null;
  const credentials = user.role === "admin"
    ? await resolveGlobalVideoReferenceHostingCredentials()
    : await resolveUserVideoReferenceHostingCredentials(user.id);
  if (!credentials) return null;
  return {
    ...globalSetting,
    ...credentials,
  };
}

export async function resolveImageChannel(
  req: NextRequest,
  _incoming?: Partial<ImageModelChannel> | null,
  channelId?: string
): Promise<ImageModelChannel | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  return resolveGlobalImageChannel(user.id, channelId);
}

export async function resolveVideoChannel(
  req: NextRequest,
  _incoming?: Partial<VideoModelChannel> | null,
  channelId?: string,
  taskType?: VideoTaskType
): Promise<VideoModelChannel | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  return resolveGlobalVideoChannel(user.id, channelId, taskType);
}

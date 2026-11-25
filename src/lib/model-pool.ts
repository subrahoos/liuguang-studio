import { and, asc, eq } from "drizzle-orm";
import { ADMIN_USER_ID, SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";
import { getDb } from "@/lib/db";
import {
  authUsers,
  modelChannels,
  userModelCredentials,
  userModelSettings,
  userVideoReferenceHostingCredentials,
} from "@/lib/db/schema";
import type { DirectVideoReplacementPromptVersion } from "@/lib/board-video-protocol";
import { decryptModelCredential, encryptModelCredential } from "@/lib/model-credential-crypto";
import type {
  ImageModelChannel,
  LLMSetting,
  ProviderSetting,
  VideoModelChannel,
  VideoTaskType,
} from "@/lib/stores/settings-store";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";

type ModelChannelRow = typeof modelChannels.$inferSelect;
type LegacyModelSettings = {
  providers: Record<string, ProviderSetting>;
  llm: LLMSetting;
  videoReferenceHosting?: VideoReferenceHostingSetting;
};

export type ModelCredentialState = {
  channelId: string;
  kind: "llm" | "image" | "video";
  providerKey: string;
  name: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  updatedAt: Date | null;
};

export type GlobalModelSettings = {
  providers: Record<string, ProviderSetting>;
  llm: LLMSetting;
  videoReferenceHosting?: VideoReferenceHostingSetting;
};

type ChannelConfig = Record<string, unknown>;

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function arrayValue<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is T => typeof entry === "string" && allowed.includes(entry as T));
  return entries.length ? entries : undefined;
}

function uniqueChannelId(raw: unknown, fallback: string, seen: Set<string>) {
  const base = stringValue(raw).trim().replace(/[^a-zA-Z0-9_-]/g, "-") || fallback;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

function publicImageChannel(row: ModelChannelRow, apiKey = ""): ImageModelChannel {
  const config = row.config as ChannelConfig;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    apiKey,
    baseUrl: row.baseUrl,
    model: row.model,
    endpointPath: stringValue(config.endpointPath) || undefined,
    requestTimeoutMs: numberValue(config.requestTimeoutMs),
  };
}

function publicVideoChannel(row: ModelChannelRow, apiKey = ""): VideoModelChannel {
  const config = row.config as ChannelConfig;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    apiKey,
    baseUrl: row.baseUrl,
    model: row.model,
    videoProtocol: config.videoProtocol === "mikoto" || config.videoProtocol === "mikoto_sora"
      ? config.videoProtocol
      : undefined,
    taskTypes: arrayValue(config.taskTypes, ["shot_clip", "full_video"] as const),
    submitPath: stringValue(config.submitPath) || undefined,
    statusPath: stringValue(config.statusPath) || undefined,
    contentPath: stringValue(config.contentPath) || undefined,
    durationOptions: Array.isArray(config.durationOptions)
      ? config.durationOptions.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : undefined,
    maxReferenceImages: numberValue(config.maxReferenceImages),
    maxReferenceVideos: numberValue(config.maxReferenceVideos),
    maxReferenceAudios: numberValue(config.maxReferenceAudios),
    directVideoReplacementPromptLanguage: config.directVideoReplacementPromptLanguage === "zh-CN" ? "zh-CN" : "en",
    directVideoReplacementSceneOptional: config.directVideoReplacementSceneOptional === true,
    directVideoReplacementFaceOptional: config.directVideoReplacementFaceOptional === true,
    directVideoReplacementReferenceContract: config.directVideoReplacementReferenceContract === "product_front_face"
      ? "product_front_face"
      : "product_board_face_model",
    directVideoReplacementPromptVersion: config.directVideoReplacementPromptVersion === "v2" ? "v2" : "v1",
  };
}

function publicLLMSetting(row: ModelChannelRow, apiKey = ""): LLMSetting {
  const config = row.config as ChannelConfig;
  return {
    provider: row.providerKey,
    baseUrl: row.baseUrl,
    apiKey,
    model: row.model,
    visionModel: stringValue(config.visionModel) || undefined,
  };
}

async function listChannels() {
  const db = getDb();
  return db.select().from(modelChannels).orderBy(asc(modelChannels.sortOrder), asc(modelChannels.createdAt));
}

function legacyChannels(settings: LegacyModelSettings) {
  const seen = new Set<string>();
  const provider = settings.providers["openai-seedance"];
  const result: Array<{ row: Omit<typeof modelChannels.$inferInsert, "createdAt" | "updatedAt">; apiKey: string }> = [];
  const llm = settings.llm;
  if (llm?.baseUrl || llm?.model || llm?.apiKey) {
    seen.add("llm-default");
    result.push({
      row: {
        id: "llm-default",
        kind: "llm",
        providerKey: llm.provider || "openai",
        name: "LLM",
        enabled: true,
        baseUrl: llm.baseUrl || "",
        model: llm.model || "",
        config: { visionModel: llm.visionModel || "" },
        sortOrder: 0,
      },
      apiKey: llm.apiKey || "",
    });
  }

  const imageChannels = provider?.imageChannels?.length
    ? provider.imageChannels
    : provider?.imageApiKey || provider?.baseUrl
      ? [{
          id: "legacy-image",
          name: "旧版生图通道",
          enabled: provider.enabled,
          apiKey: provider.imageApiKey || provider.apiKey || "",
          baseUrl: provider.imageBaseUrl || provider.baseUrl || "",
          model: "gpt-image-2",
          endpointPath: "/images/edits",
        }]
      : [];
  imageChannels.forEach((channel, index) => {
    const id = uniqueChannelId(channel.id, `image-model-${index + 1}`, seen);
    result.push({
      row: {
        id,
        kind: "image",
        providerKey: "openai-seedance",
        name: channel.name || `生图模型 ${index + 1}`,
        enabled: channel.enabled !== false,
        baseUrl: channel.baseUrl || "",
        model: channel.model || "",
        config: {
          endpointPath: channel.endpointPath || "/images/edits",
          requestTimeoutMs: channel.requestTimeoutMs,
        },
        sortOrder: 100 + index,
      },
      apiKey: channel.apiKey || "",
    });
  });

  const videoChannels = provider?.videoChannels?.length
    ? provider.videoChannels
    : provider?.videoApiKey || provider?.baseUrl
      ? [{
          id: "legacy-video",
          name: "旧版视频通道",
          enabled: provider.enabled,
          apiKey: provider.videoApiKey || provider.apiKey || "",
          baseUrl: provider.videoBaseUrl || provider.baseUrl || "",
          model: "",
          taskTypes: ["shot_clip", "full_video"] as VideoTaskType[],
          submitPath: provider.videoSubmitPath,
          statusPath: provider.videoStatusPath,
          contentPath: provider.videoContentPath,
        }]
      : [];
  videoChannels.forEach((channel, index) => {
    const id = uniqueChannelId(channel.id, `video-model-${index + 1}`, seen);
    result.push({
      row: {
        id,
        kind: "video",
        providerKey: "openai-seedance",
        name: channel.name || `视频模型 ${index + 1}`,
        enabled: channel.enabled !== false,
        baseUrl: channel.baseUrl || "",
        model: channel.model || "",
        config: {
          taskTypes: channel.taskTypes || ["shot_clip", "full_video"],
          submitPath: channel.submitPath || "",
          statusPath: channel.statusPath || "",
          contentPath: channel.contentPath || "",
          durationOptions: channel.durationOptions || [],
          maxReferenceImages: channel.maxReferenceImages,
          maxReferenceVideos: channel.maxReferenceVideos,
          maxReferenceAudios: channel.maxReferenceAudios,
          directVideoReplacementPromptLanguage: channel.directVideoReplacementPromptLanguage || "en",
          directVideoReplacementSceneOptional: channel.directVideoReplacementSceneOptional === true,
          directVideoReplacementFaceOptional: channel.directVideoReplacementFaceOptional === true,
          directVideoReplacementReferenceContract: channel.directVideoReplacementReferenceContract === "product_front_face"
            ? "product_front_face"
            : "product_board_face_model",
          directVideoReplacementPromptVersion: channel.directVideoReplacementPromptVersion === "v2" ? "v2" : "v1",
        },
        sortOrder: 200 + index,
      },
      apiKey: channel.apiKey || "",
    });
  });

  return result;
}

function legacyCredentialForChannel(settings: LegacyModelSettings, channel: ModelChannelRow) {
  const provider = settings.providers["openai-seedance"];
  if (channel.kind === "llm") return settings.llm?.apiKey || "";
  if (channel.kind === "image") {
    const match = provider?.imageChannels?.find((item) => item.id === channel.id);
    return match?.apiKey || (channel.id === "legacy-image" ? provider?.imageApiKey || provider?.apiKey || "" : "");
  }
  const match = provider?.videoChannels?.find((item) => item.id === channel.id);
  return match?.apiKey || (channel.id === "legacy-video" ? provider?.videoApiKey || provider?.apiKey || "" : "");
}

function sanitizedLegacySettings(settings: LegacyModelSettings): LegacyModelSettings {
  const hosting = settings?.videoReferenceHosting;
  return {
    // Model channels and their credentials have moved to model_channels and
    // user_model_credentials. Do not retain a second plaintext source.
    providers: {},
    llm: { provider: "", baseUrl: "", apiKey: "", model: "", visionModel: "" },
    videoReferenceHosting: hosting
      ? {
          provider: hosting.provider,
          enabled: hosting.enabled,
          cloudName: hosting.cloudName,
          apiKey: "",
          apiSecret: "",
        }
      : undefined,
  };
}

async function migrateAndScrubLegacySettings(channels: ModelChannelRow[]) {
  const db = getDb();
  const legacyUsers = await db.select().from(userModelSettings);
  for (const userSetting of legacyUsers) {
    const legacy = userSetting.settings as unknown as LegacyModelSettings;
    if (!legacy || typeof legacy !== "object") continue;

    for (const channel of channels) {
      const apiKey = legacyCredentialForChannel(legacy, channel).trim();
      if (!apiKey) continue;
      const existing = await credentialByUserAndChannel(userSetting.userId, channel.id);
      if (existing) continue;
      await db.insert(userModelCredentials).values({
        userId: userSetting.userId,
        channelId: channel.id,
        encryptedApiKey: encryptModelCredential(apiKey),
        keyVersion: 1,
        updatedAt: new Date(),
      }).onConflictDoNothing();
    }

    if (userSetting.userId === ADMIN_USER_ID) {
      const hosting = legacy.videoReferenceHosting;
      const apiKey = typeof hosting?.apiKey === "string" ? hosting.apiKey.trim() : "";
      const apiSecret = typeof hosting?.apiSecret === "string" ? hosting.apiSecret.trim() : "";
      if (apiKey && apiSecret) {
        await db.insert(userVideoReferenceHostingCredentials).values({
          userId: ADMIN_USER_ID,
          encryptedApiKey: encryptModelCredential(apiKey),
          encryptedApiSecret: encryptModelCredential(apiSecret),
          keyVersion: 1,
          updatedAt: new Date(),
        }).onConflictDoNothing();
      }
    }

    const sanitized = sanitizedLegacySettings(legacy);
    if (JSON.stringify(sanitized) !== JSON.stringify(legacy)) {
      await db.update(userModelSettings)
        .set({ settings: sanitized as unknown as { providers: Record<string, unknown>; llm: Record<string, unknown> }, updatedAt: new Date() })
        .where(eq(userModelSettings.userId, userSetting.userId));
    }
  }
}

export async function ensureGlobalModelPool() {
  const current = await listChannels();
  if (current.length > 0) {
    await migrateAndScrubLegacySettings(current);
    return current;
  }

  const db = getDb();
  const [admin] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.role, "admin")).limit(1);
  if (!admin) return current;
  const [legacyRow] = await db.select().from(userModelSettings).where(eq(userModelSettings.userId, admin.id)).limit(1);
  const legacy = legacyRow?.settings as unknown as LegacyModelSettings | undefined;
  if (!legacy?.providers || !legacy.llm) return current;

  const migrated = legacyChannels(legacy);
  if (!migrated.length) return current;

  // Encrypt before writing anything so an unconfigured master key leaves legacy data untouched.
  const adminCredentials = migrated
    .filter((entry) => entry.apiKey.trim())
    .map((entry) => ({ channelId: entry.row.id, encryptedApiKey: encryptModelCredential(entry.apiKey) }));

  for (const entry of migrated) {
    await db.insert(modelChannels).values({ ...entry.row, updatedAt: new Date() }).onConflictDoNothing();
  }
  for (const credential of adminCredentials) {
    await db.insert(userModelCredentials).values({
      userId: admin.id,
      channelId: credential.channelId,
      encryptedApiKey: credential.encryptedApiKey,
      keyVersion: 1,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  const channels = await listChannels();
  await migrateAndScrubLegacySettings(channels);
  return listChannels();
}

async function roleForUser(userId: string) {
  const db = getDb();
  const [user] = await db.select({ role: authUsers.role, disabled: authUsers.disabled })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  return user && !user.disabled ? user.role : undefined;
}

async function assertCredentialUser(userId: string) {
  const role = await roleForUser(userId);
  if (!role) throw new Error("MODEL_CREDENTIAL_USER_NOT_FOUND");
}

async function credentialByUserAndChannel(userId: string, channelId: string) {
  const db = getDb();
  const [credential] = await db.select().from(userModelCredentials)
    .where(and(eq(userModelCredentials.userId, userId), eq(userModelCredentials.channelId, channelId)))
    .limit(1);
  return credential ?? null;
}

async function apiKeyForChannel(userId: string, channelId: string) {
  if (!await roleForUser(userId)) return "";
  const credential = await credentialByUserAndChannel(userId, channelId);
  return credential ? decryptModelCredential(credential.encryptedApiKey) : "";
}

function matchingVideoTask(row: ModelChannelRow, taskType?: VideoTaskType) {
  if (row.kind !== "video" || !taskType) return row.kind === "video";
  const taskTypes = arrayValue((row.config as ChannelConfig).taskTypes, ["shot_clip", "full_video"] as const);
  return !taskTypes?.length || taskTypes.includes(taskType);
}

export async function resolveGlobalLLMSetting(userId: string): Promise<LLMSetting | null> {
  const channels = await ensureGlobalModelPool();
  const channel = channels.find((item) => item.kind === "llm" && item.enabled);
  if (!channel) return null;
  return publicLLMSetting(channel, await apiKeyForChannel(userId, channel.id));
}

export async function resolveGlobalImageChannel(userId: string, channelId?: string): Promise<ImageModelChannel | null> {
  const channels = (await ensureGlobalModelPool()).filter((item) => item.kind === "image" && item.enabled);
  const selected = channelId ? channels.find((item) => item.id === channelId) : undefined;
  const channel = selected ?? channels[0];
  if (!channel) return null;
  return publicImageChannel(channel, await apiKeyForChannel(userId, channel.id));
}

export async function resolveGlobalVideoChannel(userId: string, channelId?: string, taskType?: VideoTaskType): Promise<VideoModelChannel | null> {
  const channels = (await ensureGlobalModelPool()).filter((item) => item.enabled && matchingVideoTask(item, taskType));
  const selected = channelId ? channels.find((item) => item.id === channelId) : undefined;
  const channel = selected ?? channels[0];
  if (!channel) return null;
  return publicVideoChannel(channel, await apiKeyForChannel(userId, channel.id));
}

function emptyGlobalSettings(): GlobalModelSettings {
  return {
    providers: { "openai-seedance": { enabled: false, apiKey: "", imageChannels: [], videoChannels: [] } },
    llm: { provider: "", baseUrl: "", apiKey: "", model: "", visionModel: "" },
  };
}

async function globalVideoReferenceHosting() {
  await ensureGlobalModelPool();
  const db = getDb();
  const [legacy] = await db.select().from(userModelSettings).where(eq(userModelSettings.userId, ADMIN_USER_ID)).limit(1);
  const setting = (legacy?.settings as unknown as LegacyModelSettings | undefined)?.videoReferenceHosting;
  if (!setting) return undefined;
  const [credential] = await db.select({ userId: userVideoReferenceHostingCredentials.userId })
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, ADMIN_USER_ID))
    .limit(1);
  return {
    ...setting,
    apiKey: credential ? SERVER_MANAGED_API_KEY : "",
    apiSecret: credential ? SERVER_MANAGED_API_KEY : "",
  };
}

export async function getGlobalModelSettings(): Promise<GlobalModelSettings> {
  const channels = await ensureGlobalModelPool();
  const result = emptyGlobalSettings();
  const llm = channels.find((item) => item.kind === "llm");
  if (llm) result.llm = publicLLMSetting(llm);
  const provider = result.providers["openai-seedance"];
  const images = channels.filter((item) => item.kind === "image");
  const videos = channels.filter((item) => item.kind === "video");
  provider.enabled = images.some((item) => item.enabled) || videos.some((item) => item.enabled);
  provider.imageChannels = images.map((item) => publicImageChannel(item));
  provider.videoChannels = videos.map((item) => publicVideoChannel(item));
  provider.activeImageChannelId = images.find((item) => item.enabled)?.id;
  provider.activeVideoChannelId = videos.find((item) => item.enabled)?.id;
  result.videoReferenceHosting = await globalVideoReferenceHosting();
  return result;
}

function incomingImageChannel(channel: ImageModelChannel, index: number, seen: Set<string>) {
  return {
    id: uniqueChannelId(channel.id, `image-model-${index + 1}`, seen),
    kind: "image" as const,
    providerKey: "openai-seedance",
    name: channel.name?.trim() || `生图模型 ${index + 1}`,
    enabled: channel.enabled !== false,
    baseUrl: channel.baseUrl?.trim() || "",
    model: channel.model?.trim() || "",
    config: {
      endpointPath: channel.endpointPath?.trim() || "/images/edits",
      requestTimeoutMs: numberValue(channel.requestTimeoutMs),
    },
    sortOrder: 100 + index,
  };
}

export function videoChannelConfigForSave(
  channel: VideoModelChannel,
  existingConfig: Record<string, unknown> = {},
) {
  const videoProtocol = channel.videoProtocol === undefined
    ? (existingConfig.videoProtocol === "mikoto" || existingConfig.videoProtocol === "mikoto_sora"
      ? existingConfig.videoProtocol
      : undefined)
    : channel.videoProtocol;
  const directVideoReplacementPromptLanguage = channel.directVideoReplacementPromptLanguage === undefined
    ? (existingConfig.directVideoReplacementPromptLanguage === "zh-CN" ? "zh-CN" : "en")
    : (channel.directVideoReplacementPromptLanguage === "zh-CN" ? "zh-CN" : "en");
  const directVideoReplacementSceneOptional = channel.directVideoReplacementSceneOptional === undefined
    ? existingConfig.directVideoReplacementSceneOptional === true
    : channel.directVideoReplacementSceneOptional === true;
  const directVideoReplacementFaceOptional = channel.directVideoReplacementFaceOptional === undefined
    ? existingConfig.directVideoReplacementFaceOptional === true
    : channel.directVideoReplacementFaceOptional === true;
  const directVideoReplacementReferenceContract = channel.directVideoReplacementReferenceContract === undefined
    ? (existingConfig.directVideoReplacementReferenceContract === "product_front_face"
      ? "product_front_face"
      : "product_board_face_model")
    : (channel.directVideoReplacementReferenceContract === "product_front_face"
      ? "product_front_face"
      : "product_board_face_model");
  const directVideoReplacementPromptVersion: DirectVideoReplacementPromptVersion = channel.directVideoReplacementPromptVersion === undefined
    ? (existingConfig.directVideoReplacementPromptVersion === "v2" ? "v2" : "v1")
    : (channel.directVideoReplacementPromptVersion === "v2" ? "v2" : "v1");
  return {
    videoProtocol,
    taskTypes: channel.taskTypes?.length ? channel.taskTypes : ["shot_clip", "full_video"],
    submitPath: channel.submitPath?.trim() || "",
    statusPath: channel.statusPath?.trim() || "",
    contentPath: channel.contentPath?.trim() || "",
    durationOptions: channel.durationOptions ?? [],
    maxReferenceImages: numberValue(channel.maxReferenceImages),
    maxReferenceVideos: numberValue(channel.maxReferenceVideos),
    maxReferenceAudios: numberValue(channel.maxReferenceAudios),
    directVideoReplacementPromptLanguage,
    directVideoReplacementSceneOptional,
    directVideoReplacementFaceOptional,
    directVideoReplacementReferenceContract,
    directVideoReplacementPromptVersion,
  };
}

function incomingVideoChannel(
  channel: VideoModelChannel,
  index: number,
  seen: Set<string>,
  existingConfig?: Record<string, unknown>,
) {
  return {
    id: uniqueChannelId(channel.id, `video-model-${index + 1}`, seen),
    kind: "video" as const,
    providerKey: "openai-seedance",
    name: channel.name?.trim() || `视频模型 ${index + 1}`,
    enabled: channel.enabled !== false,
    baseUrl: channel.baseUrl?.trim() || "",
    model: channel.model?.trim() || "",
    config: videoChannelConfigForSave(channel, existingConfig),
    sortOrder: 200 + index,
  };
}

export async function saveGlobalModelSettings(settings: GlobalModelSettings, credentialOwnerId = ADMIN_USER_ID) {
  await ensureGlobalModelPool();
  const db = getDb();
  const existingChannelConfigs = new Map(
    (await listChannels()).map((channel) => [channel.id, channel.config as ChannelConfig]),
  );
  const seen = new Set<string>();
  const rows: Array<Omit<typeof modelChannels.$inferInsert, "createdAt" | "updatedAt">> = [];
  const credentials: Array<{ channelId: string; apiKey: string }> = [];
  const llm = settings.llm;
  if (llm) {
    seen.add("llm-default");
    rows.push({
      id: "llm-default",
      kind: "llm",
      providerKey: llm.provider?.trim() || "openai",
      name: "LLM",
      enabled: true,
      baseUrl: llm.baseUrl?.trim() || "",
      model: llm.model?.trim() || "",
      config: { visionModel: llm.visionModel?.trim() || "" },
      sortOrder: 0,
    });
    if (llm.apiKey?.trim()) credentials.push({ channelId: "llm-default", apiKey: llm.apiKey.trim() });
  }
  const provider = settings.providers?.["openai-seedance"];
  (provider?.imageChannels ?? []).forEach((channel, index) => {
    const row = incomingImageChannel(channel, index, seen);
    rows.push(row);
    if (channel.apiKey?.trim()) credentials.push({ channelId: row.id, apiKey: channel.apiKey.trim() });
  });
  (provider?.videoChannels ?? []).forEach((channel, index) => {
    const row = incomingVideoChannel(channel, index, seen, existingChannelConfigs.get(channel.id));
    rows.push(row);
    if (channel.apiKey?.trim()) credentials.push({ channelId: row.id, apiKey: channel.apiKey.trim() });
  });
  if (!rows.length) throw new Error("MODEL_POOL_EMPTY");

  for (const row of rows) {
    await db.insert(modelChannels).values({ ...row, updatedAt: new Date() }).onConflictDoUpdate({
      target: modelChannels.id,
      set: { ...row, updatedAt: new Date() },
    });
  }
  const retainedChannelIds = new Set(rows.map((row) => row.id));
  const existingChannels = await listChannels();
  for (const channel of existingChannels) {
    if (!retainedChannelIds.has(channel.id)) {
      await db.delete(modelChannels).where(eq(modelChannels.id, channel.id));
    }
  }
  for (const credential of credentials) {
    const encryptedApiKey = encryptModelCredential(credential.apiKey);
    await db.insert(userModelCredentials).values({
      userId: credentialOwnerId,
      channelId: credential.channelId,
      encryptedApiKey,
      keyVersion: 1,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [userModelCredentials.userId, userModelCredentials.channelId],
      set: { encryptedApiKey, keyVersion: 1, updatedAt: new Date() },
    });
  }
}

export async function listUserCredentialStates(userId: string): Promise<ModelCredentialState[]> {
  const channels = await ensureGlobalModelPool();
  await assertCredentialUser(userId);
  const db = getDb();
  const credentials = await db.select({
    channelId: userModelCredentials.channelId,
    updatedAt: userModelCredentials.updatedAt,
  }).from(userModelCredentials).where(eq(userModelCredentials.userId, userId));
  const byChannel = new Map(credentials.map((item) => [item.channelId, item]));
  return channels.map((channel) => {
    const credential = byChannel.get(channel.id);
    return {
      channelId: channel.id,
      kind: channel.kind,
      providerKey: channel.providerKey,
      name: channel.name,
      model: channel.model,
      enabled: channel.enabled,
      configured: Boolean(credential),
      updatedAt: credential?.updatedAt ?? null,
    };
  });
}

export async function replaceUserChannelCredential(userId: string, channelId: string, apiKey: string) {
  const channels = await ensureGlobalModelPool();
  await assertCredentialUser(userId);
  if (!channels.some((channel) => channel.id === channelId)) throw new Error("MODEL_CHANNEL_NOT_FOUND");
  const value = apiKey.trim();
  const db = getDb();
  if (!value) {
    await db.delete(userModelCredentials).where(and(
      eq(userModelCredentials.userId, userId),
      eq(userModelCredentials.channelId, channelId),
    ));
    return;
  }
  const encryptedApiKey = encryptModelCredential(value);
  await db.insert(userModelCredentials).values({
    userId,
    channelId,
    encryptedApiKey,
    keyVersion: 1,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [userModelCredentials.userId, userModelCredentials.channelId],
    set: { encryptedApiKey, keyVersion: 1, updatedAt: new Date() },
  });
}

export async function revealUserChannelCredential(userId: string, channelId: string) {
  const channels = await ensureGlobalModelPool();
  await assertCredentialUser(userId);
  if (!channels.some((channel) => channel.id === channelId)) throw new Error("MODEL_CHANNEL_NOT_FOUND");
  return apiKeyForChannel(userId, channelId);
}

export async function resolveGlobalVideoReferenceHosting(): Promise<VideoReferenceHostingSetting | null> {
  return (await globalVideoReferenceHosting()) ?? null;
}

export async function resolveGlobalVideoReferenceHostingCredentials(): Promise<Pick<VideoReferenceHostingSetting, "apiKey" | "apiSecret"> | null> {
  await ensureGlobalModelPool();
  const db = getDb();
  const [credential] = await db.select()
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, ADMIN_USER_ID))
    .limit(1);
  if (!credential) return null;
  return {
    apiKey: decryptModelCredential(credential.encryptedApiKey),
    apiSecret: decryptModelCredential(credential.encryptedApiSecret),
  };
}

export async function replaceGlobalVideoReferenceHostingCredentials(input: Partial<Pick<VideoReferenceHostingSetting, "apiKey" | "apiSecret">>) {
  await ensureGlobalModelPool();
  const apiKey = input.apiKey?.trim();
  const apiSecret = input.apiSecret?.trim();
  const db = getDb();
  const [existing] = await db.select()
    .from(userVideoReferenceHostingCredentials)
    .where(eq(userVideoReferenceHostingCredentials.userId, ADMIN_USER_ID))
    .limit(1);
  const encryptedApiKey = apiKey ? encryptModelCredential(apiKey) : existing?.encryptedApiKey;
  const encryptedApiSecret = apiSecret ? encryptModelCredential(apiSecret) : existing?.encryptedApiSecret;
  if (!encryptedApiKey || !encryptedApiSecret) throw new Error("HOSTING_CREDENTIAL_PAIR_REQUIRED");
  const now = new Date();
  await db.insert(userVideoReferenceHostingCredentials).values({
    userId: ADMIN_USER_ID,
    encryptedApiKey,
    encryptedApiSecret,
    keyVersion: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: userVideoReferenceHostingCredentials.userId,
    set: { encryptedApiKey, encryptedApiSecret, keyVersion: 1, updatedAt: now },
  });
}

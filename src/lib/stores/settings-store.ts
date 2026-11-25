import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { accountScopedStateStorage } from "@/lib/stores/account-scoped-storage";
import { IMAGE_REQUEST_TIMEOUT_MS } from "@/lib/image-generation-policy";
import {
  type BoardVideoPromptLanguage,
  type DirectVideoReplacementPromptVersion,
  type DirectVideoReplacementReferenceContract,
  defaultBoardVideoDurationOptions,
  defaultBoardVideoMaxReferenceAudios,
  defaultBoardVideoMaxReferenceImages,
  defaultBoardVideoMaxReferenceVideos,
  normalizeBoardVideoDurationOptions,
  normalizeBoardVideoMaxReferenceAudios,
  normalizeBoardVideoMaxReferenceImages,
  normalizeBoardVideoMaxReferenceVideos,
} from "@/lib/board-video-protocol";

const LEGACY_IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// AI provider configuration.
export interface ImageModelChannel {
  id: string;
  name: string;
  enabled?: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  endpointPath?: string;
  requestTimeoutMs?: number;
}

export type VideoTaskType = "shot_clip" | "full_video";

export interface VideoModelChannel {
  id: string;
  name: string;
  enabled?: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Exact saved upstream contract. Omitted channels retain their existing protocol. */
  videoProtocol?: "mikoto" | "mikoto_sora";
  taskTypes?: VideoTaskType[];
  submitPath?: string;
  statusPath?: string;
  contentPath?: string;
  /** Supported per-task durations. The board automatically selects the largest one. */
  durationOptions?: number[];
  /** Maximum number of reference images accepted by this upstream model. */
  maxReferenceImages?: number;
  /** Maximum number of reference videos accepted by this upstream model. */
  maxReferenceVideos?: number;
  /** Maximum number of reference audio files accepted by this upstream model. */
  maxReferenceAudios?: number;
  /** Language of the fixed prompt when this channel uses direct video replacement. */
  directVideoReplacementPromptLanguage?: BoardVideoPromptLanguage;
  /** Whether direct video replacement may use the reference video's background when no scene image is selected. */
  directVideoReplacementSceneOptional?: boolean;
  /** Whether this exact product-front contract may retain the reference-video identity without a face image. */
  directVideoReplacementFaceOptional?: boolean;
  /** Saved image-role contract for this exact direct-reference-video channel. */
  directVideoReplacementReferenceContract?: DirectVideoReplacementReferenceContract;
  /** Controlled prompt revision for this exact direct-reference-video channel. */
  directVideoReplacementPromptVersion?: DirectVideoReplacementPromptVersion;
}

export type CloneVideoChannel = VideoModelChannel;

export interface ProviderSetting {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
  imageChannels?: ImageModelChannel[];
  activeImageChannelId?: string;
  videoChannels?: VideoModelChannel[];
  activeVideoChannelId?: string;
  imageApiKey?: string;
  imageBaseUrl?: string;
  videoApiKey?: string;
  videoBaseUrl?: string;
  videoSubmitPath?: string;
  videoStatusPath?: string;
  videoContentPath?: string;
  cloneVideoApiKey?: string;
  cloneVideoBaseUrl?: string;
  cloneVideoSubmitPath?: string;
  cloneVideoStatusPath?: string;
  cloneVideoContentPath?: string;
  cloneVideoModel?: string;
  cloneVideoChannels?: CloneVideoChannel[];
  activeCloneVideoChannelId?: string;
}

export function hasProviderCredential(setting?: ProviderSetting): boolean {
  return Boolean(
    setting?.apiKey?.trim() ||
    setting?.imageApiKey?.trim() ||
    setting?.videoApiKey?.trim() ||
    setting?.imageChannels?.some((channel) => channel.enabled !== false && channel.apiKey?.trim()) ||
    setting?.videoChannels?.some((channel) => channel.enabled !== false && channel.apiKey?.trim())
  );
}

// LLM configuration.
export interface LLMSetting {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

interface SettingsState {
  // AI platform configuration.
  providers: Record<string, ProviderSetting>;
  // LLM configuration.
  llm: LLMSetting;

  // Actions
  setProvider: (name: string, setting: ProviderSetting) => void;
  setLLM: (llm: LLMSetting) => void;
  replaceSettings: (settings: { providers: Record<string, ProviderSetting>; llm: LLMSetting }) => void;
}

const OPENAI_VIDEO_SUBMIT_PATH = "/videos";
const OPENAI_VIDEO_STATUS_PATH = "/videos/{id}";
const OPENAI_VIDEO_CONTENT_PATH = "/videos/{id}/content";
const OMNI_VIDEO_SUBMIT_PATH = "/video/generations";
const OMNI_VIDEO_STATUS_PATH = "/video/generations/{id}";
const IMAGE_MODEL = "gpt-image-2";
const VIDEO_MODEL = "seedance-v2-720p-video";
const GROK_VIDEO_MODEL = "grok-imagine-video-1.5";
const LEGACY_VIDEO_SUBMIT_PATHS = new Set([
  "",
  "/contents/generations/tasks",
  "/videos/generations",
]);
const LEGACY_VIDEO_STATUS_PATHS = new Set([
  "",
  "/contents/generations/tasks/{id}",
  "/videos/generations/{id}",
]);

function cleanModelChannelName(name: string | undefined, fallback: string): string {
  const value = (name ?? "").trim();
  if (!value) return fallback;
  const knownGarbledNames: Record<string, string> = {
    "OpenAI image-2 \u9422\u71b7\u6d58\u59af\u2033\u7037": "OpenAI image-2 生图模型",
    "\u6fb6\u56e9\u6564\u9422\u71b7\u6d58\u59af\u2033\u7037 2": "备用生图模型 2",
    "\u6fb6\u56e9\u6564\u9422\u71b7\u6d58\u59af\u2033\u7037 3": "备用生图模型 3",
    "Grok \u699b\u6a3f\ue17b\u7039\u5c7e\u66a3\u7459\u55db\ue576\u95ab\u6c36\u4ebe": "Grok 完整视频模型",
    "Seedance \u95ab\u6c31\u6564\u7459\u55db\ue576\u59af\u2033\u7037": "Seedance 通用视频模型",
    "Omni Flash \u7459\u55db\ue576\u59af\u2033\u7037": "Omni Flash 视频模型",
    "\u93c3\u0445\u5897 image-2 \u9422\u71b7\u6d58\u59af\u2033\u7037": "旧版 image-2 生图模型",
    "Grok \u95ab\u6c31\u6564\u7459\u55db\ue576\u59af\u2033\u7037": "Grok 通用视频模型",
  };
  if (knownGarbledNames[value]) return knownGarbledNames[value];
  return value;
}

function normalizeOpenAISeedanceProvider(setting?: ProviderSetting): ProviderSetting {
  const next: ProviderSetting = {
    enabled: false,
    apiKey: "",
    ...setting,
  };
  const submitPath = (next.videoSubmitPath ?? "").trim();
  const statusPath = (next.videoStatusPath ?? "").trim();
  const contentPath = (next.videoContentPath ?? "").trim();
  const cloneSubmitPath = (next.cloneVideoSubmitPath ?? "").trim();
  const cloneStatusPath = (next.cloneVideoStatusPath ?? "").trim();
  const cloneContentPath = (next.cloneVideoContentPath ?? "").trim();

  if (LEGACY_VIDEO_SUBMIT_PATHS.has(submitPath)) {
    next.videoSubmitPath = OPENAI_VIDEO_SUBMIT_PATH;
  }
  if (LEGACY_VIDEO_STATUS_PATHS.has(statusPath)) {
    next.videoStatusPath = OPENAI_VIDEO_STATUS_PATH;
  }
  if (!contentPath) {
    next.videoContentPath = OPENAI_VIDEO_CONTENT_PATH;
  }
  if (!cloneSubmitPath) {
    next.cloneVideoSubmitPath = OPENAI_VIDEO_SUBMIT_PATH;
  }
  if (!cloneStatusPath) {
    next.cloneVideoStatusPath = OPENAI_VIDEO_STATUS_PATH;
  }
  if (!cloneContentPath) {
    next.cloneVideoContentPath = OPENAI_VIDEO_CONTENT_PATH;
  }
  if (!next.cloneVideoModel?.trim()) {
    next.cloneVideoModel = GROK_VIDEO_MODEL;
  }

  const savedImageChannels = (next.imageChannels ?? [])
    .filter((channel) => channel && typeof channel === "object")
    .map((channel, index) => {
      return {
      id: channel.id || `image-model-${index + 1}`,
      name: cleanModelChannelName(channel.name, `生图模型 ${index + 1}`),
      enabled: channel.enabled ?? true,
      apiKey: channel.apiKey ?? "",
        baseUrl: channel.baseUrl ?? "https://api.openai.com/v1",
        model: channel.model || IMAGE_MODEL,
        endpointPath: channel.endpointPath || "/images/edits",
        requestTimeoutMs: Number(channel.requestTimeoutMs) === LEGACY_IMAGE_REQUEST_TIMEOUT_MS
          ? IMAGE_REQUEST_TIMEOUT_MS
          : Number.isFinite(Number(channel.requestTimeoutMs)) && Number(channel.requestTimeoutMs) > 0
            ? Number(channel.requestTimeoutMs)
            : IMAGE_REQUEST_TIMEOUT_MS,
      };
    });
  next.imageChannels = savedImageChannels.length
    ? savedImageChannels
    : [
        {
          id: "image-default",
          name: "OpenAI image-2 生图模型",
          enabled: true,
          apiKey: next.imageApiKey ?? next.apiKey ?? "",
          baseUrl: next.imageBaseUrl ?? next.baseUrl ?? "https://api.openai.com/v1",
          model: IMAGE_MODEL,
          endpointPath: "/images/edits",
        },
        {
          id: "image-backup-2",
          name: "备用生图模型 2",
          enabled: true,
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          model: "",
          endpointPath: "/images/edits",
        },
        {
          id: "image-backup-3",
          name: "备用生图模型 3",
          enabled: true,
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          model: "",
          endpointPath: "/images/edits",
        },
      ];
  next.activeImageChannelId = next.imageChannels.find((channel) => channel.id === next.activeImageChannelId && channel.enabled !== false)?.id
    ?? next.imageChannels.find((channel) => channel.enabled !== false && channel.apiKey && channel.baseUrl && channel.model)?.id
    ?? next.imageChannels.find((channel) => channel.enabled !== false)?.id
    ?? next.imageChannels[0]?.id;

  const migratedChannel: CloneVideoChannel = {
    id: "grok-default",
    name: "Grok 完整视频模型",
    enabled: true,
    apiKey: next.cloneVideoApiKey ?? "",
    baseUrl: next.cloneVideoBaseUrl ?? "",
    model: next.cloneVideoModel ?? GROK_VIDEO_MODEL,
    submitPath: next.cloneVideoSubmitPath ?? OPENAI_VIDEO_SUBMIT_PATH,
    statusPath: next.cloneVideoStatusPath ?? OPENAI_VIDEO_STATUS_PATH,
    contentPath: next.cloneVideoContentPath ?? OPENAI_VIDEO_CONTENT_PATH,
    durationOptions: defaultBoardVideoDurationOptions(next.cloneVideoModel ?? GROK_VIDEO_MODEL),
    maxReferenceImages: defaultBoardVideoMaxReferenceImages(next.cloneVideoModel ?? GROK_VIDEO_MODEL),
    maxReferenceVideos: defaultBoardVideoMaxReferenceVideos(next.cloneVideoModel ?? GROK_VIDEO_MODEL),
    maxReferenceAudios: defaultBoardVideoMaxReferenceAudios(next.cloneVideoModel ?? GROK_VIDEO_MODEL),
  };
  const migratedShotChannel: VideoModelChannel = {
    id: "seedance-default",
    name: "Seedance 通用视频模型",
    enabled: true,
    apiKey: next.videoApiKey ?? next.apiKey ?? "",
    baseUrl: next.videoBaseUrl ?? next.baseUrl ?? "",
    model: VIDEO_MODEL,
    taskTypes: ["shot_clip", "full_video"],
    submitPath: next.videoSubmitPath ?? OPENAI_VIDEO_SUBMIT_PATH,
    statusPath: next.videoStatusPath ?? OPENAI_VIDEO_STATUS_PATH,
    contentPath: next.videoContentPath ?? OPENAI_VIDEO_CONTENT_PATH,
    durationOptions: defaultBoardVideoDurationOptions(VIDEO_MODEL),
    maxReferenceImages: defaultBoardVideoMaxReferenceImages(VIDEO_MODEL),
    maxReferenceVideos: defaultBoardVideoMaxReferenceVideos(VIDEO_MODEL),
    maxReferenceAudios: defaultBoardVideoMaxReferenceAudios(VIDEO_MODEL),
  };
  const normalizeVideoChannel = (channel: Partial<VideoModelChannel>, index: number): VideoModelChannel => {
    const model = channel.model || "";
    const isOmni = /omni/i.test(model);
    const submitPath = channel.submitPath || OPENAI_VIDEO_SUBMIT_PATH;
    const statusPath = channel.statusPath || OPENAI_VIDEO_STATUS_PATH;
    const contentPath = channel.contentPath || OPENAI_VIDEO_CONTENT_PATH;
    const explicitDurationOptions = Array.isArray(channel.durationOptions)
      ? normalizeBoardVideoDurationOptions(channel.durationOptions)
      : null;
    const explicitMaxReferenceImages = normalizeBoardVideoMaxReferenceImages(channel.maxReferenceImages);
    const explicitMaxReferenceVideos = normalizeBoardVideoMaxReferenceVideos(channel.maxReferenceVideos);
    const explicitMaxReferenceAudios = normalizeBoardVideoMaxReferenceAudios(channel.maxReferenceAudios);
    return {
      id: channel.id || `video-model-${index + 1}`,
      name: cleanModelChannelName(channel.name, `视频模型 ${index + 1}`),
      enabled: channel.enabled ?? true,
      apiKey: channel.apiKey ?? "",
      baseUrl: channel.baseUrl ?? "",
      model,
      taskTypes: channel.taskTypes?.length ? channel.taskTypes : ["shot_clip", "full_video"],
      submitPath: isOmni && submitPath === OPENAI_VIDEO_SUBMIT_PATH ? OMNI_VIDEO_SUBMIT_PATH : submitPath,
      statusPath: isOmni && statusPath === OPENAI_VIDEO_STATUS_PATH ? OMNI_VIDEO_STATUS_PATH : statusPath,
      contentPath: isOmni && contentPath === OPENAI_VIDEO_CONTENT_PATH ? "" : contentPath,
      durationOptions: explicitDurationOptions ?? defaultBoardVideoDurationOptions(model),
      maxReferenceImages: explicitMaxReferenceImages ?? defaultBoardVideoMaxReferenceImages(model),
      maxReferenceVideos: explicitMaxReferenceVideos ?? defaultBoardVideoMaxReferenceVideos(model),
      maxReferenceAudios: explicitMaxReferenceAudios ?? defaultBoardVideoMaxReferenceAudios(model),
      directVideoReplacementPromptLanguage: channel.directVideoReplacementPromptLanguage === "zh-CN" ? "zh-CN" : "en",
      directVideoReplacementSceneOptional: channel.directVideoReplacementSceneOptional === true,
      directVideoReplacementFaceOptional: channel.directVideoReplacementFaceOptional === true,
      directVideoReplacementReferenceContract: channel.directVideoReplacementReferenceContract === "product_front_face"
        ? "product_front_face"
        : "product_board_face_model",
      directVideoReplacementPromptVersion: channel.directVideoReplacementPromptVersion === "v2" ? "v2" : "v1",
    };
  };
  const legacyCloneChannels = (next.cloneVideoChannels ?? [])
    .filter((channel) => channel && typeof channel === "object")
    .map((channel, index) => normalizeVideoChannel({
      ...channel,
      name: cleanModelChannelName(channel.name, `视频模型 ${index + 1}`),
      model: channel.model || GROK_VIDEO_MODEL,
      taskTypes: channel.taskTypes ?? ["shot_clip", "full_video"],
    }, index));
  const savedVideoChannels = (next.videoChannels ?? [])
    .filter((channel) => channel && typeof channel === "object")
    .map((channel, index) => normalizeVideoChannel(channel, index));
  const mergedVideoChannels: VideoModelChannel[] = savedVideoChannels.length
    ? savedVideoChannels
    : [
        migratedShotChannel,
        ...(legacyCloneChannels.length ? legacyCloneChannels : [migratedChannel]),
        {
          id: "video-backup-3",
          name: "Omni Flash 视频模型",
          enabled: true,
          apiKey: "",
          baseUrl: "https://media.apishop.vip/v1",
          model: "omni-flash",
          taskTypes: ["shot_clip", "full_video"] as VideoTaskType[],
          submitPath: OMNI_VIDEO_SUBMIT_PATH,
          statusPath: OMNI_VIDEO_STATUS_PATH,
          contentPath: "",
        },
      ];
  const seenVideoIds = new Set<string>();
  next.videoChannels = mergedVideoChannels.filter((channel) => {
    if (seenVideoIds.has(channel.id)) return false;
    seenVideoIds.add(channel.id);
    return true;
  });
  const activeVideoChannel = next.videoChannels.find((channel) => channel.id === next.activeVideoChannelId && channel.enabled !== false)
    ?? next.videoChannels.find((channel) => channel.id === next.activeCloneVideoChannelId && channel.enabled !== false)
    ?? next.videoChannels.find((channel) => channel.enabled !== false && channel.apiKey && channel.baseUrl && channel.model)
    ?? next.videoChannels.find((channel) => channel.enabled !== false)
    ?? next.videoChannels[0];
  next.activeVideoChannelId = activeVideoChannel?.id;
  next.activeCloneVideoChannelId = undefined;
  next.cloneVideoChannels = undefined;
  next.cloneVideoApiKey = undefined;
  next.cloneVideoBaseUrl = undefined;
  next.cloneVideoSubmitPath = undefined;
  next.cloneVideoStatusPath = undefined;
  next.cloneVideoContentPath = undefined;
  next.cloneVideoModel = undefined;

  return next;
}

function withoutCredentialValues(setting: ProviderSetting): ProviderSetting {
  return {
    ...setting,
    apiKey: "",
    imageApiKey: "",
    videoApiKey: "",
    imageChannels: setting.imageChannels?.map((channel) => ({ ...channel, apiKey: "" })),
    videoChannels: setting.videoChannels?.map((channel) => ({ ...channel, apiKey: "" })),
  };
}

export function getEnabledImageChannels(setting?: ProviderSetting): ImageModelChannel[] {
  return (setting?.imageChannels ?? []).filter((channel) => channel.enabled !== false);
}

export type ReadyImageChannelOptions = {
  /**
   * The server resolves the credential by channel ID, so the browser may only
   * receive the channel metadata without an API key.
   */
  allowServerManagedCredentials?: boolean;
};

export function getReadyImageChannels(
  setting?: ProviderSetting,
  options?: ReadyImageChannelOptions,
): ImageModelChannel[] {
  return getEnabledImageChannels(setting).filter((channel) =>
    Boolean(
      channel.baseUrl?.trim()
      && channel.model?.trim()
      && (channel.apiKey?.trim() || options?.allowServerManagedCredentials),
    )
  );
}

export function getActiveImageChannel(setting?: ProviderSetting, channelId?: string): ImageModelChannel | null {
  if (!setting) return null;
  const channels = setting.imageChannels?.length
    ? setting.imageChannels
    : [
        {
          id: "legacy-image",
          name: "旧版 image-2 生图模型",
          enabled: true,
          apiKey: setting.imageApiKey ?? setting.apiKey ?? "",
          baseUrl: setting.imageBaseUrl ?? setting.baseUrl ?? "",
          model: IMAGE_MODEL,
          endpointPath: "/images/edits",
        },
      ];
  return channels.find((channel) => channel.id === channelId && channel.enabled !== false)
    ?? channels.find((channel) => channel.id === setting.activeImageChannelId && channel.enabled !== false)
    ?? channels.find((channel) => channel.enabled !== false && channel.apiKey && channel.baseUrl && channel.model)
    ?? channels.find((channel) => channel.enabled !== false)
    ?? channels[0]
    ?? null;
}

export function getEnabledVideoChannels(setting?: ProviderSetting, taskType?: VideoTaskType): VideoModelChannel[] {
  return (setting?.videoChannels ?? [])
    .filter((channel) => channel.enabled !== false)
    .filter((channel) => !taskType || !channel.taskTypes?.length || channel.taskTypes.includes(taskType));
}

export type ReadyVideoChannelOptions = {
  /**
   * The server resolves the credential by channel ID, so the browser may only
   * receive the channel metadata without an API key.
   */
  allowServerManagedCredentials?: boolean;
};

export function getReadyVideoChannels(
  setting?: ProviderSetting,
  taskType?: VideoTaskType,
  options?: ReadyVideoChannelOptions,
): VideoModelChannel[] {
  return getEnabledVideoChannels(setting, taskType).filter((channel) =>
    Boolean(
      channel.baseUrl?.trim()
      && channel.model?.trim()
      && (channel.apiKey?.trim() || options?.allowServerManagedCredentials),
    )
  );
}

export function getActiveVideoChannel(setting?: ProviderSetting, channelId?: string, taskType?: VideoTaskType): VideoModelChannel | null {
  if (!setting) return null;
  const channels = getEnabledVideoChannels(setting, taskType);
  return channels.find((channel) => channel.id === channelId)
    ?? channels.find((channel) => channel.id === setting.activeVideoChannelId)
    ?? channels.find((channel) => channel.apiKey && channel.baseUrl && channel.model)
    ?? channels[0]
    ?? null;
}

export function getActiveCloneVideoChannel(setting?: ProviderSetting): CloneVideoChannel | null {
  return getActiveVideoChannel(setting, setting?.activeVideoChannelId, "full_video");
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      providers: {
        "atlas-cloud": { enabled: false, apiKey: "" },
        "fal-ai": { enabled: false, apiKey: "" },
        volcengine: { enabled: false, apiKey: "" },
        alibaba: { enabled: false, apiKey: "" },
        siliconflow: { enabled: false, apiKey: "" },
        "openai-seedance": {
          enabled: false,
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          imageChannels: [
            {
              id: "image-default",
              name: "OpenAI image-2 生图模型",
              enabled: true,
              apiKey: "",
              baseUrl: "https://api.openai.com/v1",
              model: IMAGE_MODEL,
              endpointPath: "/images/edits",
            },
            {
              id: "image-backup-2",
              name: "备用生图模型 2",
              enabled: true,
              apiKey: "",
              baseUrl: "https://api.openai.com/v1",
              model: "",
              endpointPath: "/images/edits",
            },
            {
              id: "image-backup-3",
              name: "备用生图模型 3",
              enabled: true,
              apiKey: "",
              baseUrl: "https://api.openai.com/v1",
              model: "",
              endpointPath: "/images/edits",
            },
          ],
          activeImageChannelId: "image-default",
          videoChannels: [
            {
              id: "seedance-default",
              name: "Seedance 通用视频模型",
              enabled: true,
              apiKey: "",
              baseUrl: "",
              model: VIDEO_MODEL,
              taskTypes: ["shot_clip", "full_video"] as VideoTaskType[],
              submitPath: OPENAI_VIDEO_SUBMIT_PATH,
              statusPath: OPENAI_VIDEO_STATUS_PATH,
              contentPath: OPENAI_VIDEO_CONTENT_PATH,
              durationOptions: defaultBoardVideoDurationOptions(VIDEO_MODEL),
              maxReferenceImages: defaultBoardVideoMaxReferenceImages(VIDEO_MODEL),
              maxReferenceVideos: defaultBoardVideoMaxReferenceVideos(VIDEO_MODEL),
              maxReferenceAudios: defaultBoardVideoMaxReferenceAudios(VIDEO_MODEL),
            },
            {
              id: "grok-default",
              name: "Grok 通用视频模型",
              enabled: true,
              apiKey: "",
              baseUrl: "",
              model: GROK_VIDEO_MODEL,
              taskTypes: ["shot_clip", "full_video"] as VideoTaskType[],
              submitPath: OPENAI_VIDEO_SUBMIT_PATH,
              statusPath: OPENAI_VIDEO_STATUS_PATH,
              contentPath: OPENAI_VIDEO_CONTENT_PATH,
              durationOptions: defaultBoardVideoDurationOptions(GROK_VIDEO_MODEL),
              maxReferenceImages: defaultBoardVideoMaxReferenceImages(GROK_VIDEO_MODEL),
              maxReferenceVideos: defaultBoardVideoMaxReferenceVideos(GROK_VIDEO_MODEL),
              maxReferenceAudios: defaultBoardVideoMaxReferenceAudios(GROK_VIDEO_MODEL),
            },
            {
              id: "video-backup-3",
              name: "Omni Flash 视频模型",
              enabled: true,
              apiKey: "",
              baseUrl: "https://media.apishop.vip/v1",
              model: "omni-flash",
              taskTypes: ["shot_clip", "full_video"] as VideoTaskType[],
              submitPath: OMNI_VIDEO_SUBMIT_PATH,
              statusPath: OMNI_VIDEO_STATUS_PATH,
              contentPath: "",
              durationOptions: defaultBoardVideoDurationOptions("omni-flash"),
            },
          ],
          activeVideoChannelId: "seedance-default",
          imageApiKey: "",
          imageBaseUrl: "https://api.openai.com/v1",
          videoApiKey: "",
          videoBaseUrl: "",
          videoSubmitPath: OPENAI_VIDEO_SUBMIT_PATH,
          videoStatusPath: OPENAI_VIDEO_STATUS_PATH,
          videoContentPath: OPENAI_VIDEO_CONTENT_PATH,
        },
      },
      llm: {
        provider: "",
        baseUrl: "",
        apiKey: "",
        model: "",
        visionModel: "",
      },
      setProvider: (name, setting) =>
        set((state) => ({
          providers: { ...state.providers, [name]: setting },
        })),
      setLLM: (llm) => set({ llm }),
      replaceSettings: (settings) => set({
        providers: {
          ...settings.providers,
          "openai-seedance": normalizeOpenAISeedanceProvider(settings.providers["openai-seedance"]),
        },
        llm: settings.llm,
      }),
    }),
    {
      name: "daihuo-jianshou-settings",
      storage: createJSONStorage(() => accountScopedStateStorage),
      skipHydration: true,
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        const providers = {
          ...current.providers,
          ...(saved?.providers ?? {}),
        };
        providers["openai-seedance"] = normalizeOpenAISeedanceProvider(providers["openai-seedance"]);
        return {
          ...current,
          ...saved,
          providers,
        };
      },
      partialize: (state) => ({
        providers: Object.fromEntries(Object.entries(state.providers).map(([name, setting]) => [name, withoutCredentialValues(setting)])),
        llm: { ...state.llm, apiKey: "" },
      }),
    }
  )
);

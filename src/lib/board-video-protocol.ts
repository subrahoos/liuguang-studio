export type BoardVideoProtocol = "grok" | "jimeng" | "rjmus_multimedia" | "lingganya" | "mikoto" | "mikoto_sora";
export type BoardVideoResolution = "720p" | "1080p";
export type BoardVideoPromptLanguage = "en" | "zh-CN";
export type DirectVideoReplacementPromptVersion = "v1" | "v2";
/**
 * Reference responsibilities for a direct-reference-video channel.
 * This is persisted on the channel itself; it is never inferred from a model name.
 */
export type DirectVideoReplacementReferenceContract = "product_board_face_model" | "product_front_face";

export type BoardVideoProfile = {
  model: string;
  protocol: BoardVideoProtocol;
  /** Normalized per-task durations declared by the selected model channel. */
  durationOptions: number[];
  /** The automatic choice: highest supported duration to minimize task count. */
  generationSeconds: number;
  /** Resolutions the current task may select for this protocol contract. */
  resolutionOptions: BoardVideoResolution[];
  resolution: BoardVideoResolution;
  aspectRatio: "9:16";
  /** Maximum reference images accepted by the upstream model. */
  maxReferenceImages: number;
  /** Maximum reference videos accepted by the upstream model. */
  maxReferenceVideos: number;
  /** Maximum reference audio files accepted by the upstream model. */
  maxReferenceAudios: number;
  /** Fixed number of references this board workflow actually sends. */
  referenceImageCount: number;
  /** Language of the fixed prompt when the channel directly replaces a reference video. */
  directVideoReplacementPromptLanguage: BoardVideoPromptLanguage;
  /** Whether direct replacement may omit the scene image and use the reference video background. */
  directVideoReplacementSceneOptional: boolean;
  /** Whether this exact product-front contract may omit the face image and retain the reference-video identity. */
  directVideoReplacementFaceOptional: boolean;
  /** Saved replacement-image contract for this exact video channel. */
  directVideoReplacementReferenceContract: DirectVideoReplacementReferenceContract;
  /** Controlled prompt revision for this exact video channel. */
  directVideoReplacementPromptVersion: DirectVideoReplacementPromptVersion;
  /**
   * This is a channel contract, not a model-name default. When true the
   * canvas submits one reference video plus up to four replacement-role images
   * directly, without requiring a director draft or segmented composition.
   */
  directVideoReplacement: boolean;
  /** The upstream field used for the actual video task, not the director draft inputs. */
  referenceField: "image_url" | "image_urls" | "images";
  /** Changes whenever a channel capability relevant to a board director changes. */
  capabilitySignature: string;
};

export type BoardVideoChannelCapabilities = {
  id?: string;
  baseUrl?: unknown;
  model?: string;
  videoProtocol?: unknown;
  submitPath?: unknown;
  statusPath?: unknown;
  contentPath?: unknown;
  resolution?: unknown;
  durationOptions?: unknown;
  maxReferenceImages?: unknown;
  maxReferenceVideos?: unknown;
  maxReferenceAudios?: unknown;
  directVideoReplacementPromptLanguage?: unknown;
  directVideoReplacementSceneOptional?: unknown;
  directVideoReplacementFaceOptional?: unknown;
  directVideoReplacementReferenceContract?: unknown;
  directVideoReplacementPromptVersion?: unknown;
};

type BoardVideoProtocolBase = Omit<
  BoardVideoProfile,
  "durationOptions" | "generationSeconds" | "capabilitySignature" | "directVideoReplacement" | "directVideoReplacementPromptLanguage" | "directVideoReplacementSceneOptional" | "directVideoReplacementFaceOptional" | "directVideoReplacementReferenceContract" | "directVideoReplacementPromptVersion"
> & {
  defaultDurationOptions: number[];
};

// rjm-Grok has both a multi-reference model and legacy single-reference 1.5
// variants. The current model pool uses the multi-reference identifier.
export const GROK_MULTI_REFERENCE_BOARD_VIDEO_MODEL = "grok-imagine-video";
export const GROK_BOARD_VIDEO_MODEL = "grok-imagine-video-1.5";
export const JIMENG_BOARD_VIDEO_MODEL = "video-ds-2.0";
export const LINGGANYA_SD_2_BOARD_VIDEO_MODEL = "sd-2.0";
/** Historical compatibility example; new channels are never matched by this list. */
export const LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL = "sd-2.0-T";
export const LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL = "sd-2.0-mini";
export const LINGGANYA_SD_FAST_BOARD_VIDEO_MODEL = "sd-fast";

export const BOARD_VIDEO_MODELS = [
  GROK_MULTI_REFERENCE_BOARD_VIDEO_MODEL,
  GROK_BOARD_VIDEO_MODEL,
  JIMENG_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_2_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL,
  LINGGANYA_SD_FAST_BOARD_VIDEO_MODEL,
] as const;

const BOARD_VIDEO_PROFILES: Record<string, BoardVideoProtocolBase> = {
  [GROK_MULTI_REFERENCE_BOARD_VIDEO_MODEL]: {
    model: GROK_MULTI_REFERENCE_BOARD_VIDEO_MODEL,
    protocol: "grok",
    defaultDurationOptions: [10],
    resolutionOptions: ["720p"],
    resolution: "720p",
    aspectRatio: "9:16",
    // The upstream accepts up to seven images. The board keeps its explicit
    // five-role package so every image has a stable responsibility.
    maxReferenceImages: 7,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    referenceImageCount: 5,
    referenceField: "image_urls",
  },
  [GROK_BOARD_VIDEO_MODEL]: {
    model: GROK_BOARD_VIDEO_MODEL,
    protocol: "grok",
    defaultDurationOptions: [10],
    resolutionOptions: ["720p"],
    resolution: "720p",
    aspectRatio: "9:16",
    maxReferenceImages: 1,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    // video.rjm.us.ci accepts one public HTTPS visual base for Grok.
    // Keep the complete director draft separate: it may still describe every
    // connected asset, but the generation request itself has one image_url.
    referenceImageCount: 1,
    referenceField: "image_url",
  },
  [JIMENG_BOARD_VIDEO_MODEL]: {
    model: JIMENG_BOARD_VIDEO_MODEL,
    protocol: "jimeng",
    defaultDurationOptions: [15],
    resolutionOptions: ["1080p"],
    resolution: "1080p",
    aspectRatio: "9:16",
    maxReferenceImages: 1,
    // Reference-media capacity is provider/channel-specific. Keep the model
    // default at zero until the individual channel declares its real limits.
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    // The current rjm asynchronous endpoint accepts a single image_url.
    referenceImageCount: 1,
    referenceField: "image_url",
  },
  [LINGGANYA_SD_2_BOARD_VIDEO_MODEL]: {
    model: LINGGANYA_SD_2_BOARD_VIDEO_MODEL,
    protocol: "lingganya",
    // Lingganya accepts 4–15 seconds. The board uses its maximum stable task
    // length and trims the final segment when the requested total is shorter.
    defaultDurationOptions: Array.from({ length: 12 }, (_, index) => index + 4),
    resolutionOptions: ["1080p"],
    resolution: "1080p",
    aspectRatio: "9:16",
    maxReferenceImages: 9,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    // Fixed package order: composite/repaired, product, face, current model,
    // and clean scene. Lingganya supports up to nine; this workflow needs five.
    referenceImageCount: 5,
    referenceField: "images",
  },
  [LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL]: {
    model: LINGGANYA_SD_2_T_BOARD_VIDEO_MODEL,
    protocol: "lingganya",
    defaultDurationOptions: Array.from({ length: 12 }, (_, index) => index + 4),
    resolutionOptions: ["1080p"],
    resolution: "1080p",
    aspectRatio: "9:16",
    // LGY's current multi-reference model permits these upstream ceilings.
    // The selected saved channel still decides what this board may actually
    // use, so a different LGY channel never inherits them implicitly.
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    referenceImageCount: 5,
    referenceField: "images",
  },
  [LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL]: {
    model: LINGGANYA_SD_2_MINI_BOARD_VIDEO_MODEL,
    protocol: "lingganya",
    defaultDurationOptions: Array.from({ length: 11 }, (_, index) => index + 5),
    resolutionOptions: ["720p"],
    resolution: "720p",
    aspectRatio: "9:16",
    maxReferenceImages: 6,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
    referenceImageCount: 5,
    referenceField: "images",
  },
  [LINGGANYA_SD_FAST_BOARD_VIDEO_MODEL]: {
    model: LINGGANYA_SD_FAST_BOARD_VIDEO_MODEL,
    protocol: "lingganya",
    defaultDurationOptions: Array.from({ length: 12 }, (_, index) => index + 4),
    resolutionOptions: ["720p"],
    resolution: "720p",
    aspectRatio: "9:16",
    maxReferenceImages: 9,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    referenceImageCount: 5,
    referenceField: "images",
  },
};

/**
 * A Lingganya account can expose different model identifiers over time. The
 * saved channel's exact model name is authoritative; these fields describe
 * the provider protocol, not a catalogue of allowed model names.
 */
function dynamicLingganyaBoardVideoProfile(model: string): BoardVideoProtocolBase {
  return {
    model,
    protocol: "lingganya",
    // A dynamic channel must explicitly declare its supported task durations.
    defaultDurationOptions: [],
    // The direct replacement node lets the operator choose either value. New
    // Lingganya channels default to 720P unless that task explicitly selects
    // 1080P; this is deliberately not persisted on the model-pool channel.
    resolutionOptions: ["720p", "1080p"],
    resolution: "720p",
    aspectRatio: "9:16",
    // Reference limits remain channel-declared; never borrow them from an
    // example model or another saved channel.
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    referenceImageCount: 5,
    referenceField: "images",
  };
}

function isLingganyaBoardVideoBaseUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const hostname = new URL(value.trim()).hostname.toLowerCase();
    return hostname === "lingganyaapi.com" || hostname.endsWith(".lingganyaapi.com");
  } catch {
    return false;
  }
}

function isMikotoBoardVideoChannel(channel: BoardVideoChannelCapabilities | string | null | undefined) {
  if (typeof channel !== "object" || channel === null || (channel.videoProtocol && channel.videoProtocol !== "mikoto")) return false;
  if (typeof channel.baseUrl !== "string" || !String(channel.model || "").trim().toLowerCase().startsWith("seedance-")) return false;
  try {
    if (new URL(channel.baseUrl).hostname.toLowerCase() !== "api.mikoto.vip") return false;
  } catch {
    return false;
  }
  return normalizedChannelPath(channel.submitPath) === "/videos"
    && normalizedChannelPath(channel.statusPath) === "/videos/{id}"
    && normalizedChannelPath(channel.contentPath) === "/videos/{id}/content";
}

function mikotoBoardVideoProfile(model: string): BoardVideoProtocolBase | null {
  const name = model.toLowerCase();
  const resolution = name.includes("1080p") ? "1080p" : name.includes("720p") ? "720p" : null;
  if (!resolution) return null;
  return {
    model,
    protocol: "mikoto",
    defaultDurationOptions: [],
    resolutionOptions: [resolution],
    resolution,
    aspectRatio: "9:16",
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    maxReferenceAudios: 0,
    referenceImageCount: 4,
    referenceField: "images",
  };
}

function isMikotoSoraBoardVideoChannel(channel: BoardVideoChannelCapabilities | string | null | undefined) {
  if (typeof channel !== "object" || channel === null || (channel.videoProtocol && channel.videoProtocol !== "mikoto_sora")) return false;
  if (String(channel.model || "").trim() !== "sora-v3-pro") return false;
  try {
    if (new URL(String(channel.baseUrl || "")).hostname.toLowerCase() !== "api.mikoto.vip") return false;
  } catch { return false; }
  return normalizedChannelPath(channel.submitPath) === "/videos"
    && normalizedChannelPath(channel.statusPath) === "/videos/{id}"
    && normalizedChannelPath(channel.contentPath) === "/videos/{id}/content";
}

function mikotoSoraBoardVideoProfile(model: string): BoardVideoProtocolBase {
  return { model, protocol: "mikoto_sora", defaultDurationOptions: [], resolutionOptions: ["720p"], resolution: "720p", aspectRatio: "9:16", maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, referenceImageCount: 4, referenceField: "images" };
}

export function normalizeBoardVideoDurationOptions(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => Math.round(Number(item)))
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 1 && seconds <= 120)))
    .sort((left, right) => left - right);
}

export function normalizeBoardVideoResolution(value: unknown): BoardVideoResolution | null {
  const resolution = typeof value === "string" ? value.trim().toLowerCase() : "";
  return resolution === "720p" || resolution === "1080p" ? resolution : null;
}

export function normalizeBoardVideoPromptLanguage(value: unknown): BoardVideoPromptLanguage {
  return value === "zh-CN" ? "zh-CN" : "en";
}

export function normalizeDirectVideoReplacementReferenceContract(
  value: unknown,
): DirectVideoReplacementReferenceContract {
  return value === "product_front_face" ? "product_front_face" : "product_board_face_model";
}

export function normalizeBoardVideoMaxReferenceImages(value: unknown): number | null {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count >= 1 && count <= 16 ? count : null;
}

export function normalizeBoardVideoMaxReferenceVideos(value: unknown): number | null {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count >= 0 && count <= 3 ? count : null;
}

export function normalizeBoardVideoMaxReferenceAudios(value: unknown): number | null {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count >= 0 && count <= 3 ? count : null;
}

/** Parses model-pool input such as "4-15", "6,10", or "10". */
export function parseBoardVideoDurationOptions(value: string): number[] {
  const values = new Set<number>();
  for (const rawPart of String(value || "").split(/[,，\s]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
    if (range) {
      const start = Math.max(1, Math.min(120, Number(range[1])));
      const end = Math.max(1, Math.min(120, Number(range[2])));
      for (let seconds = Math.min(start, end); seconds <= Math.max(start, end); seconds += 1) values.add(seconds);
      continue;
    }
    const seconds = Math.round(Number(part));
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 120) values.add(seconds);
  }
  return Array.from(values).sort((left, right) => left - right);
}

export function formatBoardVideoDurationOptions(value: unknown): string {
  const options = normalizeBoardVideoDurationOptions(value);
  if (!options.length) return "";
  if (options.length > 2 && options.every((seconds, index) => index === 0 || seconds === options[index - 1] + 1)) {
    return `${options[0]}-${options.at(-1)}`;
  }
  return options.join(",");
}

export function defaultBoardVideoDurationOptions(model?: string | null): number[] {
  const normalized = String(model || "").trim();
  return normalized ? [...(BOARD_VIDEO_PROFILES[normalized]?.defaultDurationOptions ?? [])] : [];
}

export function defaultBoardVideoMaxReferenceImages(model?: string | null): number {
  const normalized = String(model || "").trim();
  return normalized ? BOARD_VIDEO_PROFILES[normalized]?.maxReferenceImages ?? 0 : 0;
}

export function defaultBoardVideoMaxReferenceVideos(model?: string | null): number {
  const normalized = String(model || "").trim();
  return normalized ? BOARD_VIDEO_PROFILES[normalized]?.maxReferenceVideos ?? 0 : 0;
}

export function defaultBoardVideoMaxReferenceAudios(model?: string | null): number {
  const normalized = String(model || "").trim();
  return normalized ? BOARD_VIDEO_PROFILES[normalized]?.maxReferenceAudios ?? 0 : 0;
}

function normalizedChannelPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") ? path.replace(/\/+$/, "") || "/" : "";
}

/**
 * The legacy and current rjm video-ds APIs use the same model id. Distinguish
 * them by the saved channel contract rather than changing every video-ds
 * channel together. Media support is opt-in: a channel must explicitly
 * declare video or audio capacity as well as the documented endpoint trio.
 */
function usesRjmusMultimediaChannelContract(
  channel: BoardVideoChannelCapabilities | string | null | undefined,
  base: BoardVideoProtocolBase,
  maxReferenceVideos: number,
  maxReferenceAudios: number,
) {
  if (typeof channel !== "object" || channel === null || base.protocol !== "jimeng") return false;
  return (maxReferenceVideos > 0 || maxReferenceAudios > 0)
    && normalizedChannelPath(channel.submitPath) === "/videos"
    && normalizedChannelPath(channel.statusPath) === "/videos/{id}"
    && normalizedChannelPath(channel.contentPath) === "/videos/{id}/content";
}

/** LGY media references use `extra`, but require the same explicit endpoint contract. */
function usesLingganyaDirectReplacementContract(
  channel: BoardVideoChannelCapabilities | string | null | undefined,
  base: BoardVideoProtocolBase,
  maxReferenceVideos: number,
) {
  if (typeof channel !== "object" || channel === null || base.protocol !== "lingganya") return false;
  return maxReferenceVideos > 0
    && normalizedChannelPath(channel.submitPath) === "/videos"
    && normalizedChannelPath(channel.statusPath) === "/videos/{id}"
    && normalizedChannelPath(channel.contentPath) === "/videos/{id}/content";
}

export function getBoardVideoProfile(
  channelOrModel?: BoardVideoChannelCapabilities | string | null,
): BoardVideoProfile | null {
  const model = typeof channelOrModel === "string"
    ? channelOrModel
    : channelOrModel?.model;
  const normalized = String(model || "").trim();
  const base = normalized
    ? BOARD_VIDEO_PROFILES[normalized]
      ?? (typeof channelOrModel === "object" && channelOrModel !== null && isLingganyaBoardVideoBaseUrl(channelOrModel.baseUrl)
        ? dynamicLingganyaBoardVideoProfile(normalized)
        : isMikotoBoardVideoChannel(channelOrModel)
          ? mikotoBoardVideoProfile(normalized)
          : isMikotoSoraBoardVideoChannel(channelOrModel)
            ? mikotoSoraBoardVideoProfile(normalized)
            : null)
    : null;
  if (!base) return null;

  // Existing known channels receive their declared migration defaults. New
  // channels must explicitly provide a valid duration list before they can be
  // used by the board.
  const configured = typeof channelOrModel === "object" && channelOrModel !== null
    ? normalizeBoardVideoDurationOptions(channelOrModel.durationOptions)
    : [];
  const hasExplicitOptions = typeof channelOrModel === "object"
    && channelOrModel !== null
    && Array.isArray(channelOrModel.durationOptions);
  const durationOptions = configured.length
    ? configured
    : hasExplicitOptions
      ? []
      : [...base.defaultDurationOptions];
  if (!durationOptions.length) return null;
  if ((base.protocol === "mikoto" || base.protocol === "mikoto_sora") && durationOptions.some((seconds) => seconds < 4 || seconds > 15)) return null;
  const generationSeconds = durationOptions.at(-1)!;
  const configuredResolution = typeof channelOrModel === "object" && channelOrModel !== null
    ? normalizeBoardVideoResolution(channelOrModel.resolution)
    : null;
  const resolution = configuredResolution && base.resolutionOptions.includes(configuredResolution)
    ? configuredResolution
    : base.resolution;
  const configuredReferenceLimit = typeof channelOrModel === "object" && channelOrModel !== null
    ? normalizeBoardVideoMaxReferenceImages(channelOrModel.maxReferenceImages)
    : null;
  const maxReferenceImages = configuredReferenceLimit ?? base.maxReferenceImages;
  const configuredVideoReferenceLimit = typeof channelOrModel === "object" && channelOrModel !== null
    ? normalizeBoardVideoMaxReferenceVideos(channelOrModel.maxReferenceVideos)
    : null;
  const maxReferenceVideos = configuredVideoReferenceLimit ?? base.maxReferenceVideos;
  const configuredAudioReferenceLimit = typeof channelOrModel === "object" && channelOrModel !== null
    ? normalizeBoardVideoMaxReferenceAudios(channelOrModel.maxReferenceAudios)
    : null;
  const maxReferenceAudios = configuredAudioReferenceLimit ?? base.maxReferenceAudios;
  const protocol = isMikotoBoardVideoChannel(channelOrModel)
    ? "mikoto" as const
    : isMikotoSoraBoardVideoChannel(channelOrModel)
      ? "mikoto_sora" as const
    : usesRjmusMultimediaChannelContract(
    channelOrModel,
    base,
    maxReferenceVideos,
    maxReferenceAudios,
  ) ? "rjmus_multimedia" as const : base.protocol;
  const referenceField = protocol === "rjmus_multimedia" ? "images" as const : base.referenceField;
  const directVideoReplacement = (protocol === "rjmus_multimedia"
    || protocol === "mikoto"
    || protocol === "mikoto_sora"
    || usesLingganyaDirectReplacementContract(channelOrModel, base, maxReferenceVideos))
    && maxReferenceImages >= 4
    && maxReferenceVideos >= 1;
  const directVideoReplacementPromptLanguage = normalizeBoardVideoPromptLanguage(
    typeof channelOrModel === "object" && channelOrModel !== null
      ? channelOrModel.directVideoReplacementPromptLanguage
      : undefined,
  );
  const directVideoReplacementSceneOptional = directVideoReplacement
    && typeof channelOrModel === "object"
    && channelOrModel !== null
    && channelOrModel.directVideoReplacementSceneOptional === true;
  const directVideoReplacementReferenceContract = directVideoReplacement
    ? normalizeDirectVideoReplacementReferenceContract(
      typeof channelOrModel === "object" && channelOrModel !== null
        ? channelOrModel.directVideoReplacementReferenceContract
        : undefined,
    )
    : "product_board_face_model";
  const directVideoReplacementPromptVersion: DirectVideoReplacementPromptVersion = directVideoReplacement
    && typeof channelOrModel === "object"
    && channelOrModel !== null
    && channelOrModel.directVideoReplacementPromptVersion === "v2"
    ? "v2"
    : "v1";
  // This is deliberately saved per channel. A missing face image is only
  // valid when the exact product-front channel opts into reference-video
  // identity retention; model name, provider, and sibling channels never opt
  // one another in.
  const directVideoReplacementFaceOptional = directVideoReplacement
    && directVideoReplacementReferenceContract === "product_front_face"
    && typeof channelOrModel === "object"
    && channelOrModel !== null
    && channelOrModel.directVideoReplacementFaceOptional === true;
  const channelId = typeof channelOrModel === "object" && channelOrModel !== null
    ? String(channelOrModel.id || "")
    : "";
  const directReplacementPromptRevision = !directVideoReplacement
    || directVideoReplacementReferenceContract !== "product_front_face"
    ? ""
    : directVideoReplacementPromptLanguage === "zh-CN"
      ? ":platform-overlay-v1"
      : protocol === "mikoto_sora"
        ? ":product-front-face-en-mikoto-face-hard-lock-v1"
        : ":product-front-face-en-v1";
  const directReplacementFaceFallbackRevision = directVideoReplacementFaceOptional
    ? ":reference-video-face-v1"
    : "";
  const directReplacementMediaRevision = directVideoReplacement
    && protocol === "lingganya"
    ? normalized.toLowerCase() === "sd-2.0-g"
      ? ":sd20g-edit-v1-top-level-media-duration-ratio"
      : normalized.toLowerCase() === "sd-2.0-mini"
        ? ":sd20mini-unified-v1-seconds-size-extra-media"
      : normalized.toLowerCase() === "sd-2.0-vip"
        ? ":explicit-media-binding-v2-no-generate-audio"
        : ""
    : "";
  const capabilitySignature = [
    "board-video-v7",
    channelId,
    normalized,
    protocol,
    durationOptions.join(","),
    generationSeconds,
    base.aspectRatio,
    resolution,
    maxReferenceImages,
    maxReferenceVideos,
    maxReferenceAudios,
    base.referenceImageCount,
    referenceField,
    directVideoReplacement
      ? `direct-video-replace-v2:${directVideoReplacementPromptLanguage}:${directVideoReplacementReferenceContract}:${directVideoReplacementPromptVersion}:${directVideoReplacementSceneOptional ? "scene-optional" : "scene-required"}${directReplacementPromptRevision}${directReplacementFaceFallbackRevision}${directReplacementMediaRevision}`
      : "director-segments",
    normalizedChannelPath(typeof channelOrModel === "object" && channelOrModel !== null ? channelOrModel.submitPath : ""),
    normalizedChannelPath(typeof channelOrModel === "object" && channelOrModel !== null ? channelOrModel.statusPath : ""),
    normalizedChannelPath(typeof channelOrModel === "object" && channelOrModel !== null ? channelOrModel.contentPath : ""),
  ].join("|");
  return {
    ...base,
    model: normalized,
    protocol,
    resolution,
    referenceField,
    durationOptions,
    generationSeconds,
    maxReferenceImages,
    maxReferenceVideos,
    maxReferenceAudios,
    directVideoReplacement,
    directVideoReplacementPromptLanguage,
    directVideoReplacementSceneOptional,
    directVideoReplacementFaceOptional,
    directVideoReplacementReferenceContract,
    directVideoReplacementPromptVersion,
    capabilitySignature,
  };
}

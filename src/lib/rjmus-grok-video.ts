import {
  getBoardVideoProfile,
  type DirectVideoReplacementReferenceContract,
} from "@/lib/board-video-protocol";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MIKOTO_MODEL_CATALOGUE_ATTEMPTS = 3;
const MIKOTO_MODEL_CATALOGUE_RETRY_DELAYS_MS = [400, 1_000] as const;
/** Grok rejects prompts above 4096 UTF-8 bytes, not above 4096 JavaScript characters. */
export const GROK_VIDEO_PROMPT_MAX_BYTES = 4096;
// Kept as a compatibility export for callers that still import the old name.
export const GROK_VIDEO_PROMPT_MAX_CHARS = GROK_VIDEO_PROMPT_MAX_BYTES;

type JsonRecord = Record<string, unknown>;

type VideoRequestTrace = {
  requestId?: string;
  upstreamRequestId?: string;
};

type VideoApiResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: {
    get: (name: string) => string | null;
  };
};

export class RjmusGrokVideoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "RjmusGrokVideoError";
  }
}

export type RjmusVideoTaskStatus = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  /** A completed rjm task returns its signed download links in data[].url. */
  resultUrls: string[];
  /** The returned result URL is the protected, configured content endpoint. */
  contentRequiresApiKey?: boolean;
  raw: JsonRecord;
};

type RjmusVideoChannelInput = {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  videoProtocol?: "mikoto" | "mikoto_sora";
  submitPath?: string;
  statusPath?: string;
  contentPath?: string;
  resolution?: "720p" | "1080p";
  durationOptions?: number[];
  generationSeconds?: number;
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
  directVideoReplacementSceneOptional?: boolean;
  directVideoReplacementFaceOptional?: boolean;
  directVideoReplacementReferenceContract?: DirectVideoReplacementReferenceContract;
};

function isLingganyaBoardVideoChannel(channel: Pick<RjmusVideoChannelInput, "model"> & Partial<RjmusVideoChannelInput>) {
  return getBoardVideoProfile(channel)?.protocol === "lingganya";
}

function isRjmusMultimediaBoardVideoChannel(channel: Pick<RjmusVideoChannelInput, "model"> & Partial<RjmusVideoChannelInput>) {
  return getBoardVideoProfile(channel)?.protocol === "rjmus_multimedia";
}

function isMikotoBoardVideoChannel(channel: Pick<RjmusVideoChannelInput, "model"> & Partial<RjmusVideoChannelInput>) {
  return getBoardVideoProfile(channel)?.protocol === "mikoto";
}
function isMikotoSoraBoardVideoChannel(channel: Pick<RjmusVideoChannelInput, "model"> & Partial<RjmusVideoChannelInput>) {
  return getBoardVideoProfile(channel)?.protocol === "mikoto_sora";
}

function cleanBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const withoutEndpoint = trimmed
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1$/i, "");
  if (!/^https:\/\//i.test(withoutEndpoint)) {
    throw new RjmusGrokVideoError("视频通道 Base URL 必须是公网 HTTPS 地址。", "INVALID_BASE_URL");
  }
  return `${withoutEndpoint}/v1`;
}

function endpoint(baseUrl: string, path: string) {
  return `${cleanBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function requiredChannelPath(value: string | undefined, label: string) {
  const path = String(value || "").trim();
  if (!path.startsWith("/")) {
    throw new RjmusGrokVideoError(`当前视频通道缺少有效的${label}。`, "INVALID_CHANNEL_PROTOCOL");
  }
  return path;
}

function taskPath(template: string | undefined, taskId: string, label: string) {
  const path = requiredChannelPath(template, label);
  if (!path.includes("{id}")) {
    throw new RjmusGrokVideoError(`当前视频通道的${label}必须包含 {id}。`, "INVALID_CHANNEL_PROTOCOL");
  }
  return path.replaceAll("{id}", encodeURIComponent(taskId));
}

async function responsePayload(response: VideoApiResponse) {
  const text = await response.text().catch(() => "");
  if (!text) return {} as JsonRecord;
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    return { raw: text.slice(0, 1000) } as JsonRecord;
  }
}

function nestedError(payload: JsonRecord): string {
  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as JsonRecord;
    if (typeof record.message === "string") return record.message;
    if (typeof record.code === "string") return record.code;
  }
  for (const key of ["message", "error_message", "reason"]) {
    if (typeof payload[key] === "string") return String(payload[key]);
  }
  for (const key of ["data", "task", "result"]) {
    const nested = payload[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const message: string = nestedError(nested as JsonRecord);
      if (message) return message;
    }
  }
  return "";
}

function payloadString(payload: JsonRecord, keys: string[]) {
  for (const key of keys) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
  }
  const nested = payload.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return payloadString(nested as JsonRecord, keys);
  const error = payload.error;
  if (error && typeof error === "object") return payloadString(error as JsonRecord, keys);
  return "";
}

function requestTrace(response: VideoApiResponse, payload: JsonRecord): VideoRequestTrace {
  return {
    requestId: response.headers.get("x-request-id")
      || response.headers.get("request-id")
      || payloadString(payload, ["request_id", "requestId"])
      || undefined,
    upstreamRequestId: response.headers.get("x-upstream-request-id")
      || payloadString(payload, ["upstream_request_id", "upstreamRequestId"])
      || undefined,
  };
}

async function fetchJson(
  url: string,
  apiKey: string,
  init: RequestInit,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new RjmusGrokVideoError(
      `视频通道网络请求失败：${error instanceof Error ? error.message : String(error)}`,
      "NETWORK_ERROR",
    );
  }
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new RjmusGrokVideoError(
      `视频通道请求失败（HTTP ${response.status}）：${nestedError(payload) || JSON.stringify(payload).slice(0, 500)}`,
      "API_ERROR",
      response.status,
    );
  }
  return { response, payload, trace: requestTrace(response, payload) };
}

function mikotoNetworkFailureCategory(error: unknown) {
  const values: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (current instanceof Error) {
      values.push(current.message, current.name);
      current = "cause" in current ? current.cause : undefined;
    } else {
      values.push(String(current));
      break;
    }
  }
  const summary = values.join(" ").toLowerCase();
  if (/econnreset|socket hang up|connection reset/.test(summary)) return "连接被重置";
  if (/etimedout|timeout|timed out/.test(summary)) return "连接超时";
  if (/enotfound|getaddrinfo|dns/.test(summary)) return "域名解析失败";
  if (/econnrefused|connection refused/.test(summary)) return "代理或上游拒绝连接";
  if (/certificate|self signed|tls|ssl/.test(summary)) return "TLS 连接失败";
  return "连接阶段未收到上游响应";
}

function waitForMikotoCatalogueRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function hasConfiguredOutboundProxy() {
  return Boolean(
    process.env.http_proxy?.trim()
      || process.env.HTTP_PROXY?.trim()
      || process.env.https_proxy?.trim()
      || process.env.HTTPS_PROXY?.trim()
      || process.env.all_proxy?.trim()
      || process.env.ALL_PROXY?.trim(),
  );
}

function mikotoModelCatalogueDispatcher(): Dispatcher {
  const options = {
    connectTimeout: 60_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  };
  // Node's implicit environment-proxy dispatcher intermittently resets an
  // authenticated Mikoto catalogue request in the long-running 3100 process.
  // Build and close a dispatcher for this non-billable MK preflight only; do
  // not share it with task creation, polling, downloads, or other providers.
  return hasConfiguredOutboundProxy()
    ? new EnvHttpProxyAgent(options)
    : new Agent(options);
}

/**
 * The Mikoto catalogue request is a non-billable preflight and has no task ID.
 * It is therefore safe to retry a bounded number of connection-stage failures.
 * Never reuse this helper for task creation, status polling, or content download.
 */
async function verifyMikotoModelCatalogue(input: RjmusVideoChannelInput) {
  const url = endpoint(input.baseUrl, "/models");
  for (let attempt = 1; attempt <= MIKOTO_MODEL_CATALOGUE_ATTEMPTS; attempt += 1) {
    const dispatcher = mikotoModelCatalogueDispatcher();
    try {
      let response: VideoApiResponse;
      try {
        response = await undiciFetch(url, {
          method: "GET",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Connection: "close",
          },
          dispatcher,
        });
      } catch (error) {
        if (attempt < MIKOTO_MODEL_CATALOGUE_ATTEMPTS) {
          await waitForMikotoCatalogueRetry(MIKOTO_MODEL_CATALOGUE_RETRY_DELAYS_MS[attempt - 1]!);
          continue;
        }
        throw new RjmusGrokVideoError(
          `Mikoto ${input.model} 模型目录网络校验失败（已安全重试 ${MIKOTO_MODEL_CATALOGUE_ATTEMPTS} 次；${mikotoNetworkFailureCategory(error)}）。未创建视频任务。`,
          "MIKOTO_CATALOGUE_NETWORK_ERROR",
        );
      }
      const payload = await responsePayload(response);
      if (!response.ok) {
        throw new RjmusGrokVideoError(
          `视频通道请求失败（HTTP ${response.status}）：${nestedError(payload) || JSON.stringify(payload).slice(0, 500)}`,
          "API_ERROR",
          response.status,
        );
      }
      return { payload, trace: requestTrace(response, payload) };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  throw new RjmusGrokVideoError("Mikoto 模型目录校验未返回结果。", "MIKOTO_CATALOGUE_NETWORK_ERROR");
}

export function assertCurrentBoardVideoChannel(channel: Partial<RjmusVideoChannelInput>) {
  if (!channel.apiKey?.trim() || !channel.baseUrl?.trim()) {
    throw new RjmusGrokVideoError("缺少当前视频通道的 Base URL 或 API Key。", "MISSING_CHANNEL");
  }
  if (!getBoardVideoProfile(channel)) {
    throw new RjmusGrokVideoError(
      "画板视频工作流只接受已配置的视频模型。",
      "UNSUPPORTED_MODEL",
    );
  }
  cleanBaseUrl(channel.baseUrl);
  if (isRjmusMultimediaBoardVideoChannel(channel as RjmusVideoChannelInput) || isMikotoBoardVideoChannel(channel as RjmusVideoChannelInput) || isMikotoSoraBoardVideoChannel(channel as RjmusVideoChannelInput)) {
    requiredChannelPath(channel.submitPath, "提交路径");
    taskPath(channel.statusPath, "channel-check", "查询路径");
    taskPath(channel.contentPath, "channel-check", "视频文件路径");
  }
}

/** Reject overlong Grok prompts locally so an invalid request never reaches the paid upstream task API. */
export function assertBoardVideoPromptWithinLimit(model: string, prompt: string) {
  const profile = getBoardVideoProfile(model);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (profile?.protocol === "grok" && promptBytes > GROK_VIDEO_PROMPT_MAX_BYTES) {
    throw new RjmusGrokVideoError(
      `当前视频任务提示词为 ${promptBytes} 个 UTF-8 字节，超过 Grok 的 ${GROK_VIDEO_PROMPT_MAX_BYTES} 字节上限。请重新生成更精简的完整视频导演稿。`,
      "PROMPT_TOO_LONG",
    );
  }
}

export async function submitRjmusGrokVideo(input: RjmusVideoChannelInput & {
  prompt: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
}) {
  assertCurrentBoardVideoChannel(input);
  const profile = getBoardVideoProfile(input);
  const generationSeconds = Math.round(Number(input.generationSeconds || profile?.generationSeconds || 0));
  if (!profile) throw new RjmusGrokVideoError("当前视频模型不受画板协议支持。", "UNSUPPORTED_MODEL");
  if (!profile.durationOptions.includes(generationSeconds)) {
    throw new RjmusGrokVideoError("当前视频任务时长不在模型池声明的可用秒数中。", "INVALID_DURATION");
  }
  assertBoardVideoPromptWithinLimit(input.model, input.prompt);
  const imageUrls = (input.imageUrls?.length ? input.imageUrls : [input.imageUrl || ""])
    .map((url) => String(url || "").trim())
    .filter(Boolean);
  const isLingganya = isLingganyaBoardVideoChannel(input);
  const isLingganyaSd20Vip = isLingganya && input.model.trim().toLowerCase() === "sd-2.0-vip";
  const isLingganyaSd20G = isLingganya && input.model.trim().toLowerCase() === "sd-2.0-g";
  const isLingganyaSd20Mini = isLingganya && input.model.trim().toLowerCase() === "sd-2.0-mini";
  const usesLingganyaFileIds = isLingganyaSd20Vip || isLingganyaSd20G || isLingganyaSd20Mini;
  const isLingganyaReference = (value: string) => /^https:\/\//i.test(value) || /^file_[a-zA-Z0-9_-]+$/.test(value);
  const validImageReference = usesLingganyaFileIds
    ? isLingganyaReference
    : (value: string) => /^https:\/\//i.test(value);
  const allowedImageCounts = profile.directVideoReplacement
    ? profile.directVideoReplacementReferenceContract === "product_front_face"
      ? profile.directVideoReplacementFaceOptional
        ? (profile.directVideoReplacementSceneOptional ? [1, 2, 3] : [2, 3])
        : (profile.directVideoReplacementSceneOptional ? [2, 3] : [3])
      : (profile.directVideoReplacementSceneOptional ? [3, 4] : [4])
    : [profile.referenceImageCount];
  if (
    !allowedImageCounts.includes(imageUrls.length)
    || imageUrls.some((url) => !validImageReference(url))
  ) {
    const imageCountDescription = allowedImageCounts.length > 1
      ? allowedImageCounts.join(" 或 ")
      : String(allowedImageCounts[0]);
    throw new RjmusGrokVideoError(
      usesLingganyaFileIds
        ? `当前视频模型需要 ${imageCountDescription} 张公网 HTTPS 参考图或灵感鸭临时图片 file_id。`
        : `当前视频模型需要 ${imageCountDescription} 张公网 HTTPS 参考图。`,
      "INVALID_REFERENCES",
    );
  }

  const videoUrls = (input.videoUrls || []).map((url) => String(url || "").trim()).filter(Boolean);
  const audioUrls = (input.audioUrls || []).map((url) => String(url || "").trim()).filter(Boolean);
  const isMikoto = isMikotoBoardVideoChannel(input);
  const isMikotoSora = isMikotoSoraBoardVideoChannel(input);
  const invalidMediaReference = (urls: string[], limit: number, label: string) => (
    urls.length > limit || urls.some((url) => !(usesLingganyaFileIds
      ? isLingganyaReference(url)
      : isMikoto
        ? /^(https:\/\/|data:(video|audio)\/[^;,]+;base64,)/i.test(url)
        : /^https:\/\//i.test(url)))
      ? new RjmusGrokVideoError(
        usesLingganyaFileIds
          ? `当前视频通道最多接收 ${limit} 个公网 HTTPS ${label}或同类型灵感鸭临时 file_id。`
          : `当前视频通道最多接收 ${limit} 个公网 HTTPS ${label}。`,
        "INVALID_REFERENCES",
      )
      : null
  );
  const invalidVideoReference = invalidMediaReference(videoUrls, profile.maxReferenceVideos, "参考视频");
  if (invalidVideoReference) throw invalidVideoReference;
  const invalidAudioReference = invalidMediaReference(audioUrls, profile.maxReferenceAudios, "参考音频");
  if (invalidAudioReference) throw invalidAudioReference;
  if (isMikotoSora && imageUrls.length + videoUrls.length + audioUrls.length > 12) {
    throw new RjmusGrokVideoError("MKOSOR 的图片、视频和音频素材合计最多 12 个。", "INVALID_REFERENCES");
  }
  if (isLingganyaSd20Vip && imageUrls.length + videoUrls.length + audioUrls.length > 12) {
    throw new RjmusGrokVideoError("sd-2.0-vip 的图片、视频和音频素材合计最多 12 个。", "INVALID_REFERENCES");
  }
  if (isLingganyaSd20G && imageUrls.length + videoUrls.length + audioUrls.length > 15) {
    throw new RjmusGrokVideoError("sd-2.0-g 的图片、视频和音频素材合计最多 15 个。", "INVALID_REFERENCES");
  }
  if (isLingganyaSd20Mini && imageUrls.length + videoUrls.length + audioUrls.length > 12) {
    throw new RjmusGrokVideoError("sd-2.0-mini 的图片、视频和音频素材合计最多 12 个。", "INVALID_REFERENCES");
  }
  if (isLingganyaSd20Mini && (videoUrls.length > 0 || audioUrls.length > 0) && imageUrls.length === 0) {
    throw new RjmusGrokVideoError("sd-2.0-mini 使用参考视频或音频时至少需要 1 张参考图。", "INVALID_REFERENCES");
  }

  const isMultimedia = isRjmusMultimediaBoardVideoChannel(input);
  const requestBody: JsonRecord = isMikotoSora ? {
    model: input.model, prompt: input.prompt, seconds: String(generationSeconds), aspect_ratio: profile.aspectRatio, resolution: "720p",
    image_url: imageUrls[0], reference_image_urls: imageUrls.slice(1),
    ...(videoUrls.length > 0 ? { reference_videos: videoUrls } : {}),
    ...(audioUrls.length > 0 ? { audio_url: audioUrls.length === 1 ? audioUrls[0] : audioUrls } : {}),
    video_config: { reference_mode: "auto" },
  } : isMikoto ? {
    model: input.model,
    prompt: input.prompt,
    duration: generationSeconds,
    aspect_ratio: profile.aspectRatio,
    images: imageUrls,
    reference_mode: profile.directVideoReplacement ? "media" : "frame",
    ...(videoUrls.length > 0 ? { referenceVideos: videoUrls } : {}),
    ...(audioUrls.length > 0 ? { referenceAudios: audioUrls } : {}),
    generate_audio: true,
  } : isMultimedia ? {
    model: input.model,
    prompt: input.prompt,
    // This API documents seconds as a string, unlike the legacy async route.
    seconds: String(generationSeconds),
    aspect_ratio: profile.aspectRatio,
    images: imageUrls,
    ...(videoUrls.length > 0 ? { videos: videoUrls } : {}),
    ...(audioUrls.length > 0 ? { audios: audioUrls } : {}),
  } : isLingganyaSd20G ? {
    model: input.model,
    prompt: input.prompt,
    duration: generationSeconds,
    resolution: profile.resolution,
    ratio: profile.aspectRatio,
    images: imageUrls,
    ...(videoUrls.length > 0 ? { videos: videoUrls } : {}),
    ...(audioUrls.length > 0 ? { audios: audioUrls } : {}),
  } : isLingganya ? {
    model: input.model,
    prompt: input.prompt,
    // Lingganya requires an integer 4–15 and model-specific top-level resolution.
    seconds: generationSeconds,
    resolution: profile.resolution,
    size: profile.aspectRatio,
    images: imageUrls,
    // Lingganya's saved sd-2.0-vip channel accepts reference media here.
    // Keep `model` exactly as configured above; an upstream backend name in an
    // error response is not a client-side model alias or rewrite instruction.
    extra: {
      ...(!isLingganyaSd20Vip && !profile.directVideoReplacement ? { reference_mode: "frame" } : {}),
      ...(profile.directVideoReplacement && videoUrls.length > 0 ? { reference_videos: videoUrls } : {}),
      ...(profile.directVideoReplacement && audioUrls.length > 0 ? { reference_audios: audioUrls } : {}),
      ...(!isLingganyaSd20Vip && !profile.directVideoReplacement ? { generate_audio: true } : {}),
    },
  } : profile.referenceField === "image_urls" ? {
    model: input.model,
    prompt: input.prompt,
    resolution: profile.resolution,
    aspect_ratio: profile.aspectRatio,
    seconds: generationSeconds,
    image_urls: imageUrls,
  } : {
    model: input.model,
    prompt: input.prompt,
    resolution: profile.resolution,
    aspect_ratio: profile.aspectRatio,
    // rjm requires a JSON number, not the old string form.
    seconds: generationSeconds,
    image_url: imageUrls[0],
  };
  const { response, payload, trace } = await fetchJson(
    endpoint(input.baseUrl, isMikoto || isMikotoSora || isMultimedia
      ? requiredChannelPath(input.submitPath, "提交路径")
      : isLingganya ? "/videos" : "/videos/generations"),
    input.apiKey,
    { method: "POST", body: JSON.stringify(requestBody) },
  );
  if (!isLingganya && !isMultimedia && !isMikoto && !isMikotoSora && response.status !== 202) {
    throw new RjmusGrokVideoError(`视频任务创建接口必须返回 HTTP 202，实际为 ${response.status}。`, "INVALID_SUBMIT_STATUS", response.status);
  }
  const taskId = payloadString(payload, ["taskId", "task_id", "id"]);
  if (!taskId) {
    throw new RjmusGrokVideoError("视频任务创建响应缺少 taskId。", "NO_TASK_ID");
  }
  return { taskId, ...trace };
}

export async function verifyRjmusGrokVideoChannel(input: RjmusVideoChannelInput) {
  assertCurrentBoardVideoChannel(input);
  if (isLingganyaBoardVideoChannel(input)) {
    // Live LGY model catalogues are available at this endpoint. It lets the
    // settings page verify the exact account-scoped model name without creating
    // a billable video task.
    const { payload, trace } = await fetchJson(
      endpoint(input.baseUrl, "/models"),
      input.apiKey,
      { method: "GET" },
    );
    const modelItems = Array.isArray(payload.data) ? payload.data : [];
    const modelIds = modelItems
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const record = item as JsonRecord;
          return String(record.id || record.name || record.model || "").trim();
        }
        return "";
      })
      .filter(Boolean);
    return {
      ...trace,
      modelIds,
      modelVisible: modelIds.includes(input.model.trim()),
    };
  }
  const isMultimedia = isRjmusMultimediaBoardVideoChannel(input);
  const isMikoto = isMikotoBoardVideoChannel(input);
  const isMikotoSora = isMikotoSoraBoardVideoChannel(input);
  const { payload, trace } = isMikoto || isMikotoSora
    ? await verifyMikotoModelCatalogue(input)
    : await fetchJson(
      endpoint(input.baseUrl, isMultimedia ? "/models" : "/models?type=video"),
      input.apiKey,
      { method: "GET" },
    );
  const modelItems = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const modelIds = modelItems
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const record = item as JsonRecord;
        return String(record.id || record.name || record.model || "").trim();
      }
      return "";
    })
    .filter(Boolean);
  // The model catalogue is advisory. Permission is ultimately confirmed by a
  // real task creation, which is deliberately not part of a non-billable test.
  return {
    ...trace,
    modelIds,
    modelVisible: modelIds.includes(input.model.trim()),
  };
}

function normalizeStatus(payload: JsonRecord): RjmusVideoTaskStatus["status"] {
  const raw = String(payload.status || payload.task_status || payload.state || "").toLowerCase();
  if (!raw) {
    for (const key of ["data", "task", "result"]) {
      const nested = payload[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        try {
          return normalizeStatus(nested as JsonRecord);
        } catch {
          // Keep checking the remaining documented wrapper shapes.
        }
      }
    }
  }
  if (["queued", "queueing", "pending", "submitted"].includes(raw)) return "queued";
  if (["running", "processing", "generating", "in_progress"].includes(raw)) return "running";
  if (["completed", "succeeded", "success", "done"].includes(raw)) return "completed";
  if (["failed", "error"].includes(raw)) return "failed";
  if (["cancelled", "canceled"].includes(raw)) return "cancelled";
  throw new RjmusGrokVideoError(`视频任务返回了无法识别的状态：${raw || "空状态"}。`, "UNKNOWN_STATUS");
}

function resultUrls(payload: JsonRecord) {
  const directUrl = payloadString(payload, ["content_url", "contentUrl", "video_url", "videoUrl", "result_url", "resultUrl"]);
  const dataUrls = Array.isArray(payload.data) ? payload.data
    .filter((item): item is JsonRecord => Boolean(item && typeof item === "object"))
    .map((item) => typeof item.url === "string" ? item.url.trim() : "")
    .filter((url) => /^https:\/\//i.test(url)) : [];
  return Array.from(new Set([
    ...(/^https:\/\//i.test(directUrl) ? [directUrl] : []),
    ...dataUrls,
  ]));
}

export async function getRjmusGrokVideoStatus(input: RjmusVideoChannelInput & {
  taskId: string;
}): Promise<RjmusVideoTaskStatus> {
  assertCurrentBoardVideoChannel(input);
  const isLingganya = isLingganyaBoardVideoChannel(input);
  const isMultimedia = isRjmusMultimediaBoardVideoChannel(input);
  const isMikoto = isMikotoBoardVideoChannel(input);
  const isMikotoSora = isMikotoSoraBoardVideoChannel(input);
  const statusPath = isMultimedia || isMikoto || isMikotoSora
    ? taskPath(input.statusPath, input.taskId, "查询路径")
    : isLingganya
    ? `/videos/${encodeURIComponent(input.taskId)}`
    : `/videos/tasks/${encodeURIComponent(input.taskId)}`;
  const { payload } = await fetchJson(
    endpoint(input.baseUrl, statusPath),
    input.apiKey,
    { method: "GET" },
  );
  const status = normalizeStatus(payload);
  const upstreamUrls = resultUrls(payload);
  const configuredContentUrl = (isMultimedia || isMikoto || isMikotoSora) && status === "completed" && upstreamUrls.length === 0
    ? endpoint(input.baseUrl, taskPath(input.contentPath, input.taskId, "视频文件路径"))
    : "";
  return {
    status,
    error: nestedError(payload) || undefined,
    resultUrls: configuredContentUrl ? [configuredContentUrl] : upstreamUrls,
    // MKOSOR returns its protected /content URL directly as `video_url`.
    // Unlike a signed storage result, it still requires the channel key.
    contentRequiresApiKey: isLingganya || isMikotoSora || Boolean(configuredContentUrl),
    raw: payload,
  };
}

/**
 * Some Lingganya tasks expose their protected MP4 before the task-status
 * endpoint accepts the same token. Probe one byte only; a successful video
 * response is sufficient to safely recover the deterministic content URL.
 */
export async function probeLingganyaCompletedVideoContent(input: RjmusVideoChannelInput & {
  taskId: string;
}) {
  assertCurrentBoardVideoChannel(input);
  if (!isLingganyaBoardVideoChannel(input)) return null;
  const contentPath = taskPath(input.contentPath || "/videos/{id}/content", input.taskId, "视频文件路径");
  const resultUrl = endpoint(input.baseUrl, contentPath);
  let response: Response;
  try {
    response = await fetch(resultUrl, {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "video/mp4,video/*",
        Range: "bytes=0-0",
      },
    });
  } catch {
    return null;
  }
  const contentType = response.headers.get("content-type") || "";
  const isVideo = /^video\//i.test(contentType);
  await response.body?.cancel().catch(() => undefined);
  return response.ok && isVideo ? resultUrl : null;
}

export async function cancelRjmusGrokVideo(input: RjmusVideoChannelInput & {
  taskId: string;
}) {
  assertCurrentBoardVideoChannel(input);
  if (
    isLingganyaBoardVideoChannel(input)
    || isRjmusMultimediaBoardVideoChannel(input)
    || isMikotoBoardVideoChannel(input)
    || isMikotoSoraBoardVideoChannel(input)
  ) {
    // The documented protocol has no task-cancel endpoint. Marking the board
    // task cancelled stops local polling without guessing an upstream route.
    return {};
  }
  const { trace } = await fetchJson(
    endpoint(input.baseUrl, `/videos/tasks/${encodeURIComponent(input.taskId)}`),
    input.apiKey,
    { method: "DELETE" },
  );
  return trace;
}

export async function downloadRjmusGrokVideo(input: {
  resultUrl: string;
  apiKey?: string;
  requiresApiKey?: boolean;
  authorizedBaseUrl?: string;
}) {
  if (!/^https:\/\//i.test(input.resultUrl)) {
    throw new RjmusGrokVideoError("上游没有返回可用的视频下载地址。", "INVALID_RESULT_URL");
  }
  if (input.requiresApiKey && input.authorizedBaseUrl) {
    try {
      if (new URL(input.resultUrl).origin !== new URL(input.authorizedBaseUrl).origin) {
        throw new RjmusGrokVideoError("受保护的视频结果地址不属于当前模型通道，已阻止发送凭证。", "INVALID_RESULT_URL");
      }
    } catch (error) {
      if (error instanceof RjmusGrokVideoError) throw error;
      throw new RjmusGrokVideoError("受保护的视频结果地址无效。", "INVALID_RESULT_URL");
    }
  }
  let response: Response;
  try {
    // rjm returns signed storage URLs, while Lingganya returns its protected
    // /content endpoint and requires the original provider key.
    response = await fetch(input.resultUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      headers: {
        Accept: "video/mp4,video/*",
        ...(input.requiresApiKey && input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
    });
  } catch (error) {
    throw new RjmusGrokVideoError(
      `视频文件下载失败：${error instanceof Error ? error.message : String(error)}`,
      "NETWORK_ERROR",
    );
  }
  if (!response.ok) {
    const payload = await responsePayload(response);
    throw new RjmusGrokVideoError(
      `视频文件暂不可用（HTTP ${response.status}）：${nestedError(payload) || JSON.stringify(payload).slice(0, 500)}`,
      "CONTENT_ERROR",
      response.status,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_VIDEO_BYTES) {
    throw new RjmusGrokVideoError("视频文件超过 1GB 安全上限。", "CONTENT_TOO_LARGE");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new RjmusGrokVideoError("视频文件响应为空。", "EMPTY_CONTENT");
  if (bytes.length > MAX_VIDEO_BYTES) throw new RjmusGrokVideoError("视频文件超过 1GB 安全上限。", "CONTENT_TOO_LARGE");
  const contentType = response.headers.get("content-type") || "video/mp4";
  return {
    bytes,
    ext: contentType.includes("webm") ? "webm" : "mp4",
    mimeType: contentType,
  };
}

export function isRetryableRjmusVideoError(error: unknown) {
  if (!(error instanceof RjmusGrokVideoError)) return false;
  if (error.code === "NETWORK_ERROR") return true;
  return Boolean(error.statusCode && [408, 409, 425, 429, 500, 502, 503, 504].includes(error.statusCode));
}

/**
 * Browser disconnects and local service restarts may interrupt a poll request
 * after the upstream video task has been submitted. These messages are not
 * upstream terminal results, so callers must retain the task ID and retry.
 */
export function isTransientVideoPollInterruption(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  return name === "AbortError"
    || /^(?:terminated|request aborted|socket closed|client disconnected)$/i.test(message.trim())
    || /\b(?:UND_ERR_ABORTED|ECONNRESET)\b/i.test(message);
}

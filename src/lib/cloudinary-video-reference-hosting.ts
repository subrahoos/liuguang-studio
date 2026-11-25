import { createHash, randomUUID } from "node:crypto";
import { Agent, FormData, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { SERVER_MANAGED_API_KEY } from "@/lib/auth-constants";
import type {
  CloudinaryReferenceCleanup,
  CloudinaryReferenceCleanupAsset,
  CloudinaryReferenceResourceType,
  VideoReferenceHostingSetting,
} from "@/lib/video-reference-hosting-types";
import { getBoardVideoProfile, type BoardVideoChannelCapabilities } from "@/lib/board-video-protocol";

const CLOUDINARY_DELETE_TIMEOUT_MS = 60 * 1000;
const CLOUDINARY_UPLOAD_MAX_ATTEMPTS = 3;
const CLOUDINARY_UPLOAD_RETRY_DELAYS_MS = [750, 2_000];
// Cloudinary uploads contain the reference bytes themselves. Do not route that
// multipart stream through the local model proxy, which has reset video uploads.
const CLOUDINARY_DIRECT_AGENT = new Agent({
  connectTimeout: 0,
  headersTimeout: 0,
  bodyTimeout: 0,
});

export type HostedVideoReference = {
  secureUrl: string;
  publicId: string;
  resourceType?: CloudinaryReferenceResourceType;
  /** Present only after Cloudinary's original delivery was byte-verified. */
  sourceBytes?: number;
  sourceSha256?: string;
  verifiedAt?: string;
};

export type HostedVideoReferenceBatch = {
  urls: string[];
  assets: HostedVideoReference[];
  transport: "original" | "cloudinary_https";
};

export type HostedVideoReferenceCleanup = CloudinaryReferenceCleanup;

function cleanSettingValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isGrokVideoModel(model: string | undefined) {
  return getBoardVideoProfile(model)?.protocol === "grok";
}

export function isBoardVideoReferenceModel(channelOrModel: BoardVideoChannelCapabilities | string | undefined) {
  return Boolean(getBoardVideoProfile(channelOrModel));
}

export function isReadyVideoReferenceHosting(
  setting: VideoReferenceHostingSetting | null | undefined,
): setting is VideoReferenceHostingSetting {
  return Boolean(
    setting?.enabled !== false
    && setting?.provider === "cloudinary"
    && cleanSettingValue(setting.cloudName)
    && cleanSettingValue(setting.apiKey)
    && cleanSettingValue(setting.apiSecret),
  );
}

export function mergeVideoReferenceHostingSetting(
  incoming: VideoReferenceHostingSetting | null | undefined,
  existing: VideoReferenceHostingSetting | null | undefined,
): VideoReferenceHostingSetting | undefined {
  if (!incoming) return existing ?? undefined;
  return {
    provider: "cloudinary",
    enabled: incoming.enabled !== false,
    cloudName: cleanSettingValue(incoming.cloudName),
    apiKey: incoming.apiKey === SERVER_MANAGED_API_KEY
      ? cleanSettingValue(existing?.apiKey)
      : cleanSettingValue(incoming.apiKey),
    apiSecret: incoming.apiSecret === SERVER_MANAGED_API_KEY
      ? cleanSettingValue(existing?.apiSecret)
      : cleanSettingValue(incoming.apiSecret),
  };
}

export function signCloudinaryParameters(
  parameters: Record<string, string | number>,
  apiSecret: string,
) {
  const serialized = Object.entries(parameters)
    .filter(([, value]) => String(value).length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${serialized}${apiSecret}`).digest("hex");
}

function assertCloudinarySetting(setting: VideoReferenceHostingSetting) {
  if (!isReadyVideoReferenceHosting(setting)) {
    throw new Error("视频参考图需要先在“模型与API”中完成 Cloudinary 公网托管配置。");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(setting.cloudName)) {
    throw new Error("Cloudinary Cloud name 格式不正确。");
  }
  return {
    cloudName: setting.cloudName.trim(),
    apiKey: setting.apiKey.trim(),
    apiSecret: setting.apiSecret.trim(),
  };
}

function safeIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18) || "asset";
}

type BinaryReferenceSource = {
  blob: Blob;
  bytes: number;
  sha256: string;
  fileName: string;
};

function fileExtensionForMimeType(mimeType: string, resourceType: CloudinaryReferenceResourceType) {
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  const known = new Map([
    ["video/mp4", "mp4"],
    ["video/webm", "webm"],
    ["video/quicktime", "mov"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/wav", "wav"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]);
  return known.get(normalized) || (resourceType === "video" ? "mp4" : "png");
}

function binaryDataUriSource(source: string, resourceType: CloudinaryReferenceResourceType): BinaryReferenceSource | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match) return null;
  const mimeType = (match[1] || "application/octet-stream").trim();
  let bytes: Buffer;
  try {
    bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
  } catch {
    throw new Error("参考素材 Data URI 无法解码为原始二进制文件。");
  }
  if (bytes.length === 0) throw new Error("参考素材文件为空，不能上传到 Cloudinary。");
  // Copy into a concrete ArrayBuffer-backed view. Node's Buffer permits a
  // SharedArrayBuffer backing type, while the Web Blob type deliberately does not.
  const blobBytes = new Uint8Array(bytes.length);
  blobBytes.set(bytes);
  return {
    blob: new Blob([blobBytes], { type: mimeType }),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fileName: `reference.${fileExtensionForMimeType(mimeType, resourceType)}`,
  };
}

function assertOriginalCloudinaryDeliveryUrl(
  secureUrl: string,
  cloudName: string,
  resourceType: CloudinaryReferenceResourceType,
) {
  let parsed: URL;
  try {
    parsed = new URL(secureUrl);
  } catch {
    throw new Error("Cloudinary 上传成功，但返回的 HTTPS URL 无法解析。");
  }
  const prefix = `/${cloudName}/${resourceType}/upload/`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com" || !parsed.pathname.startsWith(prefix)) {
    throw new Error("Cloudinary 返回的不是可用于原始素材校验的标准 HTTPS URL。");
  }
  // A version must immediately follow /upload/. Any preceding segment would be
  // a delivery transformation, which is forbidden for model reference assets.
  const relativePath = parsed.pathname.slice(prefix.length);
  if (!/^v\d+\//.test(relativePath)) {
    throw new Error("Cloudinary 返回的参考素材 URL 含有变换或缺少原始版本，不能发送给视频模型。");
  }
}

async function cloudinaryDirectFetch(url: string, init?: Omit<UndiciRequestInit, "dispatcher">) {
  return undiciFetch(url, {
    ...init,
    dispatcher: CLOUDINARY_DIRECT_AGENT,
  });
}

async function verifyCloudinaryOriginalReference(input: {
  secureUrl: string;
  cloudName: string;
  resourceType: CloudinaryReferenceResourceType;
  source: BinaryReferenceSource;
}) {
  assertOriginalCloudinaryDeliveryUrl(input.secureUrl, input.cloudName, input.resourceType);
  let response: Awaited<ReturnType<typeof cloudinaryDirectFetch>>;
  try {
    response = await cloudinaryDirectFetch(input.secureUrl);
  } catch (error) {
    throw new Error(`Cloudinary 原始参考素材回读失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Cloudinary 原始参考素材回读失败：HTTP ${response.status}`);
  }
  const deliveredBytes = Buffer.from(await response.arrayBuffer());
  const deliveredSha256 = createHash("sha256").update(deliveredBytes).digest("hex");
  if (deliveredBytes.length !== input.source.bytes || deliveredSha256 !== input.source.sha256) {
    throw new Error("Cloudinary 回读文件与本地参考素材的字节或 SHA-256 不一致，已阻止发送给视频模型。");
  }
  return {
    sourceBytes: input.source.bytes,
    sourceSha256: input.source.sha256,
    verifiedAt: new Date().toISOString(),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCloudinaryStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function isNonRetryableCloudinaryIntegrityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("已阻止发送给视频模型")
    || message.includes("Cloudinary 原始参考素材回读失败")
    || message.includes("标准 HTTPS URL")
    || message.includes("含有变换或缺少原始版本");
}

async function responseJson(response: Pick<Awaited<ReturnType<typeof cloudinaryDirectFetch>>, "text">) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export async function uploadCloudinaryVideoReference(input: {
  source: string;
  setting: VideoReferenceHostingSetting;
  ownerId: string;
  scopeId: string;
  referenceId: string;
  resourceType?: "image" | "video";
}): Promise<HostedVideoReference> {
  if (!input.source.startsWith("data:") && !/^https?:\/\//i.test(input.source)) {
    throw new Error("Cloudinary 只能上传 Data URI 或可读取的 HTTP(S) 参考素材。");
  }

  const setting = assertCloudinarySetting(input.setting);
  const resourceType = input.resourceType || "image";
  const binarySource = binaryDataUriSource(input.source, resourceType);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = [
    `luma_video_ref_${resourceType}`,
    safeIdentifier(input.ownerId),
    safeIdentifier(input.scopeId),
    safeIdentifier(input.referenceId),
    randomUUID().replace(/-/g, ""),
  ].join("_");
  const signature = signCloudinaryParameters({ public_id: publicId, timestamp }, setting.apiSecret);
  const sourceMB = binarySource ? Number((binarySource.bytes / 1024 / 1024).toFixed(2)) : null;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= CLOUDINARY_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    const form = new FormData();
    if (binarySource) {
      form.set("file", binarySource.blob, binarySource.fileName);
    } else {
      form.set("file", input.source);
    }
    form.set("api_key", setting.apiKey);
    form.set("timestamp", String(timestamp));
    form.set("public_id", publicId);
    form.set("signature", signature);
    const startedAt = Date.now();

    console.info("[cloudinary-reference-upload] start", {
      scopeId: safeIdentifier(input.scopeId),
      referenceId: safeIdentifier(input.referenceId),
      attempt,
      maxAttempts: CLOUDINARY_UPLOAD_MAX_ATTEMPTS,
      sourceKind: binarySource ? "binary_multipart" : "http",
      resourceType,
      sourceMB,
    });

    try {
      const response = await cloudinaryDirectFetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(setting.cloudName)}/${resourceType}/upload`,
        {
          method: "POST",
          body: form,
        },
      );
      const body = await responseJson(response);
      if (!response.ok) {
        const message = typeof (body.error as Record<string, unknown> | undefined)?.message === "string"
          ? String((body.error as Record<string, unknown>).message)
          : `HTTP ${response.status}`;
        lastError = new Error(`Cloudinary 参考素材上传失败：${message}`);
        console.warn("[cloudinary-reference-upload] failed", {
          scopeId: safeIdentifier(input.scopeId),
          referenceId: safeIdentifier(input.referenceId),
          attempt,
          durationMs: Date.now() - startedAt,
          statusCode: response.status,
          retryable: isRetryableCloudinaryStatus(response.status),
          message,
        });
        if (!isRetryableCloudinaryStatus(response.status) || attempt === CLOUDINARY_UPLOAD_MAX_ATTEMPTS) {
          throw lastError;
        }
      } else {
        const secureUrl = typeof body.secure_url === "string" ? body.secure_url.trim() : "";
        const returnedPublicId = typeof body.public_id === "string" ? body.public_id.trim() : publicId;
        if (!secureUrl.startsWith("https://")) {
          throw new Error("Cloudinary 上传成功，但没有返回可用的 HTTPS secure_url。");
        }
        let verification: Awaited<ReturnType<typeof verifyCloudinaryOriginalReference>> | undefined;
        if (binarySource) {
          try {
            verification = await verifyCloudinaryOriginalReference({
              secureUrl,
              cloudName: setting.cloudName,
              resourceType,
              source: binarySource,
            });
          } catch (error) {
            // Never leave an asset that failed integrity verification available
            // for a later accidental submission. This is best-effort only; the
            // original validation error remains the primary failure reason.
            try {
              await deleteCloudinaryVideoReference(input.setting, returnedPublicId, resourceType);
            } catch (cleanupError) {
              console.warn("[cloudinary-reference-upload] integrity-failure-cleanup-failed", {
                scopeId: safeIdentifier(input.scopeId),
                referenceId: safeIdentifier(input.referenceId),
                message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            }
            throw error;
          }
        }
        console.info("[cloudinary-reference-upload] done", {
          scopeId: safeIdentifier(input.scopeId),
          referenceId: safeIdentifier(input.referenceId),
          attempt,
          durationMs: Date.now() - startedAt,
          sourceMB,
          integrityVerified: Boolean(verification),
        });
        return { secureUrl, publicId: returnedPublicId, resourceType, ...verification };
      }
    } catch (error) {
      if (error === lastError) throw error;
      lastError = new Error(`Cloudinary 参考素材上传失败：${error instanceof Error ? error.message : String(error)}`);
      console.warn("[cloudinary-reference-upload] failed", {
        scopeId: safeIdentifier(input.scopeId),
        referenceId: safeIdentifier(input.referenceId),
        attempt,
        durationMs: Date.now() - startedAt,
        retryable: true,
        message: error instanceof Error ? error.message : String(error),
      });
      if (isNonRetryableCloudinaryIntegrityError(error) || attempt === CLOUDINARY_UPLOAD_MAX_ATTEMPTS) throw lastError;
    }

    await delay(CLOUDINARY_UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 2_000);
  }

  throw lastError ?? new Error("Cloudinary 参考素材上传失败：未知错误");
}

export async function deleteCloudinaryVideoReference(
  settingInput: VideoReferenceHostingSetting,
  publicId: string,
  resourceType: CloudinaryReferenceResourceType = "image",
) {
  const setting = assertCloudinarySetting(settingInput);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryParameters({ public_id: publicId, timestamp }, setting.apiSecret);
  const form = new FormData();
  form.set("public_id", publicId);
  form.set("api_key", setting.apiKey);
  form.set("timestamp", String(timestamp));
  form.set("signature", signature);

  let response: Awaited<ReturnType<typeof cloudinaryDirectFetch>>;
  try {
    response = await cloudinaryDirectFetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(setting.cloudName)}/${resourceType}/destroy`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(CLOUDINARY_DELETE_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new Error(`Cloudinary 临时参考素材清理失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await responseJson(response);
  if (!response.ok) {
    const message = typeof (body.error as Record<string, unknown> | undefined)?.message === "string"
      ? String((body.error as Record<string, unknown>).message)
      : `HTTP ${response.status}`;
    throw new Error(`Cloudinary 临时参考素材清理失败：${message}`);
  }
  const result = typeof body.result === "string" ? body.result : "";
  if (!["ok", "not found"].includes(result)) {
    throw new Error(`Cloudinary 临时参考素材清理失败：${result || "未知结果"}`);
  }
  return result === "not found" ? "already_absent" as const : "deleted" as const;
}

/**
 * Used when no deletion request can be made. The asset's existence is unknown,
 * so callers must not present this as a deletion failure or a success.
 */
export function unverifiedCloudinaryVideoReferenceCleanup(
  assets: HostedVideoReference[],
  reason: string,
): HostedVideoReferenceCleanup {
  const now = new Date().toISOString();
  const normalizedReason = reason.trim() || "未能发起 Cloudinary 清理请求。";
  return {
    startedAt: now,
    completedAt: now,
    total: assets.length,
    deleted: 0,
    alreadyAbsent: 0,
    failed: 0,
    status: "unverified",
    assets: assets.map((asset) => ({
      publicId: asset.publicId,
      resourceType: asset.resourceType || "image",
      status: "unverified",
      error: normalizedReason,
    })),
    errors: [normalizedReason],
  };
}

export async function cleanupCloudinaryVideoReferences(
  setting: VideoReferenceHostingSetting,
  assets: HostedVideoReference[],
): Promise<HostedVideoReferenceCleanup> {
  const startedAt = new Date().toISOString();
  const outcomes = await Promise.all(assets.map(async (asset): Promise<CloudinaryReferenceCleanupAsset> => {
    const resourceType = asset.resourceType || "image";
    try {
      const status = await deleteCloudinaryVideoReference(setting, asset.publicId, resourceType);
      return { publicId: asset.publicId, resourceType, status };
    } catch (error) {
      return {
        publicId: asset.publicId,
        resourceType,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const errors = outcomes
    .filter((outcome) => outcome.status === "failed")
    .map((outcome) => outcome.error || "Cloudinary 临时参考素材清理失败：未知错误");
  const deleted = outcomes.filter((outcome) => outcome.status === "deleted").length;
  const alreadyAbsent = outcomes.filter((outcome) => outcome.status === "already_absent").length;
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    total: assets.length,
    deleted,
    alreadyAbsent,
    failed: errors.length,
    status: errors.length === 0 ? "confirmed" : "partial_failure",
    assets: outcomes,
    errors,
  };
}

export async function hostVideoReferencesForModel(input: {
  model: BoardVideoChannelCapabilities | string;
  sources: string[];
  setting?: VideoReferenceHostingSetting | null;
  ownerId: string;
  scopeId: string;
  referenceIds?: string[];
  resourceType?: "image" | "video";
}): Promise<HostedVideoReferenceBatch> {
  if (!isBoardVideoReferenceModel(input.model) || input.sources.length === 0) {
    return { urls: input.sources, assets: [], transport: "original" };
  }
  if (!isReadyVideoReferenceHosting(input.setting)) {
    throw new Error("视频参考图需要先在“模型与API”中完成 Cloudinary 公网托管配置。");
  }

  const assets: HostedVideoReference[] = [];
  for (let index = 0; index < input.sources.length; index += 1) {
    try {
      const asset = await uploadCloudinaryVideoReference({
        source: input.sources[index],
        setting: input.setting,
        ownerId: input.ownerId,
        scopeId: input.scopeId,
        referenceId: input.referenceIds?.[index] || `reference-${index + 1}`,
        resourceType: input.resourceType || "image",
      });
      assets.push(asset);
    } catch (error) {
      await cleanupCloudinaryVideoReferences(input.setting, assets).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cloudinary 第 ${index + 1}/${input.sources.length} 个${input.resourceType === "video" ? "视频/音频" : "图片"}参考素材上传失败：${message.replace(/^Cloudinary 图片上传失败：/, "")}`,
      );
    }
  }

  return {
    urls: assets.map((asset) => asset.secureUrl),
    assets,
    transport: "cloudinary_https",
  };
}

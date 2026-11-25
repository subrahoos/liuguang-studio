import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const LINGGANYA_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_REDIRECTS = 4;

export type LingganyaReferenceMediaType = "image" | "video" | "audio";

type DecodedReference = {
  blob: Blob;
  bytes: number;
  fileName: string;
  contentType: string;
};

export type LingganyaReferenceFile = {
  fileId: string;
  bytes: number;
  contentType: string;
  mediaType: LingganyaReferenceMediaType;
  expiresAt: string;
};

export type LingganyaReferenceFileBatch = {
  fileIds: string[];
  files: LingganyaReferenceFile[];
  expiresAt?: string;
};

const SUPPORTED_CONTENT_TYPES: Record<LingganyaReferenceMediaType, ReadonlyMap<string, string>> = {
  image: new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ]),
  video: new Map([
    ["video/mp4", "mp4"],
    ["video/webm", "webm"],
    ["video/quicktime", "mov"],
  ]),
  audio: new Map([
    ["audio/mpeg", "mp3"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/mp4", "m4a"],
  ]),
};

function cleanBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const withoutEndpoint = trimmed
    .replace(/\/v1\/videos(?:\/.*)?$/i, "")
    .replace(/\/v1$/i, "");
  if (!/^https:\/\//i.test(withoutEndpoint)) {
    throw new Error("灵感鸭通道 Base URL 必须是公网 HTTPS 地址。");
  }
  return `${withoutEndpoint}/v1`;
}

function safeFileStem(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "reference";
}

function decodeReferenceDataUri(
  source: string,
  mediaType: LingganyaReferenceMediaType,
  referenceId: string,
): DecodedReference {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(source);
  if (!match) {
    throw new Error("灵感鸭临时参考只接受已读取为 Data URI 的本地素材。");
  }
  const contentType = match[1].trim().toLowerCase();
  const extension = SUPPORTED_CONTENT_TYPES[mediaType].get(contentType);
  if (!extension) {
    throw new Error(`灵感鸭不支持此${mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "音频"}格式：${contentType || "未知格式"}。`);
  }
  const encoded = match[2].replace(/\s+/g, "");
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("参考素材 Base64 内容无效。");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0) throw new Error("参考素材文件为空，不能上传到灵感鸭。");
  if (buffer.length > LINGGANYA_REFERENCE_MAX_BYTES) {
    throw new Error(
      `参考素材为 ${(buffer.length / 1024 / 1024).toFixed(2)} MiB，超过灵感鸭 /v1/files 的 20 MiB 单文件上限。`,
    );
  }
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  return {
    blob: new Blob([bytes], { type: contentType }),
    bytes: buffer.length,
    fileName: `${safeFileStem(referenceId)}.${extension}`,
    contentType,
  };
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized);
}

async function assertPublicHttpsUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("灵感鸭临时参考只接受 Data URI 或公网 HTTPS 素材。");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("灵感鸭临时参考只接受 Data URI 或公网 HTTPS 素材。");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("不能从本机或内网地址读取灵感鸭临时参考素材。");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("不能从本机或内网地址读取灵感鸭临时参考素材。");
  }
  return parsed;
}

async function downloadReferenceSource(
  source: string,
  mediaType: LingganyaReferenceMediaType,
  referenceId: string,
): Promise<DecodedReference> {
  let current = await assertPublicHttpsUrl(source);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REFERENCE_REDIRECTS; redirect += 1) {
    response = await fetch(current, { redirect: "manual", cache: "no-store" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REFERENCE_REDIRECTS) {
      throw new Error("公网参考素材重定向次数过多或缺少目标地址。");
    }
    await response.body?.cancel().catch(() => undefined);
    current = await assertPublicHttpsUrl(new URL(location, current).toString());
  }
  if (!response?.ok) {
    throw new Error(`公网参考素材读取失败（HTTP ${response?.status || 0}）。`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > LINGGANYA_REFERENCE_MAX_BYTES) {
    throw new Error("参考素材超过灵感鸭 /v1/files 的 20 MiB 单文件上限。");
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extension = SUPPORTED_CONTENT_TYPES[mediaType].get(contentType);
  if (!extension) {
    throw new Error(`灵感鸭不支持此${mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "音频"}格式：${contentType || "未知格式"}。`);
  }
  if (!response.body) throw new Error("公网参考素材没有可读取的文件内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > LINGGANYA_REFERENCE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("参考素材超过灵感鸭 /v1/files 的 20 MiB 单文件上限。");
    }
    chunks.push(next.value);
  }
  if (bytes === 0) throw new Error("参考素材文件为空，不能上传到灵感鸭。");
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    blob: new Blob([combined], { type: contentType }),
    bytes,
    fileName: `${safeFileStem(referenceId)}.${extension}`,
    contentType,
  };
}

async function readReferenceSource(
  source: string,
  mediaType: LingganyaReferenceMediaType,
  referenceId: string,
) {
  if (source.startsWith("data:")) return decodeReferenceDataUri(source, mediaType, referenceId);
  return downloadReferenceSource(source, mediaType, referenceId);
}

function responseError(payload: Record<string, unknown>) {
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return String((error as Record<string, unknown>).message).trim();
  }
  return "未知错误";
}

async function responseJson(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return {} as Record<string, unknown>;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 500) } as Record<string, unknown>;
  }
}

export async function uploadLingganyaReferenceFile(input: {
  baseUrl: string;
  apiKey: string;
  source: string;
  referenceId: string;
  mediaType: LingganyaReferenceMediaType;
}): Promise<LingganyaReferenceFile> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("当前账户尚未配置灵感鸭 API Key。");
  const source = await readReferenceSource(input.source, input.mediaType, input.referenceId);
  const form = new FormData();
  form.set("file", source.blob, source.fileName);
  form.set("filename", source.fileName);

  let response: Response;
  try {
    response = await fetch(`${cleanBaseUrl(input.baseUrl)}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(`灵感鸭临时参考上传失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const payload = await responseJson(response);
  if (!response.ok) {
    throw new Error(`灵感鸭临时参考上传失败（HTTP ${response.status}）：${responseError(payload)}`);
  }

  const fileId = typeof payload.file_id === "string" ? payload.file_id.trim() : "";
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!/^file_[a-zA-Z0-9_-]+$/.test(fileId) || (id && id !== fileId)) {
    throw new Error("灵感鸭临时参考上传成功，但返回的 file_id 无效或与 id 不一致。");
  }
  const receivedBytes = Number(payload.bytes);
  if (!Number.isFinite(receivedBytes) || receivedBytes !== source.bytes) {
    throw new Error("灵感鸭临时参考上传后的字节数与本地素材不一致，已阻止创建视频任务。");
  }
  const receivedMediaType = String(payload.media_type || "").trim().toLowerCase();
  if (receivedMediaType !== input.mediaType) {
    throw new Error(`灵感鸭把参考素材识别为 ${receivedMediaType || "未知类型"}，与预期 ${input.mediaType} 不一致。`);
  }
  const expiresAtSeconds = Number(payload.expires_at);
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new Error("灵感鸭临时参考上传成功，但响应缺少有效的 expires_at。");
  }

  return {
    fileId,
    bytes: source.bytes,
    contentType: String(payload.content_type || source.contentType).trim() || source.contentType,
    mediaType: input.mediaType,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export async function uploadLingganyaReferenceFiles(input: {
  baseUrl: string;
  apiKey: string;
  sources: string[];
  referenceIds?: string[];
  mediaType: LingganyaReferenceMediaType;
  onUploaded?: (file: LingganyaReferenceFile) => void | Promise<void>;
}): Promise<LingganyaReferenceFileBatch> {
  const files: LingganyaReferenceFile[] = [];
  for (let index = 0; index < input.sources.length; index += 1) {
    try {
      const uploaded = await uploadLingganyaReferenceFile({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        source: input.sources[index],
        referenceId: input.referenceIds?.[index] || `${input.mediaType}-${index + 1}`,
        mediaType: input.mediaType,
      });
      files.push(uploaded);
      await input.onUploaded?.(uploaded);
    } catch (error) {
      const retained = files.length > 0
        ? ` 此前已上传的 ${files.length} 个临时参考无法主动删除，将在24小时有效期结束后自动失效。`
        : "";
      throw new Error(`第 ${index + 1}/${input.sources.length} 个灵感鸭临时参考上传失败：${error instanceof Error ? error.message : String(error)}${retained}`);
    }
  }
  const expiresAt = files
    .map((file) => file.expiresAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return {
    fileIds: files.map((file) => file.fileId),
    files,
    expiresAt,
  };
}

export function isLingganyaFileId(value: string) {
  return /^file_[a-zA-Z0-9_-]+$/.test(value.trim());
}

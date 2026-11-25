import { parseDataUrl } from "@/lib/board-workflows";

export const IDENTITY_IMAGE_DOWNLOAD_TIMEOUT_MS = 600_000;

function mimeToExt(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

export async function readIdentityImageBytes(url: string) {
  if (url.startsWith("data:")) return parseDataUrl(url);

  const timeoutMs = IDENTITY_IMAGE_DOWNLOAD_TIMEOUT_MS;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mimeType = response.headers.get("content-type") || "image/png";
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType, ext: mimeToExt(mimeType) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown download error";
    throw new Error(`生成结果下载失败：已等待最长 ${Math.round(timeoutMs / 1_000)} 秒；${detail}`);
  }
}

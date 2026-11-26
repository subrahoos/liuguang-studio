import { legacyIdentityReferenceRoot, mediaExecutable } from "@/lib/runtime-tools";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdir, readFile, stat, unlink } from "fs/promises";
import { basename, join } from "path";
import { promisify } from "util";
import { resolveIdentityImageFile } from "@/lib/identity-pack";
import { boardFilePath } from "@/lib/board-workflows";
import { storagePaths } from "@/lib/storage-root";
import { resolveOwnedStoredProjectFile } from "@/lib/project-local-archive";
import { IMAGE_REFERENCE_TARGET_BYTES } from "@/lib/image-generation-policy";
import { ADMIN_USER_ID } from "@/lib/auth-constants";

const execFileAsync = promisify(execFile);

const DEFAULT_TARGET_BYTES = IMAGE_REFERENCE_TARGET_BYTES;
const DEFAULT_MAX_SIDE = 2048;
const DEFAULT_PRESETS = [
  { maxSide: 2048, qscale: 2 },
  { maxSide: 2048, qscale: 3 },
  { maxSide: 1800, qscale: 3 },
  { maxSide: 1600, qscale: 4 },
];

interface PrepareReferenceOptions {
  targetBytes?: number;
  maxSide?: number;
  ownerId?: string;
}

const MODEL_IDENTITY_PACK_DIR = legacyIdentityReferenceRoot();

const MODEL_IDENTITY_FILES: Record<string, string> = {
  "main-model-v2.png": "白底棚拍运动服模特-参考脸型身材-4K-v2.png",
  "five-angles-v1.png": "模特身份五视角校准-v1.png",
  "pitch-angle-v1.png": "模特身份俯仰角校准-v1.png",
  "expression-mouth-v1.png": "模特身份表情口型校准-v1.png",
};

export async function prepareImageEditReferenceUrl(url: string, options: PrepareReferenceOptions = {}): Promise<string> {
  const filePath = await resolveLocalImageApiPath(url, options.ownerId);
  if (!filePath) return url;
  const dataUrl = await encodeLocalReferenceImage(filePath, options);
  return dataUrl || url;
}

async function resolveLocalImageApiPath(url: string, ownerId?: string): Promise<string | null> {
  const pathOnly = toLocalApiPath(url);
  if (!pathOnly) return null;

  const modelMatch = pathOnly.match(/^\/api\/model-identity\/([^/?#]+)/);
  if (modelMatch) {
    if (ownerId !== ADMIN_USER_ID) throw new Error("无权读取该人物参考图。");
    const fileName = MODEL_IDENTITY_FILES[decodeURIComponent(modelMatch[1])];
    return fileName ? join(MODEL_IDENTITY_PACK_DIR, fileName) : null;
  }

  const identityMatch = pathOnly.match(/^\/api\/identity-pack\/file\/([^/?#]+)/);
  if (identityMatch) {
    return ownerId ? resolveIdentityImageFile(ownerId, pathOnly) : null;
  }

  const boardMatch = pathOnly.match(/^\/api\/board-workflows\/([^/]+)\/file\/([^/?#]+)/);
  if (boardMatch) {
    const workflowId = decodeURIComponent(boardMatch[1]);
    if (!/^[a-zA-Z0-9_-]+$/.test(workflowId)) return null;
    return ownerId
      ? boardFilePath(workflowId, decodeURIComponent(boardMatch[2]), ownerId).catch(() => null)
      : null;
  }

  const projectMatch = pathOnly.match(/^\/api\/files\/([^/]+)\/([^/?#]+)/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return null;
    return ownerId
      ? resolveOwnedStoredProjectFile(ownerId, projectId, "assets", basename(decodeURIComponent(projectMatch[2])))
      : null;
  }

  return null;
}

function toLocalApiPath(url: string): string | null {
  if (url.startsWith("/api/")) return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function encodeLocalReferenceImage(filePath: string, options: PrepareReferenceOptions): Promise<string | null> {
  const original = await readFile(filePath);
  const originalMime = mimeTypeFromFileName(filePath);
  const targetBytes = options.targetBytes ?? DEFAULT_TARGET_BYTES;
  if (original.length <= targetBytes && originalMime === "image/jpeg") {
    return `data:${originalMime};base64,${original.toString("base64")}`;
  }

  try {
    const encoded = await encodeWithFfmpeg(filePath, options);
    return `data:image/jpeg;base64,${encoded.toString("base64")}`;
  } catch (error) {
    console.warn("[image-edit-reference] optimize failed, using original reference bytes", {
      filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return `data:${originalMime};base64,${original.toString("base64")}`;
  }
}

async function encodeWithFfmpeg(filePath: string, options: PrepareReferenceOptions): Promise<Buffer> {
  const tempDir = storagePaths.tmp("image-edit-references");
  await mkdir(tempDir, { recursive: true });

  const targetBytes = options.targetBytes ?? DEFAULT_TARGET_BYTES;
  const maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
  const presets = DEFAULT_PRESETS.map((preset) => ({
    ...preset,
    maxSide: Math.min(preset.maxSide, maxSide),
  }));

  let lastOutput: Buffer | null = null;
  for (const preset of presets) {
    const outputPath = join(tempDir, `${randomUUID()}.jpg`);
    try {
      await execFileAsync(ffmpegExecutable(), [
        "-y",
        "-i",
        filePath,
        "-vf",
        `scale='min(${preset.maxSide},iw)':'min(${preset.maxSide},ih)':force_original_aspect_ratio=decrease`,
        "-update",
        "1",
        "-frames:v",
        "1",
        "-q:v",
        String(preset.qscale),
        outputPath,
      ], { maxBuffer: 20 * 1024 * 1024 });

      const output = await readFile(outputPath);
      const outputStat = await stat(outputPath);
      lastOutput = output;
      await unlink(outputPath).catch(() => undefined);
      if (outputStat.size <= targetBytes) return output;
    } catch (error) {
      await unlink(outputPath).catch(() => undefined);
      throw error;
    }
  }

  if (lastOutput) return lastOutput;
  throw new Error("ffmpeg did not produce an optimized reference image.");
}

function ffmpegExecutable() {
  return mediaExecutable("ffmpeg");
}

function mimeTypeFromFileName(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

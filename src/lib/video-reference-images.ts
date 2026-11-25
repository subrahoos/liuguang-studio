import { mediaExecutable } from "@/lib/runtime-tools";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdir, readFile, stat, unlink } from "fs/promises";
import { basename, join } from "path";
import { promisify } from "util";
import { resolveIdentityImageFile } from "@/lib/identity-pack";
import { resolveOwnedStoredProjectFile } from "@/lib/project-local-archive";
import { storagePaths } from "@/lib/storage-root";

const execFileAsync = promisify(execFile);

type EncodePreset = {
  maxSide: number;
  qscale: number;
};

type VideoReferenceEncodeOptions = {
  targetBytes?: number;
};

const DEFAULT_VIDEO_REFERENCE_TARGET_BYTES = 420 * 1024;
const MAX_DIRECT_MEDIA_REFERENCE_BYTES = 100 * 1024 * 1024;
const VIDEO_REFERENCE_PRESETS: EncodePreset[] = [
  { maxSide: 1280, qscale: 5 },
  { maxSide: 1152, qscale: 6 },
  { maxSide: 1024, qscale: 7 },
  { maxSide: 960, qscale: 8 },
  { maxSide: 864, qscale: 9 },
  { maxSide: 768, qscale: 10 },
  { maxSide: 704, qscale: 11 },
  { maxSide: 640, qscale: 12 },
];

export async function readLocalApiImageAsVideoReferenceDataUrl(url: string, ownerId?: string): Promise<string | null> {
  const pathOnly = toLocalApiPath(url);
  if (!pathOnly) return null;

  const identityMatch = pathOnly.match(/^\/api\/identity-pack\/file\/([^/?#]+)/);
  if (identityMatch && ownerId) {
    const filePath = await resolveIdentityImageFile(ownerId, pathOnly);
    return filePath ? encodeImageFileForVideoReference(filePath) : null;
  }

  const match = pathOnly.match(/^\/api\/files\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;

  const projectId = decodeURIComponent(match[1]);
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return null;

  const fileName = basename(decodeURIComponent(match[2]));
  if (!ownerId) return null;
  const filePath = await resolveOwnedStoredProjectFile(ownerId, projectId, "assets", fileName);
  if (!filePath) return null;
  return encodeImageFileForVideoReference(filePath);
}

export async function encodeImageFileForVideoReference(filePath: string, options: VideoReferenceEncodeOptions = {}): Promise<string> {
  const targetBytes = options.targetBytes ?? DEFAULT_VIDEO_REFERENCE_TARGET_BYTES;
  const original = await readFile(filePath);
  const originalMimeType = mimeTypeFromFileName(filePath);

  if (original.length <= targetBytes && originalMimeType === "image/jpeg") {
    return `data:${originalMimeType};base64,${original.toString("base64")}`;
  }

  try {
    const encoded = await encodeWithFfmpeg(filePath, targetBytes);
    return `data:image/jpeg;base64,${encoded.toString("base64")}`;
  } catch (error) {
    console.warn("[video-reference-image] ffmpeg encode failed, using original image", {
      filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return `data:${originalMimeType};base64,${original.toString("base64")}`;
  }
}

/**
 * Direct multimedia video channels need the original video as an uploadable
 * data URI before Cloudinary converts it to a public HTTPS URL. Do not
 * transcode it here: the reference video remains the timing/camera authority.
 */
export async function encodeVideoFileForVideoReference(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("参考视频不是可读取的本地文件。");
  if (info.size > MAX_DIRECT_MEDIA_REFERENCE_BYTES) {
    throw new Error(`参考视频为 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过 100 MB 临时托管上限；请先导出更小的参考文件。`);
  }
  const mimeType = videoMimeTypeFromFileName(filePath);
  if (!mimeType) throw new Error("参考视频仅支持 MP4、WebM 或 MOV 文件。");
  const original = await readFile(filePath);
  return `data:${mimeType};base64,${original.toString("base64")}`;
}

/** Audio is uploaded through Cloudinary's video resource type before the video API receives its HTTPS URL. */
export async function encodeAudioFileForVideoReference(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("参考音频不是可读取的本地文件。");
  if (info.size > MAX_DIRECT_MEDIA_REFERENCE_BYTES) {
    throw new Error(`参考音频为 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过 100 MB 临时托管上限；请先导出更小的音频文件。`);
  }
  const mimeType = audioMimeTypeFromFileName(filePath);
  if (!mimeType) throw new Error("参考音频仅支持 MP3、WAV、M4A 或 AAC 文件。");
  const original = await readFile(filePath);
  return `data:${mimeType};base64,${original.toString("base64")}`;
}

function toLocalApiPath(url: string): string | null {
  if (url.startsWith("/api/files/") || url.startsWith("/api/identity-pack/file/")) return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function encodeWithFfmpeg(filePath: string, targetBytes: number): Promise<Buffer> {
  const tempDir = storagePaths.tmp("video-reference-images");
  await mkdir(tempDir, { recursive: true });

  let lastOutput: Buffer | undefined;
  for (const preset of VIDEO_REFERENCE_PRESETS) {
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
      ], { maxBuffer: 10 * 1024 * 1024 });

      const outputStat = await stat(outputPath);
      const output = await readFile(outputPath);
      lastOutput = output;
      await unlink(outputPath).catch(() => undefined);
      if (outputStat.size <= targetBytes) {
        return output;
      }
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

function mimeTypeFromFileName(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

function videoMimeTypeFromFileName(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  return null;
}

function audioMimeTypeFromFileName(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  return null;
}

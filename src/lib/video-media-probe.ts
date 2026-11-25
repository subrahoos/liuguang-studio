import { mediaExecutable } from "@/lib/runtime-tools";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function ffprobeExecutable() {
  return mediaExecutable("ffprobe");
}

export async function probeVideoMedia(filePath: string) {
  const { stdout } = await execFileAsync(ffprobeExecutable(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      codec_name?: string;
    }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("下载结果中没有可用的视频流。");
  return {
    durationSeconds: Number(parsed.format?.duration || 0),
    width: video.width,
    height: video.height,
    fps: video.avg_frame_rate,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name,
    hasAudio: Boolean(audio),
  };
}

export async function probeStillImageMedia(filePath: string) {
  const { stdout } = await execFileAsync(ffprobeExecutable(), [
    "-v", "error", "-print_format", "json", "-show_streams", filePath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
  const stream = parsed.streams?.find((item) => item.codec_type === "video");
  const formats: Record<string, { ext: string; mimeType: string }> = {
    png: { ext: ".png", mimeType: "image/png" },
    mjpeg: { ext: ".jpg", mimeType: "image/jpeg" },
    webp: { ext: ".webp", mimeType: "image/webp" },
  };
  const format = formats[String(stream?.codec_name || "")];
  if (!format || !stream?.width || !stream.height) throw new Error("图片文件不是可用的 PNG、JPEG 或 WebP。");
  return { ...format, width: stream.width, height: stream.height };
}

export async function probeAudioMedia(filePath: string) {
  const { stdout } = await execFileAsync(ffprobeExecutable(), [
    "-v", "error", "-print_format", "json", "-show_streams", filePath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
  if (!parsed.streams?.some((item) => item.codec_type === "audio")) throw new Error("音频文件中没有可用的音频流。");
}

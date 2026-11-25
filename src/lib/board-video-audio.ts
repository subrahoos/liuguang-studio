import { mediaExecutable } from "@/lib/runtime-tools";
import { execFile } from "child_process";
import { promisify } from "util";
import type { VideoProbeMeta } from "@/lib/board-workflows";

const execFileAsync = promisify(execFile);

export function boardMediaTool(name: "ffmpeg" | "ffprobe") {
  return mediaExecutable(name);
}

export async function probeBoardVideo(videoPath: string): Promise<VideoProbeMeta> {
  const { stdout } = await execFileAsync(boardMediaTool("ffprobe"), [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds: Number(parsed.format?.duration || 0),
    width: video?.width,
    height: video?.height,
    fps: video?.avg_frame_rate,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    hasAudio: Boolean(audio),
    sizeBytes: Number(parsed.format?.size || 0),
  };
}

/**
 * Keep the established normalized MP3 protocol so existing transcription and
 * direct-video audio references remain compatible. The source video itself is
 * never changed.
 */
export async function extractBoardVideoAudio(videoPath: string, outputPath: string) {
  await execFileAsync(boardMediaTool("ffmpeg"), [
    "-y",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    outputPath,
  ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
}

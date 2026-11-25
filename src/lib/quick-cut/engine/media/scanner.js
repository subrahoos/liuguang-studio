const fs = require("node:fs/promises");
const path = require("node:path");

const { runProcess } = require("../process/run-process");

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
]);

function parseFrameRate(value) {
  if (!value) return 0;
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(3));
}

function normalizeProbe(filePath, data, id = filePath, metadata = {}) {
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) {
    throw new Error("没有检测到视频轨道");
  }
  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("视频时长无效");
  }
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("视频画面尺寸无效");
  }
  const fps = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("视频帧率无效");
  }
  if (Number(metadata.size) <= 0) {
    throw new Error("视频文件为空");
  }

  return {
    id,
    path: filePath,
    duration,
    width,
    height,
    fps,
    hasAudio: Boolean(audio),
    audioDuration: audio
      ? Number(audio.duration ?? data.format?.duration) || 0
      : 0,
    size: Number(metadata.size) || 0,
    mtimeMs: Number(metadata.mtimeMs) || 0,
  };
}

async function listVideos(folder) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile()
        && SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        result.push(fullPath);
      }
    }
  }
  await walk(folder);
  return result;
}

async function defaultProbe(ffprobePath, filePath) {
  const { stdout } = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(stdout);
}

async function defaultDecodeFrame(ffmpegPath, filePath) {
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-an",
    "-f",
    "null",
    "-",
  ]);
}

async function scanMediaFolder({
  folder,
  ffprobePath,
  ffmpegPath,
  probe = (filePath) => defaultProbe(ffprobePath, filePath),
  decodeFrame = ffmpegPath
    ? (filePath) => defaultDecodeFrame(ffmpegPath, filePath)
    : null,
  concurrency = 4,
}) {
  const files = await listVideos(folder);
  const valid = [];
  const invalid = [];
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const filePath = files[index];
      const id = path.relative(folder, filePath).replaceAll("\\", "/");
      try {
        const [data, metadata] = await Promise.all([
          probe(filePath),
          fs.stat(filePath),
        ]);
        const normalized = normalizeProbe(filePath, data, id, metadata);
        if (decodeFrame) {
          try {
            await decodeFrame(filePath);
          } catch {
            throw new Error("视频首帧无法解码，文件可能损坏");
          }
        }
        valid.push(normalized);
      } catch (error) {
        invalid.push({
          path: filePath,
          reason: error.message || "无法读取素材",
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, files.length || 1)) },
      () => worker(),
    ),
  );
  valid.sort((left, right) => left.id.localeCompare(right.id, "zh-CN"));
  invalid.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  return { valid, invalid };
}

module.exports = {
  SUPPORTED_VIDEO_EXTENSIONS,
  defaultDecodeFrame,
  defaultProbe,
  normalizeProbe,
  scanMediaFolder,
};

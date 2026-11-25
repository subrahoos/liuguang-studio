import { access, readdir, rename, rm, stat } from "fs/promises";
import path from "path";
import { probeNvidiaEncoder, validateRenderedVideo } from "@/lib/quick-cut/engine/reliability";
import { runProcess } from "@/lib/quick-cut/engine/process/run-process";

export type MaterialProcessingMode = "metadata-cleanup" | "quality-optimize";

export type MaterialProcessingRow = {
  planId: string;
  output: string;
  sources: string[];
  segments: unknown[];
  duration: number;
  status: "done" | "failed";
  error: string;
};

type VideoInfo = {
  duration: number;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
};

type ProcessorProgress = {
  fileIndex: number;
  total: number;
  fileName: string;
  stage: string;
  progress: number;
  logMessage?: string;
};

export type MetadataCleanupRuntime = {
  pythonPath: string;
  processorPath: string;
  qualityProfilePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  keyPath: string;
};

type QualityVisualProfile = {
  avgLuma: number;
  avgSaturation: number;
  avgR: number;
  avgG: number;
  avgB: number;
  highlightRatio: number;
  shadowRatio: number;
  skinRatio: number;
  samples: number;
};

export type QualityOptimizeProfile = {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  rr: number;
  gg: number;
  bb: number;
  denoise: string;
  sharpen: string;
};

const deepMetadataCleanupConfig = {
  payloadTag: "M2",
  width: 1080,
  height: 1920,
  fps: 30,
  qp: 22,
  qimStep: 34,
  gammaAmplitude: 0.006,
  intervalFrames: 12,
  lsbRedundancy: 5,
  temporalRotationStep: 7,
} as const;

const videoExtensions = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
export const MAX_LOCAL_MATERIAL_FILES = 200;
const runLocalProcess = runProcess as (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

function timestampToSeconds(value: string) {
  const match = String(value).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function baseVideoName(filePath: string) {
  return path.basename(filePath, path.extname(filePath));
}

function replaceExtension(filePath: string, suffix: string) {
  return `${baseVideoName(filePath)}${suffix}.mp4`;
}

export function buildDeepMetadataCleanupArgs({
  inputPath,
  outputPath,
  runtime,
}: {
  inputPath: string;
  outputPath: string;
  runtime: MetadataCleanupRuntime;
}) {
  return [
    "-u", runtime.processorPath,
    "--input", inputPath,
    "--output", outputPath,
    "--ffmpeg", runtime.ffmpegPath,
    "--ffprobe", runtime.ffprobePath,
    "--key", runtime.keyPath,
    "--payload-tag", deepMetadataCleanupConfig.payloadTag,
    "--width", String(deepMetadataCleanupConfig.width),
    "--height", String(deepMetadataCleanupConfig.height),
    "--fps", String(deepMetadataCleanupConfig.fps),
    "--qp", String(deepMetadataCleanupConfig.qp),
    "--qim-step", String(deepMetadataCleanupConfig.qimStep),
    "--gamma-amplitude", String(deepMetadataCleanupConfig.gammaAmplitude),
    "--interval-frames", String(deepMetadataCleanupConfig.intervalFrames),
    "--lsb-redundancy", String(deepMetadataCleanupConfig.lsbRedundancy),
    "--temporal-rotation-step", String(deepMetadataCleanupConfig.temporalRotationStep),
  ];
}

export function buildQualityOptimizeArgs({
  inputPath,
  outputPath,
  hasAudio,
  encoder,
  profile,
}: {
  inputPath: string;
  outputPath: string;
  hasAudio: boolean;
  encoder: "nvidia" | "cpu";
  profile: QualityOptimizeProfile;
}) {
  const extension = path.extname(inputPath).toLowerCase();
  const webm = extension === ".webm";
  const container = webm ? "webm" : extension === ".mkv" ? "matroska" : extension === ".avi" ? "avi" : extension === ".mov" ? "mov" : "mp4";
  const videoFilter = [
    `eq=brightness=${profile.brightness}:contrast=${profile.contrast}:saturation=${profile.saturation}:gamma=${profile.gamma}`,
    `colorchannelmixer=rr=${profile.rr}:gg=${profile.gg}:bb=${profile.bb}`,
    profile.denoise,
    profile.sharpen,
    "format=yuv420p",
  ].join(",");
  const videoArgs = webm
    ? ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1"]
    : encoder === "nvidia"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-profile:v", "main"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "main"];
  const audioArgs = hasAudio
    ? [
      "-af", "highpass=f=70,afftdn=nf=-25,equalizer=f=2500:t=q:w=1:g=0.8,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95",
      "-c:a", webm ? "libopus" : "aac", "-ar", webm ? "48000" : "44100", "-ac", "2", "-b:a", "128k",
    ]
    : ["-an"];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a?"] : []),
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-vf", videoFilter,
    ...videoArgs,
    ...audioArgs,
    "-progress", "pipe:1", "-nostats",
    "-f", container,
    ...(["mp4", "mov"].includes(container) ? ["-movflags", "+faststart"] : []),
    outputPath,
  ];
}

async function exists(filePath: string) {
  await access(filePath);
  return true;
}

async function uniqueCleanupPath(outputFolder: string, sourcePath: string) {
  const stem = replaceExtension(sourcePath, "_已清理");
  for (let index = 1; index <= 999; index += 1) {
    const suffix = index === 1 ? "" : ` (${index})`;
    const candidate = path.join(outputFolder, stem.replace(/\.mp4$/i, `${suffix}.mp4`));
    if (!(await exists(candidate).catch(() => false))) return candidate;
  }
  throw new Error(`输出目录中同名清理文件过多：${path.basename(sourcePath)}`);
}

async function probeVideo({
  ffmpegPath,
  ffprobePath,
  filePath,
}: {
  ffmpegPath: string;
  ffprobePath: string;
  filePath: string;
}): Promise<VideoInfo> {
  const result = await validateRenderedVideo({
    ffmpegPath,
    ffprobePath,
    filePath,
    expectedDuration: undefined,
    expectAudio: false,
  });
  return {
    duration: result.duration,
    hasAudio: result.hasAudio,
    width: result.width,
    height: result.height,
    fps: result.fps,
  };
}

async function validateOutput({
  ffmpegPath,
  ffprobePath,
  filePath,
  input,
  expectedVideo,
  webm = false,
}: {
  ffmpegPath: string;
  ffprobePath: string;
  filePath: string;
  input: VideoInfo;
  expectedVideo?: Pick<VideoInfo, "width" | "height" | "fps">;
  webm?: boolean;
}) {
  const result = await validateRenderedVideo({
    ffmpegPath,
    ffprobePath,
    filePath,
    expectedDuration: input.duration,
    expectAudio: input.hasAudio,
  });
  if (Math.abs(result.duration - input.duration) > 0.75) {
    throw new Error(`处理后时长异常：原始 ${input.duration.toFixed(2)} 秒，输出 ${result.duration.toFixed(2)} 秒`);
  }
  const expected = expectedVideo || input;
  if (result.width !== expected.width || result.height !== expected.height) {
    throw new Error(`处理后分辨率异常：预期 ${expected.width}x${expected.height}，输出 ${result.width}x${result.height}`);
  }
  if (Math.abs(result.fps - expected.fps) > 0.2) {
    throw new Error(`处理后帧率异常：预期 ${expected.fps.toFixed(2)} fps，输出 ${result.fps.toFixed(2)} fps`);
  }
  await validateOutputCodecs({ ffprobePath, filePath, expectAudio: input.hasAudio, webm });
  await validateDecodedCheckpoints({ ffmpegPath, filePath, duration: result.duration, expectAudio: input.hasAudio });
  return result;
}

type OutputStream = {
  codec_type?: string;
  codec_name?: string;
};

export function inspectMaterialMetadata(value: unknown) {
  const info = value as {
    format?: { tags?: Record<string, unknown> };
    streams?: { codec_type?: string; tags?: Record<string, unknown> }[];
    chapters?: unknown[];
  };
  const residualFields: string[] = [];
  const technical = new Set(["major_brand", "minor_version", "compatible_brands"]);
  for (const [key, value] of Object.entries(info.format?.tags || {})) {
    if (String(value).trim() && !technical.has(key.toLowerCase())) residualFields.push(`format.${key}`);
  }
  for (const [index, stream] of (info.streams || []).entries()) {
    if (!["video", "audio"].includes(stream.codec_type || "")) residualFields.push(`stream[${index}].extra_track`);
    for (const [key, value] of Object.entries(stream.tags || {})) {
      const text = String(value).trim();
      if (!text || (key.toLowerCase() === "language" && text === "und")
        || (key.toLowerCase() === "vendor_id" && text === "[0][0][0][0]")) continue;
      residualFields.push(`stream[${index}].${key}`);
    }
  }
  if (info.chapters?.length) residualFields.push("chapters");
  return { residualFields, checkedStreamCount: info.streams?.length || 0 };
}

async function probeMaterialMetadata(ffprobePath: string, filePath: string, signal: AbortSignal) {
  const { stdout } = await runLocalProcess(ffprobePath, [
    "-v", "error", "-show_entries", "format_tags:stream=codec_type:stream_tags:chapter", "-of", "json", filePath,
  ], { signal });
  return inspectMaterialMetadata(JSON.parse(String(stdout)));
}

export function videoDecodeCheckpoints(duration: number) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const tail = Math.max(0, safeDuration - 0.1);
  return [...new Set([0, Math.min(tail, safeDuration / 2), tail].map((value) => Number(value.toFixed(3))))];
}

async function validateOutputCodecs({
  ffprobePath,
  filePath,
  expectAudio,
  webm = false,
}: {
  ffprobePath: string;
  filePath: string;
  expectAudio: boolean;
  webm?: boolean;
}) {
  const { stdout } = await runLocalProcess(ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name",
    "-of", "json",
    filePath,
  ]);
  let streams: OutputStream[] = [];
  try {
    const parsed = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout)) as { streams?: OutputStream[] };
    streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  } catch {
    throw new Error("处理后编码校验失败：FFprobe 返回无效结果");
  }
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (video?.codec_name !== (webm ? "vp9" : "h264")) throw new Error(`处理后编码校验失败：输出视频不是 ${webm ? "VP9" : "H.264"}`);
  if (expectAudio && audio?.codec_name !== (webm ? "opus" : "aac")) throw new Error(`处理后编码校验失败：输出音频不是 ${webm ? "Opus" : "AAC"}`);
}

async function validateDecodedCheckpoints({
  ffmpegPath,
  filePath,
  duration,
  expectAudio,
}: {
  ffmpegPath: string;
  filePath: string;
  duration: number;
  expectAudio: boolean;
}) {
  const checkpoints = videoDecodeCheckpoints(duration);
  for (const checkpoint of checkpoints) {
    await runLocalProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(checkpoint),
      "-i", filePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-an",
      "-f", "null",
      "-",
    ]).catch(() => {
      throw new Error("处理后兼容性校验失败：首帧、中段或尾帧无法解码");
    });
  }
  if (expectAudio) {
    await runLocalProcess(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-i", filePath,
      "-map", "0:a:0",
      "-t", "0.5",
      "-f", "null",
      "-",
    ]).catch(() => {
      throw new Error("处理后兼容性校验失败：音轨无法解码");
    });
  }
}

function deepMetadataCleanupStage(status: string) {
  if (status === "WATERMARK") return "正在进行频域 DWT/SVD/QIM/ECC、LSB 与时序混合水印嵌入";
  if (status === "ENCODE") return "正在以固定 QP 重新编码视频";
  if (status === "DONE") return "视频重编码完成，正在封装音频并清理 SEI/技术标签";
  return "正在执行深度元数据清理";
}

function qualityProfileStage(status: string) {
  if (status === "PREPARING") return "正在准备抽样画面分析";
  if (status === "PROFILE_READY") return "画面分析完成，正在生成保守优化参数";
  const sample = status.match(/^SAMPLE_(\d+)_OF_(\d+)$/);
  if (sample) return `正在抽样分析画面质量 ${sample[1]}/${sample[2]}`;
  return "正在分析画面质量";
}

function qualityProfileNumber(value: unknown, name: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`轻微音画优化的${name}分析结果无效`);
  return number;
}

function parseQualityProfileResult(value: unknown): { visual: QualityVisualProfile; profile: QualityOptimizeProfile } {
  if (!value || typeof value !== "object") throw new Error("轻微音画优化未返回有效的画面分析结果");
  const result = value as Record<string, unknown>;
  if (result.success !== true || !result.visual || !result.profile) {
    throw new Error(typeof result.message === "string" ? result.message : "轻微音画优化的画面分析失败");
  }
  const visual = result.visual as Record<string, unknown>;
  const profile = result.profile as Record<string, unknown>;
  const denoise = typeof profile.denoise === "string" ? profile.denoise : "";
  const sharpen = typeof profile.sharpen === "string" ? profile.sharpen : "";
  if (!/^hqdn3d=/.test(denoise) || !/^unsharp=/.test(sharpen)) {
    throw new Error("轻微音画优化的保守滤镜参数无效");
  }
  return {
    visual: {
      avgLuma: qualityProfileNumber(visual.avgLuma, "亮度"),
      avgSaturation: qualityProfileNumber(visual.avgSaturation, "饱和度"),
      avgR: qualityProfileNumber(visual.avgR, "红色通道"),
      avgG: qualityProfileNumber(visual.avgG, "绿色通道"),
      avgB: qualityProfileNumber(visual.avgB, "蓝色通道"),
      highlightRatio: qualityProfileNumber(visual.highlightRatio, "高光"),
      shadowRatio: qualityProfileNumber(visual.shadowRatio, "暗部"),
      skinRatio: qualityProfileNumber(visual.skinRatio, "肤色"),
      samples: qualityProfileNumber(visual.samples, "抽样数量"),
    },
    profile: {
      brightness: qualityProfileNumber(profile.brightness, "亮度调整"),
      contrast: qualityProfileNumber(profile.contrast, "对比度调整"),
      saturation: qualityProfileNumber(profile.saturation, "饱和度调整"),
      gamma: qualityProfileNumber(profile.gamma, "伽马调整"),
      rr: qualityProfileNumber(profile.rr, "红色校正"),
      gg: qualityProfileNumber(profile.gg, "绿色校正"),
      bb: qualityProfileNumber(profile.bb, "蓝色校正"),
      denoise,
      sharpen,
    },
  };
}

async function analyzeQualityProfile({
  runtime,
  inputPath,
  duration,
  signal,
  onProgress,
}: {
  runtime: MetadataCleanupRuntime;
  inputPath: string;
  duration: number;
  signal: AbortSignal;
  onProgress: (value: number, stage: string) => Promise<void> | void;
}) {
  let pending = "";
  let resultLine = "";
  let progressQueue = Promise.resolve();
  const consumeOutput = (chunk: string | Buffer) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const match = line.match(/^PROFILE\|([\d.]+)\|([A-Z0-9_]+)$/);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) progressQueue = progressQueue.then(() => onProgress(value, qualityProfileStage(match[2])));
      } else if (line.startsWith("{")) {
        resultLine = line;
      }
    }
  };
  let response: { stdout: string | Buffer };
  try {
    response = await runLocalProcess(runtime.pythonPath, [
      "-u", runtime.qualityProfilePath,
      "--input", inputPath,
      "--ffmpeg", runtime.ffmpegPath,
      "--duration", String(duration),
    ], { signal, onStdout: consumeOutput });
  } finally {
    await progressQueue;
  }
  if (!resultLine) {
    const output = Buffer.isBuffer(response!.stdout) ? response!.stdout.toString("utf8") : response!.stdout;
    resultLine = output.split(/\r?\n/).find((line) => line.startsWith("{")) || "";
  }
  try {
    return parseQualityProfileResult(JSON.parse(resultLine));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("轻微音画优化的画面分析结果无法读取");
  }
}

async function executeDeepMetadataCleanup({
  runtime,
  inputPath,
  outputPath,
  signal,
  onProgress,
}: {
  runtime: MetadataCleanupRuntime;
  inputPath: string;
  outputPath: string;
  signal: AbortSignal;
  onProgress: (progress: number, stage: string) => Promise<void> | void;
}) {
  let pending = "";
  let lastMessage = "";
  let lastProgress = -1;
  let progressQueue = Promise.resolve();
  const consumeOutput = (chunk: string | Buffer) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const match = line.match(/^PROGRESS\|([\d.]+)\|([A-Z_]+)$/);
      if (!match) continue;
      const value = Math.max(0, Math.min(100, Number(match[1])));
      if (!Number.isFinite(value)) continue;
      const stage = deepMetadataCleanupStage(match[2]);
      if (stage !== lastMessage || value - lastProgress >= 5 || value >= 100) {
        lastMessage = stage;
        lastProgress = value;
        progressQueue = progressQueue.then(() => onProgress(value, stage));
      }
    }
  };
  try {
    await runLocalProcess(runtime.pythonPath, buildDeepMetadataCleanupArgs({ inputPath, outputPath, runtime }), {
      signal,
      onStdout: consumeOutput,
    });
  } finally {
    await progressQueue;
  }
}

async function executeFfmpeg({
  ffmpegPath,
  args,
  duration,
  signal,
  onProgress,
}: {
  ffmpegPath: string;
  args: string[];
  duration: number;
  signal: AbortSignal;
  onProgress: (value: number) => Promise<void> | void;
}) {
  let lastProgress = 0;
  let pending = "";
  let progressQueue = Promise.resolve();
  const consumeProgress = (chunk: string | Buffer) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      const seconds = timestampToSeconds(line);
      if (seconds === null || !duration) continue;
      const value = Math.min(0.97, Math.max(0, seconds / duration));
      if (value - lastProgress >= 0.05) {
        lastProgress = value;
        progressQueue = progressQueue.then(() => onProgress(value));
      }
    }
  };
  try {
    await runLocalProcess(ffmpegPath, args, {
      signal,
      onStdout: consumeProgress,
      onStderr: (chunk: string) => {
      const seconds = timestampToSeconds(chunk);
      if (seconds === null || !duration) return;
      const value = Math.min(0.97, Math.max(0, seconds / duration));
      if (value - lastProgress >= 0.05) {
        lastProgress = value;
        progressQueue = progressQueue.then(() => onProgress(value));
      }
      },
    });
  } finally {
    await progressQueue;
  }
}

function assertSourcePath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (!path.isAbsolute(filePath) || !videoExtensions.has(extension)) {
    throw new Error(`不支持的视频文件：${path.basename(filePath) || filePath}`);
  }
  if (/\.__luma_quality_(?:tmp|backup)-/i.test(filePath)) {
    throw new Error(`不能处理临时文件：${path.basename(filePath)}`);
  }
}

export async function validateMaterialSources(filePaths: string[]) {
  const unique = [...new Set(filePaths.map((item) => path.resolve(item)))];
  if (!unique.length) throw new Error("请先选择至少一个本地视频文件");
  if (unique.length > MAX_LOCAL_MATERIAL_FILES) {
    throw new Error(`单批最多选择 ${MAX_LOCAL_MATERIAL_FILES} 个本地视频，请分批处理`);
  }
  for (const filePath of unique) {
    assertSourcePath(filePath);
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile() || details.size < 1024) {
      throw new Error(`视频文件不存在、为空或不可访问：${path.basename(filePath)}`);
    }
  }
  return unique;
}

export async function recoverMaterialProcessingFiles(sourceFiles: string[], { renameFile = rename } = {}) {
  const sources = [...new Set(sourceFiles.filter((item) => typeof item === "string" && path.isAbsolute(item)))];
  for (const sourcePath of sources) {
    const directory = path.dirname(sourcePath);
    const prefix = `${baseVideoName(sourcePath)}.__luma_quality_`;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const temporaryFiles = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => path.join(directory, entry.name));
    const backup = temporaryFiles.find((filePath) => /__luma_quality_backup-/i.test(filePath));
    if (!(await exists(sourcePath).catch(() => false)) && backup) {
      // Never delete the only remaining original if restoration fails.
      await renameFile(backup, sourcePath);
    }
    await Promise.all(temporaryFiles.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
  }
}

async function removeDeepMetadataArtifacts(outputPath: string) {
  const extension = path.extname(outputPath);
  const stem = outputPath.slice(0, -extension.length);
  await Promise.all([
    rm(outputPath, { force: true }).catch(() => undefined),
    rm(`${stem}.part.mp4`, { force: true }).catch(() => undefined),
    rm(`${stem}.video.mp4`, { force: true }).catch(() => undefined),
  ]);
}

export async function recoverMetadataCleanupFiles(outputFolder: string | null, sourceFiles: string[]) {
  if (!outputFolder || !(await exists(outputFolder).catch(() => false))) return;
  const sourcePrefixes = new Set(sourceFiles.map((filePath) => `${baseVideoName(filePath)}_已清理`));
  const entries = await readdir(outputFolder, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile()
      && /\.(?:part|video)\.mp4$/i.test(entry.name)
      && [...sourcePrefixes].some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => rm(path.join(outputFolder, entry.name), { force: true }).catch(() => undefined)));
}

export async function processMaterialFiles({
  mode,
  sourceFiles,
  outputFolder,
  ffmpegPath,
  ffprobePath,
  metadataCleanupRuntime,
  signal,
  onProgress,
  onRow,
  onEncoderFallback,
}: {
  mode: MaterialProcessingMode;
  sourceFiles: string[];
  outputFolder: string | null;
  ffmpegPath: string;
  ffprobePath: string;
  metadataCleanupRuntime: MetadataCleanupRuntime;
  signal: AbortSignal;
  onProgress: (progress: ProcessorProgress) => Promise<void> | void;
  onRow: (row: MaterialProcessingRow) => Promise<void> | void;
  onEncoderFallback: (fileName: string) => Promise<void> | void;
}) {
  const sources = await validateMaterialSources(sourceFiles);
  if (mode === "metadata-cleanup" && !outputFolder) throw new Error("请先选择元数据清理的输出位置");
  const qualityFfmpegPath = metadataCleanupRuntime.ffmpegPath;
  const qualityFfprobePath = metadataCleanupRuntime.ffprobePath;
  const supportsNvidia = mode === "quality-optimize" && await probeNvidiaEncoder({ ffmpegPath: qualityFfmpegPath });
  let selectedEncoder: "nvidia" | "cpu" = supportsNvidia ? "nvidia" : "cpu";
  const rows: MaterialProcessingRow[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    if (signal.aborted) throw new Error("任务已停止");
    const sourcePath = sources[index];
    const fileName = path.basename(sourcePath);
    let sourceInfo: VideoInfo | null = null;
    const baseProgress = Math.round((index / sources.length) * 92);
    const progressForFile = async (stage: string, fraction: number, logMessage?: string) => {
      const progress = Math.min(98, baseProgress + Math.round((fraction / sources.length) * 92));
      await onProgress({ fileIndex: index + 1, total: sources.length, fileName, stage, progress, logMessage });
    };

    let outputPath = "";
    try {
      const sourceFfmpegPath = mode === "quality-optimize" ? qualityFfmpegPath : ffmpegPath;
      const sourceFfprobePath = mode === "quality-optimize" ? qualityFfprobePath : ffprobePath;
      sourceInfo = await probeVideo({ ffmpegPath: sourceFfmpegPath, ffprobePath: sourceFfprobePath, filePath: sourcePath });
      const currentSourceInfo = sourceInfo;
      await progressForFile(
        mode === "metadata-cleanup" ? "正在检查视频并准备深度清理" : "正在分析并轻微优化音画",
        0.04,
        `${fileName}：已开始处理`,
      );
      if (mode === "metadata-cleanup") {
        const inputMetadata = await probeMaterialMetadata(metadataCleanupRuntime.ffprobePath, sourcePath, signal);
        outputPath = await uniqueCleanupPath(outputFolder as string, sourcePath);
        let lastDetailedProgress = 0;
        await progressForFile("正在执行深度元数据与技术标签清理", 0.08, `${fileName}：开始深度元数据、SEI 与技术标签清理`);
        await executeDeepMetadataCleanup({
          runtime: metadataCleanupRuntime,
          inputPath: sourcePath,
          outputPath,
          signal,
          onProgress: async (value, stage) => {
            const rounded = Math.round(value);
            const shouldLog = rounded >= 100 || (rounded >= 50 && rounded - lastDetailedProgress >= 50);
            if (shouldLog) {
              lastDetailedProgress = rounded;
            }
            await progressForFile(
              stage,
              0.08 + (value / 100) * 0.78,
              shouldLog ? `${fileName}：${stage} ${rounded}%` : undefined,
            );
          },
        });
        await progressForFile("正在校验清理后的文件", 0.9, `${fileName}：正在校验输出时长、规格、编码、音视频轨与首中尾解码`);
        await validateOutput({
          ffmpegPath,
          ffprobePath,
          filePath: outputPath,
          input: currentSourceInfo,
          expectedVideo: deepMetadataCleanupConfig,
        });
        const outputMetadata = await probeMaterialMetadata(metadataCleanupRuntime.ffprobePath, outputPath, signal);
        if (outputMetadata.residualFields.length) {
          throw new Error(`元数据残留校验失败：${outputMetadata.residualFields.join("、")}`);
        }
        await progressForFile("深度清理与输出校验通过", 0.98,
          `${fileName}：来源属性 ${inputMetadata.residualFields.length} 项 → 残留 0 项；已核验 ${outputMetadata.checkedStreamCount} 条音视频轨、编码、时长与首中尾解码`);
      } else {
        const extension = path.extname(sourcePath);
        const temporaryPath = path.join(path.dirname(sourcePath), `${baseVideoName(sourcePath)}.__luma_quality_tmp-${crypto.randomUUID()}${extension}`);
        const backupPath = path.join(path.dirname(sourcePath), `${baseVideoName(sourcePath)}.__luma_quality_backup-${crypto.randomUUID()}${extension}`);
        try {
          let lastQualityProgress = 0;
          await progressForFile("正在抽样分析画面质量", 0.04, `${fileName}：开始抽取画面样本，按原脚本分析亮度、高光、暗部、饱和度与肤色`);
          const profileResult = await analyzeQualityProfile({
            runtime: metadataCleanupRuntime,
            inputPath: sourcePath,
            duration: currentSourceInfo.duration,
            signal,
            onProgress: async (value, stage) => {
              await progressForFile(stage, 0.04 + Math.min(20, Math.max(0, value)) / 20 * 0.18);
            },
          });
          const { visual, profile } = profileResult;
          await progressForFile(
            "画面分析完成，正在生成保守优化参数",
            0.22,
            `${fileName}：画面分析完成，亮度 ${visual.avgLuma.toFixed(3)}，高光 ${(visual.highlightRatio * 100).toFixed(1)}%，暗部 ${(visual.shadowRatio * 100).toFixed(1)}%，饱和 ${visual.avgSaturation.toFixed(3)}`,
          );
          const execute = async (encoder: "nvidia" | "cpu") => {
            const encoderLabel = extension.toLowerCase() === ".webm" ? "CPU VP9 编码" : encoder === "nvidia" ? "NVIDIA 编码" : "CPU libx264 编码";
            await progressForFile(`正在使用${encoderLabel}按分析参数优化音画`, 0.25, `${fileName}：按分析参数轻微优化色彩、锐化、降噪、人声与响度，使用${encoderLabel}`);
            await executeFfmpeg({
              ffmpegPath: qualityFfmpegPath,
              args: buildQualityOptimizeArgs({ inputPath: sourcePath, outputPath: temporaryPath, hasAudio: currentSourceInfo.hasAudio, encoder, profile }),
              duration: currentSourceInfo.duration,
              signal,
              onProgress: async (value) => {
                const rounded = Math.round(value * 100);
                const stage = `正在使用${encoderLabel}按分析参数优化音画`;
                const shouldLog = rounded >= 97 || (rounded >= 50 && rounded - lastQualityProgress >= 50);
                if (shouldLog) {
                  lastQualityProgress = rounded;
                }
                await progressForFile(stage, 0.25 + value * 0.63, shouldLog ? `${fileName}：${encoderLabel}优化进度 ${rounded}%` : undefined);
              },
            });
          };
          try {
            await execute(selectedEncoder);
          } catch (error) {
            if (selectedEncoder !== "nvidia" || signal.aborted) throw error;
            selectedEncoder = "cpu";
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            await onEncoderFallback(fileName);
            await execute("cpu");
          }
          await progressForFile("正在校验优化后的文件", 0.9, `${fileName}：正在校验输出时长、规格、编码、音视频轨与首中尾解码`);
          await validateOutput({ ffmpegPath: qualityFfmpegPath, ffprobePath: qualityFfprobePath, filePath: temporaryPath, input: currentSourceInfo, webm: extension.toLowerCase() === ".webm" });
          if (signal.aborted) throw new Error("任务已停止，原文件未替换");
          await progressForFile("校验通过，正在安全覆盖原文件", 0.96, `${fileName}：输出校验通过，正在安全覆盖原文件`);
          await rename(sourcePath, backupPath);
          await rename(temporaryPath, sourcePath);
          await rm(backupPath, { force: true }).catch(() => undefined);
          outputPath = sourcePath;
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          if (!(await exists(sourcePath).catch(() => false)) && await exists(backupPath).catch(() => false)) {
            // Propagate restoration failures and preserve the backup on disk.
            await rename(backupPath, sourcePath);
          }
          throw error;
        }
      }
      const row: MaterialProcessingRow = {
        planId: fileName,
        output: outputPath,
        sources: [fileName],
        segments: [],
        duration: sourceInfo?.duration || 0,
        status: "done",
        error: "",
      };
      rows.push(row);
      await onRow(row);
    } catch (error) {
      if (mode === "metadata-cleanup" && outputPath) {
        await removeDeepMetadataArtifacts(outputPath);
      }
      if (signal.aborted) throw error;
      const row: MaterialProcessingRow = {
        planId: fileName,
        output: "",
        sources: [fileName],
        segments: [],
        duration: sourceInfo?.duration || 0,
        status: "failed",
        error: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "处理失败",
      };
      rows.push(row);
      await onRow(row);
    }
  }
  return rows;
}

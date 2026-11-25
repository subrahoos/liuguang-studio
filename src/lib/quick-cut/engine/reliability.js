const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { runProcess } = require("./process/run-process");

const nvidiaProbeCache = new Map();

function parseFrameRate(value) {
  if (!value) return 0;
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function volumeName(folder) {
  const root = path.parse(path.resolve(folder)).root.replace(/[\\/]$/, "");
  return root || path.resolve(folder);
}

function sameVolume(left, right) {
  return volumeName(left).toLowerCase() === volumeName(right).toLowerCase();
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

async function ensureDiskSpace({
  folder,
  requiredBytes,
  statfs = fs.statfs,
}) {
  const stats = await statfs(folder);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(
      `${volumeName(folder)} 可用空间不足，流光快剪本次任务至少需要 ${formatBytes(requiredBytes)}`,
    );
  }
  return availableBytes;
}

async function ensureWritableFolder({
  folder,
  mkdir = fs.mkdir,
  writeFile = fs.writeFile,
  rm = fs.rm,
}) {
  const targetFolder = path.resolve(folder);
  const probePath = path.join(
    targetFolder,
    `.luma-quick-cut-write-probe-${crypto.randomUUID()}.tmp`,
  );
  try {
    await mkdir(targetFolder, { recursive: true });
    await writeFile(probePath, "");
  } catch {
    throw new Error(`${volumeName(targetFolder)} 输出位置没有写入权限，请重新选择可写入的文件夹`);
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined);
  }
  return targetFolder;
}

async function probeNvidiaEncoder({
  ffmpegPath,
  runner = runProcess,
  useCache = true,
}) {
  const cacheKey = path.resolve(ffmpegPath).toLowerCase();
  if (useCache && nvidiaProbeCache.has(cacheKey)) {
    return nvidiaProbeCache.get(cacheKey);
  }

  let supported = false;
  try {
    await runner(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=256x256:r=30",
      "-frames:v", "2",
      "-an",
      "-c:v", "h264_nvenc",
      "-preset", "p5",
      "-rc", "vbr",
      "-cq", "23",
      "-b:v", "0",
      "-pix_fmt", "yuv420p",
      "-f", "null",
      "-",
    ]);
    supported = true;
  } catch {
    supported = false;
  }
  if (useCache) nvidiaProbeCache.set(cacheKey, supported);
  return supported;
}

function clearNvidiaProbeCache() {
  nvidiaProbeCache.clear();
}

function probeData(stdout) {
  try {
    return JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout));
  } catch {
    throw new Error("成片校验失败：FFprobe 返回了无效结果");
  }
}

async function validateRenderedVideo({
  ffmpegPath,
  ffprobePath,
  filePath,
  expectedDuration,
  expectAudio = true,
  runner = runProcess,
  stat = fs.stat,
}) {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size < 1024) {
    throw new Error("成片校验失败：输出文件为空或不完整");
  }

  const { stdout } = await runner(ffprobePath, [
    "-v", "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration",
    "-of", "json",
    filePath,
  ]);
  const data = probeData(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration);
  const fps = parseFrameRate(video?.avg_frame_rate || video?.r_frame_rate);
  if (!video || Number(video.width) <= 0 || Number(video.height) <= 0 || fps <= 0) {
    throw new Error("成片校验失败：输出文件没有有效的视频画面");
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("成片校验失败：输出文件时长无效");
  }
  if (expectAudio && !audio) {
    throw new Error("成片校验失败：输出文件缺少音轨");
  }

  const plannedDuration = Number(expectedDuration);
  if (Number.isFinite(plannedDuration) && plannedDuration > 0) {
    const minimum = Math.max(0.5, plannedDuration * 0.75);
    const maximum = plannedDuration + Math.max(3, plannedDuration * 0.25);
    if (duration < minimum || duration > maximum) {
      throw new Error(
        `成片校验失败：输出时长 ${duration.toFixed(1)} 秒与计划时长 ${plannedDuration.toFixed(1)} 秒不一致`,
      );
    }
  }

  await runner(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-i", filePath,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-an",
    "-f", "null",
    "-",
  ]).catch(() => {
    throw new Error("成片校验失败：输出画面无法解码");
  });

  return {
    duration,
    width: Number(video.width),
    height: Number(video.height),
    fps,
    hasAudio: Boolean(audio),
    size: metadata.size,
  };
}

function quickCutUserError(error) {
  const detail = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .map(String)
    .join("\n");
  if (/^成片校验失败|^任务已停止|^流光快剪/.test(detail)) {
    return String(error.message || detail).split(/\r?\n/, 1)[0];
  }
  const firstLine = String(error?.message || "").split(/\r?\n/, 1)[0].trim();
  if (/^[\u3400-\u9FFF]/.test(firstLine) && firstLine.length <= 200) {
    return firstLine;
  }
  if (/No space left|not enough space|disk full|磁盘空间/i.test(detail)) {
    return "磁盘空间不足，请清理任务工作盘和输出盘后重试";
  }
  if (/Permission denied|Access is denied|EACCES|EPERM/i.test(detail)) {
    return "输出位置没有写入权限，请重新选择可写入的文件夹";
  }
  if (/Invalid data|moov atom not found|could not find codec parameters|error reading header/i.test(detail)) {
    return "素材文件损坏或编码格式无法读取，请清除对应素材后重新导入";
  }
  if (/NVENC|CUDA|h264_nvenc|InitializeEncoder/i.test(detail)) {
    return "显卡编码失败，流光快剪已尝试切换软件编码";
  }
  if (/Unknown encoder|Error while opening encoder|Error initializing output stream/i.test(detail)) {
    return "视频编码器启动失败，请检查本地 FFmpeg 运行资源";
  }
  if (/filter|subtitles|Error reinitializing filters/i.test(detail)) {
    return "视频画面或字幕处理失败，请检查素材画面尺寸后重试";
  }
  return "视频处理失败，请检查素材是否可正常播放、磁盘空间和输出权限后重试";
}

async function stageLocalToolFiles({ files, stagingFolder, prefix }) {
  await fs.rm(stagingFolder, { recursive: true, force: true });
  await fs.mkdir(stagingFolder, { recursive: true });
  const staged = [];
  const safePrefix = String(prefix || "asset").replace(/[^a-z0-9_-]/gi, "-") || "asset";
  for (let index = 0; index < files.length; index += 1) {
    const sourcePath = files[index];
    const extension = path.extname(sourcePath).toLowerCase();
    const targetPath = path.join(
      stagingFolder,
      `${safePrefix}-${String(index + 1).padStart(3, "0")}${extension}`,
    );
    await fs.copyFile(sourcePath, targetPath);
    const [sourceStat, targetStat] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)]);
    if (sourceStat.size <= 0 || sourceStat.size !== targetStat.size) {
      throw new Error(`素材暂存失败：${path.basename(sourcePath)} 复制不完整`);
    }
    staged.push(targetPath);
  }
  return staged;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function uniqueDeliveryPath(outputFolder, deliveryName) {
  for (let index = 1; index <= 999; index += 1) {
    const suffix = index === 1 ? "" : ` (${index})`;
    const candidate = path.join(outputFolder, `${deliveryName}${suffix}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error("输出目录中同名任务过多，请更换任务名称后重试");
}

async function commitVideoDelivery({
  sourceFolder,
  outputFolder,
  deliveryName,
  expectedCount,
  fileNamePrefix = "",
  copyFile = fs.copyFile,
}) {
  await fs.mkdir(outputFolder, { recursive: true });
  const entries = await fs.readdir(sourceFolder, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (!names.length) throw new Error("没有可交付的成片文件");
  if (Number.isInteger(expectedCount) && names.length !== expectedCount) {
    throw new Error(`成片交付校验失败：应有 ${expectedCount} 个文件，实际找到 ${names.length} 个`);
  }

  const finalFolder = await uniqueDeliveryPath(outputFolder, deliveryName);
  const stagingFolder = path.join(
    outputFolder,
    `.${path.basename(finalFolder)}.partial-${crypto.randomUUID()}`,
  );
  try {
    await fs.mkdir(stagingFolder, { recursive: false });
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const safePrefix = String(fileNamePrefix || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .trim()
        .slice(0, 60);
      const targetName = safePrefix
        ? `${safePrefix}-${String(index + 1).padStart(3, "0")}.mp4`
        : name;
      const source = path.join(sourceFolder, name);
      const target = path.join(stagingFolder, targetName);
      await copyFile(source, target);
      const [sourceStat, targetStat] = await Promise.all([fs.stat(source), fs.stat(target)]);
      if (sourceStat.size <= 0 || sourceStat.size !== targetStat.size) {
        throw new Error(`成片交付校验失败：${name} 复制不完整`);
      }
    }
    await fs.rename(stagingFolder, finalFolder);
    return finalFolder;
  } catch (error) {
    await fs.rm(stagingFolder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  clearNvidiaProbeCache,
  commitVideoDelivery,
  ensureDiskSpace,
  ensureWritableFolder,
  probeNvidiaEncoder,
  quickCutUserError,
  sameVolume,
  stageLocalToolFiles,
  validateRenderedVideo,
  volumeName,
};

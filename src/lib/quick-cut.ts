import { existsSync } from "fs";
import { mkdir, open, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { quickCutTasks } from "@/lib/db/schema";
import { resolveSafeRelativePath, storagePaths } from "@/lib/storage-root";
import { loadQuickCutOnnxRuntime, quickCutRuntimePaths } from "@/lib/quick-cut/onnx-runtime";
import { scanMediaFolder } from "@/lib/quick-cut/engine/media/scanner";
import { listAssets } from "@/lib/quick-cut/engine/media/assets";
import { analyzeMediaSet, isNvidiaEncodingError } from "@/lib/quick-cut/engine/tasks/task-service";
import { createFaceDetector } from "@/lib/quick-cut/engine/analysis/face-detector";
import { createPersonDetector } from "@/lib/quick-cut/engine/analysis/person-detector";
import { planDeepMixes } from "@/lib/quick-cut/engine/mix/deep-planner";
import { buildRenderArgs } from "@/lib/quick-cut/engine/mix/command-builder";
import { runPlannedJobs } from "@/lib/quick-cut/engine/jobs/job-runner";
import { createDeliveryFolders } from "@/lib/quick-cut/engine/delivery/manifest";
import { subtitlesFromPlan, toSrt } from "@/lib/quick-cut/engine/subtitles/srt";
import { runProcess } from "@/lib/quick-cut/engine/process/run-process";
import { commitVideoDelivery, ensureDiskSpace, ensureWritableFolder, probeNvidiaEncoder, quickCutUserError, sameVolume, stageLocalToolFiles, validateRenderedVideo } from "@/lib/quick-cut/engine/reliability";
import { appendQuickCutRunHistory, archiveQuickCutRun, needsQuickCutRunRecovery, quickCutRunHistory, type QuickCutRunArchive, type QuickCutStoredRow } from "@/lib/quick-cut/task-state";
import { processMaterialFiles, recoverMaterialProcessingFiles, recoverMetadataCleanupFiles, validateMaterialSources, type MaterialProcessingMode, type MaterialProcessingRow } from "@/lib/quick-cut/material-processor";
import { pickLocalFolder, pickLocalVideoFiles, warmLocalPickerWorker } from "@/lib/quick-cut/local-file-picker";
import { assertExternalQuickCutOutputFolder, isPathWithin } from "@/lib/quick-cut/output-path";

// The local media engine is CommonJS source with no TypeScript declarations.
// Keep that boundary explicit so the 3100 API remains strictly typed.
type LegacyAnalysis = { sources: unknown[]; summary: Record<string, unknown> };
type LegacyBatch = { plans: Array<Record<string, unknown>>; warnings?: unknown[]; [key: string]: unknown };
type LegacyBatchResult = { completed: number; failed: number; stopped: boolean; rows: Array<Record<string, unknown>> };
type LegacyDetector = { detect: (buffer: Buffer) => Promise<unknown[]> };

const analyzeQuickCutMedia = analyzeMediaSet as unknown as (input: Record<string, unknown>) => Promise<LegacyAnalysis>;
const planQuickCutMixes = planDeepMixes as unknown as (input: Record<string, unknown>) => LegacyBatch;
const runQuickCutJobs = runPlannedJobs as unknown as (input: Record<string, unknown>) => Promise<LegacyBatchResult>;
const runQuickCutProcess = runProcess as (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
const createQuickCutFaceDetector = createFaceDetector as unknown as (options: Record<string, unknown>) => Promise<LegacyDetector>;
const createQuickCutPersonDetector = createPersonDetector as unknown as (options: Record<string, unknown>) => Promise<LegacyDetector>;

export type QuickCutTaskStatus = "draft" | "scanning" | "ready" | "analyzing" | "rendering" | "processing" | "completed" | "partial" | "failed" | "stopped";
export type QuickCutAssetKind = "source" | "product" | "bgm";
export type QuickCutProcessingMode = MaterialProcessingMode;

export type QuickCutSettings = {
  fit: "blur" | "crop" | "pad";
  audioMode: "original" | "mix" | "bgm";
  bgmVolume: number;
  fps: 24 | 25 | 30;
  quality: "compact" | "balanced" | "high";
  encoder: "auto" | "cpu" | "nvidia";
  transition: "cut" | "fade";
  productTailDuration: 1 | 1.5 | 2 | 3;
  subtitles: boolean;
};

export type QuickCutStartRequest = {
  taskName: string;
  count: number;
  countMode?: "smart" | "custom";
  durationMode: "smart" | "fixed";
  targetDuration: 15 | 30 | 45 | 60 | null;
  editingMode: "auto" | "presenter" | "voice-over" | "product-footage" | "fashion-showcase";
  seed?: number;
  settings: QuickCutSettings;
};

type QuickCutEvent = {
  at: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
};

type QuickCutRow = QuickCutStoredRow;
type QuickCutProcessingSettings = {
  mode: QuickCutProcessingMode | null;
  sources: string[];
  outputFolder: string | null;
  lastOutputFolder: string | null;
};

type QuickCutTask = typeof quickCutTasks.$inferSelect;
type QuickCutAssetCounts = Record<QuickCutAssetKind, number>;

const activeControllers = new Map<string, AbortController>();
const assetCountsByTask = new Map<string, QuickCutAssetCounts>();
const videoExtensions = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CURRENT_RUN_EVENTS = 1000;

function taskKey(ownerId: string, taskId: string) {
  return `${ownerId}:${taskId}`;
}

function isTaskId(value: string) {
  return /^[a-f0-9-]{36}$/i.test(value);
}

function safeTaskName(value: string) {
  return String(value || "流光快剪")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim()
    .slice(0, 60) || "流光快剪";
}

function toRelative(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/");
}

function taskFolders(ownerId: string, taskId: string) {
  const root = storagePaths.quickCut(ownerId, taskId);
  return {
    root,
    source: path.join(root, "input"),
    product: path.join(root, "assets", "product"),
    bgm: path.join(root, "assets", "bgm"),
    output: path.join(root, "output"),
    work: path.join(root, "work"),
    cache: path.join(root, "analysis-cache.json"),
  };
}

function configuredOutputFolder(settings: Record<string, unknown> | null | undefined, key = "outputFolder") {
  const value = settings?.[key];
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function configuredProcessingFolder(settings: Record<string, unknown> | null | undefined, key: string) {
  const value = settings?.[key];
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function processingSettings(settings: Record<string, unknown> | null | undefined): QuickCutProcessingSettings {
  const sourcePaths = Array.isArray(settings?.processingSources)
    ? settings.processingSources
      .filter((item): item is string => typeof item === "string" && path.isAbsolute(item))
      .map((item) => path.resolve(item))
    : [];
  const mode = settings?.processingMode === "metadata-cleanup" || settings?.processingMode === "quality-optimize"
    ? settings.processingMode
    : null;
  return {
    mode,
    sources: sourcePaths,
    outputFolder: configuredProcessingFolder(settings, "processingOutputFolder"),
    lastOutputFolder: configuredProcessingFolder(settings, "lastProcessingOutputFolder"),
  };
}

function isQuickCutRunning(status: string) {
  return ["scanning", "analyzing", "rendering", "processing"].includes(status);
}

async function existingDirectory(folder: string | null) {
  if (!folder) return null;
  try {
    const info = await stat(folder);
    return info.isDirectory() ? folder : null;
  } catch {
    return null;
  }
}

async function clearQuickCutTransientArtifacts(ownerId: string, taskId: string) {
  const folders = taskFolders(ownerId, taskId);
  await Promise.all([
    rm(folders.output, { recursive: true, force: true }),
    rm(folders.work, { recursive: true, force: true }),
    rm(folders.cache, { force: true }),
  ]);
}

function settingsForNextRun(settings: Record<string, unknown> | null | undefined, archive: QuickCutRunArchive | null) {
  const next = { ...appendQuickCutRunHistory(settings, archive) } as Record<string, unknown>;
  delete next.lastExportFolder;
  delete next.lastProcessingOutputFolder;
  delete next.quickCutRunConfig;
  return next;
}

async function totalFileBytes(files: string[]) {
  const metadata = await Promise.all(files.map((filePath) => stat(filePath)));
  return metadata.reduce((sum, item) => sum + Number(item.size || 0), 0);
}

function assertSafeRelativePath(value: string) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("文件路径无效");
  }
  return normalized;
}

function appendEvent(events: unknown, event: QuickCutEvent) {
  const current = Array.isArray(events) ? events.filter((item) => item && typeof item === "object") : [];
  return [...current, event].slice(-MAX_CURRENT_RUN_EVENTS);
}

function event(level: QuickCutEvent["level"], message: string): QuickCutEvent {
  return { at: new Date().toISOString(), level, message };
}

function summarizeScan(scan: { valid: Array<Record<string, unknown>>; invalid: Array<Record<string, unknown>> }) {
  const totalDuration = scan.valid.reduce((sum, item) => sum + Number(item.duration || 0), 0);
  return {
    validCount: scan.valid.length,
    invalidCount: scan.invalid.length,
    totalDuration: Number(totalDuration.toFixed(3)),
    sources: scan.valid.map((item) => ({
      id: String(item.id || ""),
      duration: Number(item.duration || 0),
      width: Number(item.width || 0),
      height: Number(item.height || 0),
      fps: Number(item.fps || 0),
      hasAudio: Boolean(item.hasAudio),
      size: Number(item.size || 0),
    })),
    invalid: scan.invalid.map((item) => ({
      path: path.basename(String(item.path || "")),
      reason: String(item.reason || "无法读取素材"),
    })),
  };
}

function publicRow(row: QuickCutRow) {
  const publicData: Partial<QuickCutRow> = { ...row };
  if (!publicData.outputName && publicData.output) {
    publicData.outputName = path.basename(publicData.output);
  }
  delete publicData.output;
  delete publicData.cover;
  delete publicData.subtitle;
  return publicData;
}

function publicArchive(archive: QuickCutRunArchive) {
  return {
    ...archive,
    rows: archive.rows.map(publicRow),
  };
}

async function quickCutAssetCounts(task: QuickCutTask) {
  const key = taskKey(task.ownerId, task.id);
  const cached = assetCountsByTask.get(key);
  if (cached) return cached;
  const folders = taskFolders(task.ownerId, task.id);
  const list = (folder: string, kind: "video" | "image" | "audio") => listAssets(folder, kind).catch(() => []);
  const [source, product, bgm] = await Promise.all([
    list(folders.source, "video"),
    list(folders.product, "image"),
    list(folders.bgm, "audio"),
  ]);
  const counts = { source: source.length, product: product.length, bgm: bgm.length };
  assetCountsByTask.set(key, counts);
  return counts;
}

export async function toPublicQuickCutTask(task: QuickCutTask) {
  const rows = Array.isArray(task.rows) ? task.rows as QuickCutRow[] : [];
  const runHistory = quickCutRunHistory(task.settings);
  const folders = taskFolders(task.ownerId, task.id);
  const configuredOutput = configuredOutputFolder(task.settings);
  const outputFolder = configuredOutput && !isPathWithin(folders.root, configuredOutput) ? configuredOutput : null;
  const configuredLastExport = configuredOutputFolder(task.settings, "lastExportFolder");
  const lastExportFolder = configuredLastExport && !isPathWithin(folders.root, configuredLastExport)
    ? await existingDirectory(configuredLastExport)
    : null;
  const processing = processingSettings(task.settings);
  const lastProcessingOutputFolder = processing.lastOutputFolder && !isPathWithin(folders.root, processing.lastOutputFolder)
    ? await existingDirectory(processing.lastOutputFolder)
    : null;
  const publicSettings = { ...task.settings } as Record<string, unknown>;
  delete publicSettings.processingSources;
  const assetCounts = await quickCutAssetCounts(task);
  return {
    id: task.id,
    name: task.name,
    status: task.status as QuickCutTaskStatus,
    stage: task.stage,
    settings: publicSettings,
    scan: task.scan,
    analysisSummary: task.analysisSummary,
    plans: task.plans,
    rows: rows.map(publicRow),
    runHistory: runHistory.map(publicArchive),
    events: Array.isArray(task.events) ? task.events : [],
    progress: task.progress,
    total: task.total,
    completed: task.completed,
    failed: task.failed,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    outputFolder,
    lastExportFolder,
    outputReady: Boolean(lastExportFolder),
    hasOutput: Boolean(lastExportFolder) || runHistory.some((archive) => Boolean(archive.exportFolder)),
    assetCounts,
    processing: {
      mode: processing.mode,
      sourceCount: processing.sources.length,
      sourceNames: processing.sources.map((filePath) => path.basename(filePath)),
      outputFolder: processing.outputFolder,
      lastOutputFolder: lastProcessingOutputFolder,
    },
  };
}

export async function getOwnedQuickCutTask(ownerId: string, taskId: string) {
  if (!isTaskId(taskId)) return null;
  const [task] = await getDb()
    .select()
    .from(quickCutTasks)
    .where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)))
    .limit(1);
  return task ?? null;
}

export async function getQuickCutTaskForRead(ownerId: string, taskId: string) {
  const task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) return null;
  return recoverInterruptedQuickCutTask(ownerId, taskId, task);
}

export async function listQuickCutTasks(ownerId: string) {
  warmLocalPickerWorker();
  const tasks = await getDb()
    .select()
    .from(quickCutTasks)
    .where(eq(quickCutTasks.ownerId, ownerId))
    .orderBy(desc(quickCutTasks.updatedAt));
  const recovered = [];
  for (const task of tasks) {
    recovered.push(await recoverInterruptedQuickCutTask(ownerId, task.id, task));
  }
  return recovered;
}

export async function createQuickCutTask(ownerId: string, name = "流光快剪") {
  const id = crypto.randomUUID();
  const folders = taskFolders(ownerId, id);
  await Promise.all([
    mkdir(folders.source, { recursive: true }),
    mkdir(folders.product, { recursive: true }),
    mkdir(folders.bgm, { recursive: true }),
    mkdir(folders.output, { recursive: true }),
    mkdir(folders.work, { recursive: true }),
  ]);
  const now = new Date();
  await getDb().insert(quickCutTasks).values({
    id,
    ownerId,
    name: safeTaskName(name),
    status: "draft",
    stage: "等待导入素材",
    sourceRoot: toRelative(storagePaths.quickCut(), folders.source),
    taskRoot: toRelative(storagePaths.quickCut(), folders.root),
    settings: {},
    rows: [],
    events: [event("info", "任务已创建，等待导入素材")],
    createdAt: now,
    updatedAt: now,
  });
  const task = await getOwnedQuickCutTask(ownerId, id);
  if (!task) throw new Error("创建流光快剪任务失败");
  assetCountsByTask.set(taskKey(ownerId, id), { source: 0, product: 0, bgm: 0 });
  return task;
}

export async function selectQuickCutOutputFolder(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能修改输出位置");
  }
  const selected = await pickLocalFolder({ title: "选择本次混剪成片输出位置" });
  if (!selected) return null;
  assertExternalQuickCutOutputFolder(taskFolders(ownerId, taskId).root, selected);
  await ensureWritableFolder({ folder: selected });
  const settings = { ...task.settings, outputFolder: selected };
  await getDb().update(quickCutTasks).set({
    settings,
    events: appendEvent(task.events, event("info", `已选择本次任务输出位置：${selected}`)),
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
  return getOwnedQuickCutTask(ownerId, taskId);
}

async function resetForProcessingSetup(ownerId: string, taskId: string, task: QuickCutTask, settings: Record<string, unknown>, stage: string, message: string) {
  const archivedRun = archiveQuickCutRun(task);
  await getDb().update(quickCutTasks).set({
    status: "draft",
    stage,
    rows: [],
    plans: [],
    analysisSummary: null,
    progress: 0,
    total: 0,
    completed: 0,
    failed: 0,
    errorMessage: null,
    completedAt: null,
    settings: settingsForNextRun(settings, archivedRun),
    events: [event("info", message)],
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
}

export async function selectQuickCutProcessingSources(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能更换本地视频文件");
  }
  const selected = await pickLocalVideoFiles({ title: "选择需要清理或优化的本地视频" });
  if (!selected.length) {
    const settings = {
      ...task.settings,
      processingSources: [],
      processingMode: null,
      lastProcessingOutputFolder: null,
    };
    await resetForProcessingSetup(
      ownerId,
      taskId,
      task,
      settings,
      "已取消选择，请重新选择本地视频",
      "已取消选择，本次处理不再保留上次的视频文件",
    );
    return getOwnedQuickCutTask(ownerId, taskId);
  }
  const sources = await validateMaterialSources(selected);
  const settings = {
    ...task.settings,
    processingSources: sources,
    processingMode: null,
    lastProcessingOutputFolder: null,
  };
  await resetForProcessingSetup(
    ownerId,
    taskId,
    task,
    settings,
    `已选择 ${sources.length} 个本地视频，等待选择处理方式`,
    sources.length
      ? `已选择 ${sources.length} 个本地视频，可执行元数据清理或轻微音画优化`
      : "已取消选择，本次处理不再保留上次的视频文件",
  );
  return getOwnedQuickCutTask(ownerId, taskId);
}

export async function clearQuickCutProcessingSources(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能清除本地视频文件");
  }
  const settings = {
    ...task.settings,
    processingSources: [],
    processingMode: null,
    lastProcessingOutputFolder: null,
  };
  await resetForProcessingSetup(ownerId, taskId, task, settings, "本地视频已清除，请重新选择文件", "已清除素材处理的本地视频选择");
  return getOwnedQuickCutTask(ownerId, taskId);
}

export async function selectQuickCutProcessingOutputFolder(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能修改输出位置");
  }
  const selected = await pickLocalFolder({ title: "选择清理后的文件输出位置" });
  if (!selected) return null;
  await ensureWritableFolder({ folder: selected });
  const settings = {
    ...task.settings,
    processingOutputFolder: selected,
    processingMode: null,
    lastProcessingOutputFolder: null,
  };
  await resetForProcessingSetup(
    ownerId,
    taskId,
    task,
    settings,
    "已选择元数据清理输出位置，等待开始处理",
    `已选择元数据清理输出位置：${selected}`,
  );
  return getOwnedQuickCutTask(ownerId, taskId);
}

function assetRoot(ownerId: string, taskId: string, kind: QuickCutAssetKind) {
  const folders = taskFolders(ownerId, taskId);
  if (kind === "source") return folders.source;
  if (kind === "product") return folders.product;
  return folders.bgm;
}

function validExtension(kind: QuickCutAssetKind, name: string) {
  const ext = path.extname(name).toLowerCase();
  const accepted = kind === "source" ? videoExtensions : kind === "product" ? imageExtensions : audioExtensions;
  return accepted.has(ext);
}

async function writeUniqueQuickCutAssetStream(root: string, relativePath: string, content: ReadableStream<Uint8Array>, expectedSize: number | null) {
  const parsed = path.posix.parse(relativePath);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = index === 1 ? relativePath : path.posix.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    const target = resolveSafeRelativePath(root, candidate);
    await mkdir(path.dirname(target), { recursive: true });
    let handle;
    try {
      handle = await open(target, "wx");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }

    const reader = content.getReader();
    let written = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        written += value.byteLength;
        if (written > MAX_UPLOAD_BYTES) throw new Error("单个文件超过 4GB 限制");
        const chunk = Buffer.from(value);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("写入上传素材失败");
          offset += bytesWritten;
        }
      }
      if (!written) throw new Error("上传文件为空");
      if (expectedSize !== null && expectedSize !== written) throw new Error("上传文件不完整，请重新选择文件");
      await handle.close();
      return { relativePath: candidate, size: written };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("同名素材过多，无法创建唯一文件名");
}

export async function storeQuickCutAssetStream({
  ownerId,
  taskId,
  kind,
  relativePath,
  content,
  expectedSize,
}: {
  ownerId: string;
  taskId: string;
  kind: QuickCutAssetKind;
  relativePath: string;
  content: ReadableStream<Uint8Array>;
  expectedSize: number | null;
}) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId))) throw new Error("当前任务正在运行，不能导入或修改素材");
  if (!content) throw new Error("缺少上传文件");
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) throw new Error("上传文件大小无效");
  if (expectedSize !== null && expectedSize > MAX_UPLOAD_BYTES) throw new Error("单个文件超过 4GB 限制");
  if (kind === "source" && task.scan) throw new Error("当前任务已有已扫描的视频素材，请先清除素材后重新导入");
  const cleanPath = assertSafeRelativePath(relativePath);
  if (!validExtension(kind, cleanPath)) throw new Error("该素材类型不受支持");
  const root = assetRoot(ownerId, taskId, kind);
  const stored = await writeUniqueQuickCutAssetStream(root, cleanPath, content, expectedSize);
  assetCountsByTask.delete(taskKey(ownerId, taskId));
  const renamed = stored.relativePath !== cleanPath;
  const nextEvents = appendEvent(task.events, event("info", `已导入${kind === "source" ? "视频素材" : kind === "product" ? "商品主图" : "背景音乐"}：${path.basename(stored.relativePath)}${renamed ? "（同名文件已自动重命名）" : ""}`));
  await getDb().update(quickCutTasks).set({
    status: task.status === "draft" ? "draft" : task.status,
    stage: kind === "source" ? "素材已导入，等待扫描" : task.stage,
    events: nextEvents,
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
  return { relativePath: stored.relativePath, size: stored.size, renamed };
}

export async function scanQuickCutTask(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId))) throw new Error("当前任务正在运行");
  const folders = taskFolders(ownerId, taskId);
  const runtime = quickCutRuntimePaths();
  if (!existsSync(runtime.ffprobe)) throw new Error("流光快剪的 FFprobe 不可用");
  await getDb().update(quickCutTasks).set({
    status: "scanning",
    stage: "正在扫描素材",
    errorMessage: null,
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
  try {
    if (!existsSync(runtime.ffmpeg)) throw new Error("流光快剪的 FFmpeg 不可用");
    const sourceFiles = await listAssets(folders.source, "video");
    await mkdir(folders.root, { recursive: true });
    await ensureDiskSpace({
      folder: folders.root,
      requiredBytes: await totalFileBytes(sourceFiles) + 128 * 1024 * 1024,
    });
    const stagedFolder = path.join(folders.work, "scan-media");
    await stageLocalToolFiles({ files: sourceFiles, stagingFolder: stagedFolder, prefix: "source" });
    const result = await scanMediaFolder({ folder: stagedFolder, ffprobePath: runtime.ffprobe, ffmpegPath: runtime.ffmpeg });
    const scan = summarizeScan(result);
    const fresh = await getOwnedQuickCutTask(ownerId, taskId);
    await getDb().update(quickCutTasks).set({
      status: result.valid.length ? "ready" : "draft",
      stage: result.valid.length ? "素材扫描完成" : "未找到有效视频素材",
      scan,
      events: appendEvent(fresh?.events, event(result.valid.length ? "success" : "warning", result.valid.length ? `扫描完成：${result.valid.length} 条有效素材` : "没有扫描到可用视频素材")),
      updatedAt: new Date(),
    }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
    return scan;
  } catch (error) {
    const fresh = await getOwnedQuickCutTask(ownerId, taskId);
    const message = error instanceof Error ? error.message : "素材扫描失败";
    await getDb().update(quickCutTasks).set({
      status: "failed",
      stage: "素材扫描失败",
      errorMessage: message,
      events: appendEvent(fresh?.events, event("error", message)),
      updatedAt: new Date(),
    }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
    throw error;
  } finally {
    await rm(folders.work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validateStartRequest(request: QuickCutStartRequest) {
  const count = Number(request.count);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("生成数量必须在 1 到 50 之间");
  if (!request.durationMode || !["smart", "fixed"].includes(request.durationMode)) throw new Error("时长模式无效");
  if (request.durationMode === "fixed" && ![15, 30, 45, 60].includes(Number(request.targetDuration))) throw new Error("目标时长只能选择 15、30、45 或 60 秒");
  if (!["auto", "presenter", "voice-over", "product-footage", "fashion-showcase"].includes(request.editingMode)) throw new Error("剪辑模式无效");
  const settings = request.settings;
  if (!settings || !["blur", "crop", "pad"].includes(settings.fit)) throw new Error("画面适配方式无效");
  if (!["original", "mix", "bgm"].includes(settings.audioMode)) throw new Error("声音模式无效");
  if (![24, 25, 30].includes(Number(settings.fps))) throw new Error("帧率只能选择 24、25 或 30");
  if (!["compact", "balanced", "high"].includes(settings.quality)) throw new Error("视频质量设置无效");
  if (!["auto", "cpu", "nvidia"].includes(settings.encoder)) throw new Error("编码器设置无效");
  if (!["cut", "fade"].includes(settings.transition)) throw new Error("转场设置无效");
  if (!Number.isFinite(settings.bgmVolume) || settings.bgmVolume < 0 || settings.bgmVolume > 1) throw new Error("背景音乐音量必须在 0 到 1 之间");
  return {
    ...request,
    taskName: safeTaskName(request.taskName),
    count,
    countMode: request.editingMode === "fashion-showcase" && request.countMode === "smart" ? "smart" as const : "custom" as const,
    targetDuration: request.durationMode === "smart" ? null : Number(request.targetDuration) as 15 | 30 | 45 | 60,
    seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : Date.now(),
  };
}

function timestampToSeconds(value: string) {
  const match = String(value).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

export async function clearQuickCutSources(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能清除素材");
  }

  const folders = taskFolders(ownerId, taskId);
  await Promise.all([
    rm(folders.source, { recursive: true, force: true }),
    clearQuickCutTransientArtifacts(ownerId, taskId),
  ]);
  await mkdir(folders.source, { recursive: true });
  assetCountsByTask.delete(taskKey(ownerId, taskId));
  const archivedRun = archiveQuickCutRun(task);

  await getDb().update(quickCutTasks).set({
    status: "draft",
    stage: "视频素材已清除，请重新选择文件",
    scan: null,
    analysisSummary: null,
    plans: [],
    rows: [],
    settings: settingsForNextRun(task.settings, archivedRun),
    progress: 0,
    total: 0,
    completed: 0,
    failed: 0,
    errorMessage: null,
    completedAt: null,
    events: appendEvent(task.events, event("info", archivedRun ? "已归档上一批成片，并清除当前视频素材与内部临时文件" : "已清除当前任务的视频素材与内部临时文件")),
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));

  const next = await getOwnedQuickCutTask(ownerId, taskId);
  if (!next) throw new Error("清除素材后无法读取任务");
  return next;
}

export async function clearQuickCutOptionalAssets(ownerId: string, taskId: string, kind: Exclude<QuickCutAssetKind, "source">) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId)) || isQuickCutRunning(task.status)) {
    throw new Error("当前任务正在运行，不能清除素材");
  }

  const root = assetRoot(ownerId, taskId, kind);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  assetCountsByTask.delete(taskKey(ownerId, taskId));
  const label = kind === "product" ? "商品主图" : "背景音乐";
  await getDb().update(quickCutTasks).set({
    events: appendEvent(task.events, event("info", `已清除当前任务的${label}`)),
    updatedAt: new Date(),
  }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
  const next = await getOwnedQuickCutTask(ownerId, taskId);
  if (!next) throw new Error("清除素材后无法读取任务");
  return next;
}

function relativeRow(taskRoot: string, row: Record<string, unknown>, sourceNameByStagedName = new Map<string, string>()): QuickCutRow {
  const relative = (value: unknown) => value ? toRelative(taskRoot, String(value)) : "";
  const sources = Array.isArray(row.sources) ? row.sources.map((source) => toRelative(taskRoot, String(source))) : [];
  const segments = Array.isArray(row.segments)
    ? row.segments.map((segment) => {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) return segment;
      const normalized = { ...(segment as Record<string, unknown>) };
      for (const key of ["videoPath", "audioPath", "path", "sourcePath"]) {
        if (typeof normalized[key] === "string" && path.isAbsolute(normalized[key])) {
          normalized[key] = toRelative(taskRoot, normalized[key]);
        }
      }
      return normalized;
    })
    : [];
  return {
    planId: String(row.planId || ""),
    output: relative(row.output),
    outputName: row.output ? path.basename(String(row.output)) : "",
    cover: relative(row.cover),
    subtitle: relative(row.subtitle),
    sources,
    sourceNames: sources.map((source) => sourceNameByStagedName.get(path.basename(source).toLowerCase()) || path.basename(source)),
    diversityLevel: String(row.diversityLevel || ""),
    segments,
    duration: Number(row.duration || 0),
    status: row.status === "failed" ? "failed" : "done",
    error: String(row.error || ""),
  };
}

function planSources(plan: Record<string, unknown>) {
  const units = Array.isArray(plan.units) ? plan.units : Array.isArray(plan.segments) ? plan.segments : [];
  const names = units
    .map((unit) => unit && typeof unit === "object" ? (unit as Record<string, unknown>).videoPath || (unit as Record<string, unknown>).path : "")
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => path.basename(value));
  return [...new Set(names)];
}

function planningEvent(batch: LegacyBatch, plans: Array<Record<string, unknown>>) {
  const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const requested = number(batch.requestedCount, plans.length);
  const exact = number(batch.exactMatchCount, plans.length);
  const capacity = number(batch.meaningfulCapacity, plans.length);
  const estimate = number(batch.roughEstimatedCount, capacity);
  const shortages = Array.isArray(batch.shortages)
    ? batch.shortages.map((item) => {
      if (!item || typeof item !== "object") return String(item || "");
      const detail = item as Record<string, unknown>;
      return `${String(detail.label || "匹配镜头")}${Number(detail.missing || 0) > 0 ? ` 缺 ${Number(detail.missing)}` : ""}`;
    }).filter(Boolean)
    : [];
  const warnings = Array.isArray(batch.anchorWarnings) ? batch.anchorWarnings.filter((item) => typeof item === "string") : [];
  const suffix = shortages.length ? `；素材缺口：${shortages.slice(0, 2).join("、")}` : warnings.length ? `；锚点提示：${warnings.slice(0, 2).join("、")}` : "";
  const reason = typeof batch.capacityReason === "string" ? batch.capacityReason : "已按真实素材容量计算";
  return {
    level: shortages.length || warnings.length || exact < requested || plans.length < estimate ? "warning" as const : "success" as const,
    message: `规划完成：预计 ${estimate} 条，最终高质量容量 ${capacity} 条，实际生成 ${plans.length} 条；${reason}${suffix}`,
  };
}

async function updateRunState(ownerId: string, taskId: string, patch: Partial<typeof quickCutTasks.$inferInsert>) {
  await getDb().update(quickCutTasks).set({ ...patch, updatedAt: new Date() }).where(and(eq(quickCutTasks.id, taskId), eq(quickCutTasks.ownerId, ownerId)));
}

async function recoverInterruptedQuickCutTask(ownerId: string, taskId: string, task: QuickCutTask) {
  if (!needsQuickCutRunRecovery(task.status, activeControllers.has(taskKey(ownerId, taskId)))) {
    return task;
  }
  const wasMaterialProcessing = task.status === "processing";
  if (wasMaterialProcessing) {
    const processing = processingSettings(task.settings);
    if (processing.mode === "metadata-cleanup") {
      await recoverMetadataCleanupFiles(processing.outputFolder, processing.sources);
    } else {
      await recoverMaterialProcessingFiles(processing.sources);
    }
  }
  await clearQuickCutTransientArtifacts(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    status: "stopped",
    stage: wasMaterialProcessing ? "上次素材处理已中断，原文件已保留" : "上次任务已中断，临时文件已清理",
    rows: [],
    plans: [],
    analysisSummary: null,
    progress: 0,
    total: 0,
    completed: 0,
    failed: 0,
    errorMessage: null,
    completedAt: null,
    events: appendEvent(task.events, event("warning", wasMaterialProcessing
      ? "检测到未正常结束的素材处理，已恢复原文件并清理临时文件"
      : "检测到未正常结束的任务，已保留原素材和外部交付目录，并清理内部临时文件")),
  });
  const recovered = await getOwnedQuickCutTask(ownerId, taskId);
  if (!recovered) throw new Error("恢复中断任务后无法读取任务");
  return recovered;
}

function withPlanningSummary(analysisSummary: Record<string, unknown>, batch: LegacyBatch, requestedCount: number) {
  const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    ...analysisSummary,
    planning: {
      requestedCount: number(batch.requestedCount, requestedCount),
      countMode: batch.countMode === "smart" ? "smart" : "custom",
      roughEstimatedCount: number(batch.roughEstimatedCount, batch.plans.length),
      meaningfulCapacity: number(batch.meaningfulCapacity, batch.plans.length),
      actualCount: number(batch.actualCount, batch.plans.length),
      audioSpineCount: number(batch.audioSpineCount),
      selectedDuration: number(batch.selectedDuration),
      capacityReason: typeof batch.capacityReason === "string" ? batch.capacityReason : "",
      eligibleAnchorCount: number(batch.eligibleAnchorCount),
      usedAnchorCount: number(batch.usedAnchorCount),
      clauseCount: number(batch.clauseCount),
      exactMatchCount: number(batch.exactMatchCount),
      detectedEditingMode: typeof batch.detectedEditingMode === "string" ? batch.detectedEditingMode : "",
      shortages: Array.isArray(batch.shortages) ? batch.shortages : [],
      anchorWarnings: Array.isArray(batch.anchorWarnings) ? batch.anchorWarnings : [],
      constraintDetails: Array.isArray(batch.constraintDetails) ? batch.constraintDetails : [],
    },
  };
}

async function runQuickCutTask(ownerId: string, taskId: string, request: QuickCutStartRequest, controller: AbortController) {
  const folders = taskFolders(ownerId, taskId);
  const runtime = quickCutRuntimePaths();
  const current = await getOwnedQuickCutTask(ownerId, taskId);
  if (!current) throw new Error("任务不存在或无权访问");
  const outputFolder = configuredOutputFolder(current.settings);
  if (!outputFolder) throw new Error("请先选择本次任务的输出文件夹");
  assertExternalQuickCutOutputFolder(folders.root, outputFolder);
  const requiredRuntimeFiles = [
    runtime.ffmpeg,
    runtime.ffprobe,
    runtime.whisper,
    runtime.whisperModel,
    runtime.faceModel,
    runtime.personModel,
    ...(request.editingMode === "fashion-showcase"
      ? [
        runtime.fashionVisionPython,
        runtime.fashionVisionScript,
        path.join(runtime.fashionVisionModelRoot, "READY.json"),
      ]
      : []),
  ];
  if (requiredRuntimeFiles.some((filePath) => !existsSync(filePath))) {
    throw new Error("流光快剪本地运行资源不完整，请运行安装脚本，检查本机运行资源");
  }
  const onnxRuntime = loadQuickCutOnnxRuntime();
  const taskAfterRuntimeCheck = await getOwnedQuickCutTask(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    stage: "正在检查输出位置与磁盘空间",
    progress: 2,
    events: appendEvent(taskAfterRuntimeCheck?.events, event("success", "本地运行环境检查通过，正在检查输出位置与磁盘空间")),
  });
  await ensureWritableFolder({ folder: outputFolder });
  await clearQuickCutTransientArtifacts(ownerId, taskId);
  await Promise.all([
    mkdir(folders.root, { recursive: true }),
  ]);
  const sourceFiles = await listAssets(folders.source, "video");
  const originalBgmFiles = await listAssets(folders.bgm, "audio");
  const originalProductFiles = await listAssets(folders.product, "image");
  const stagedAssetBytes = await totalFileBytes([...sourceFiles, ...originalBgmFiles, ...originalProductFiles]);
  const preflightDuration = request.durationMode === "fixed" ? Number(request.targetDuration) : 60;
  const estimatedOutputBytes = Math.ceil(request.count * preflightDuration * 2_000_000);
  const internalRequiredBytes = stagedAssetBytes + estimatedOutputBytes + 512 * 1024 * 1024;
  const exportRequiredBytes = estimatedOutputBytes + 128 * 1024 * 1024;
  if (sameVolume(folders.root, outputFolder)) {
    await ensureDiskSpace({ folder: folders.root, requiredBytes: internalRequiredBytes + exportRequiredBytes });
  } else {
    await Promise.all([
      ensureDiskSpace({ folder: folders.root, requiredBytes: internalRequiredBytes }),
      ensureDiskSpace({ folder: outputFolder, requiredBytes: exportRequiredBytes }),
    ]);
  }
  const taskAfterDiskCheck = await getOwnedQuickCutTask(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    stage: "正在暂存并扫描视频素材",
    progress: 3,
    events: appendEvent(taskAfterDiskCheck?.events, event("success", "输出位置与磁盘空间检查通过，正在暂存并扫描视频素材")),
  });
  const stagedSourceFolder = path.join(folders.work, "media", "source");
  const stagedSourceFiles = await stageLocalToolFiles({ files: sourceFiles, stagingFolder: stagedSourceFolder, prefix: "source" });
  const sourceNameByStagedName = new Map(stagedSourceFiles.map((stagedPath, index) => [
    path.basename(stagedPath).toLowerCase(),
    path.basename(sourceFiles[index] || stagedPath),
  ]));
  const result = await scanMediaFolder({ folder: stagedSourceFolder, ffprobePath: runtime.ffprobe, ffmpegPath: runtime.ffmpeg });
  if (!result.valid.length) throw new Error("没有找到可用视频，请检查素材文件夹");
  const bgmFiles = await stageLocalToolFiles({
    files: originalBgmFiles,
    stagingFolder: path.join(folders.work, "media", "bgm"),
    prefix: "bgm",
  });
  if (request.settings.audioMode !== "original" && !bgmFiles.length) throw new Error("当前声音模式下请至少导入一首背景音乐");

  const taskAfterPreflight = await getOwnedQuickCutTask(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    stage: "正在本地分析素材",
    scan: summarizeScan(result),
    progress: 4,
    events: appendEvent(taskAfterPreflight?.events, event("success", `素材预检完成：${result.valid.length} 条有效视频，开始本地分析场景、静音、语音、人脸与商品镜头`)),
  });

  let lastAnalysisProgressMessage = "";
  const analysis = await analyzeQuickCutMedia({
    media: result.valid,
    ffmpegPath: runtime.ffmpeg,
    whisperPath: runtime.whisper,
    whisperModelPath: runtime.whisperModel,
    faceModelPath: runtime.faceModel,
    personModelPath: runtime.personModel,
    cachePath: folders.cache,
    workFolder: folders.work,
    signal: controller.signal,
    faceDetectorFactory: (options: Record<string, unknown>) => createQuickCutFaceDetector({ ...options, runtime: onnxRuntime }),
    personDetectorFactory: (options: Record<string, unknown>) => createQuickCutPersonDetector({ ...options, runtime: onnxRuntime }),
    fashionVision: request.editingMode === "fashion-showcase"
      ? {
        pythonPath: runtime.fashionVisionPython,
        scriptPath: runtime.fashionVisionScript,
        modelRoot: runtime.fashionVisionModelRoot,
      }
      : null,
    onProgress: async (progressEvent: { phase?: string; current?: number; total?: number; message?: string }) => {
      const value = progressEvent.total ? Math.min(44, 5 + Math.round((Number(progressEvent.current || 0) / Number(progressEvent.total)) * 39)) : 5;
      const message = String(progressEvent.message || "正在本地分析素材");
      if (message === lastAnalysisProgressMessage) {
        await updateRunState(ownerId, taskId, { stage: message, progress: value });
        return;
      }
      lastAnalysisProgressMessage = message;
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      await updateRunState(ownerId, taskId, {
        stage: message,
        progress: value,
        events: appendEvent(latest?.events, event("info", message)),
      });
    },
  });
  if (controller.signal.aborted) throw new Error("任务已停止");

  const fashionVisionWarning = typeof analysis.summary.fashionVisionWarning === "string"
    ? analysis.summary.fashionVisionWarning
    : null;
  const fashionVisionUsage = analysis.summary.fashionVisionModelUsage;
  const fashionVisionComplete = Boolean(
    fashionVisionUsage
    && typeof fashionVisionUsage === "object"
    && (fashionVisionUsage as Record<string, unknown>).fashionclip
    && typeof (fashionVisionUsage as Record<string, unknown>).fashionclip === "object"
    && ((fashionVisionUsage as Record<string, unknown>).fashionclip as Record<string, unknown>).loaded === true
    && analysis.summary.fashionVisionAvailable === true,
  );
  if (request.editingMode === "fashion-showcase" && !fashionVisionComplete) {
    const reason = fashionVisionWarning || "未取得 FashionCLIP 与姿态模型的完整参与证据";
    const latest = await getOwnedQuickCutTask(ownerId, taskId);
    await updateRunState(ownerId, taskId, {
      analysisSummary: analysis.summary,
      events: appendEvent(latest?.events, event("error", `女装视觉模型未完整参与，已阻止生成：${reason}`)),
    });
    throw new Error(`女装视觉模型未完整参与，已阻止生成：${reason}`);
  }
  if (request.editingMode === "fashion-showcase" && fashionVisionWarning) {
    const latest = await getOwnedQuickCutTask(ownerId, taskId);
    await updateRunState(ownerId, taskId, {
      events: appendEvent(latest?.events, event("warning", fashionVisionWarning)),
    });
  }

  const batch = planQuickCutMixes({
    sources: analysis.sources,
    count: request.count,
    durationMode: request.durationMode,
    targetDuration: request.targetDuration,
    modeOverride: request.editingMode,
    countMode: request.countMode,
    audioMode: request.settings.audioMode,
    seed: request.seed,
  });
  const plans = batch.plans as Array<Record<string, unknown>>;
  const analysisSummary = withPlanningSummary(analysis.summary, batch, request.count);
  if (!batch.plans.length) {
    const latest = await getOwnedQuickCutTask(ownerId, taskId);
    await updateRunState(ownerId, taskId, {
      analysisSummary,
      events: appendEvent(latest?.events, event("warning", String(batch.warnings?.[0] || "当前素材无法生成有效混剪版本"))),
    });
    throw new Error(String(batch.warnings?.[0] || "当前素材无法生成有效混剪版本"));
  }
  const planningStatus = planningEvent(batch, plans);

  const delivery = await createDeliveryFolders(folders.output, "delivery");
  const productImages = await stageLocalToolFiles({
    files: originalProductFiles,
    stagingFolder: path.join(folders.work, "media", "product"),
    prefix: "product",
  });
  const supportsNvidia = request.settings.encoder !== "cpu"
    && await probeNvidiaEncoder({ ffmpegPath: runtime.ffmpeg });
  let selectedEncoder: "cpu" | "nvidia" = request.settings.encoder === "cpu" ? "cpu" : supportsNvidia ? "nvidia" : "cpu";
  let rows: QuickCutRow[] = [];
  const taskRoot = folders.root;
  const taskBeforeRender = await getOwnedQuickCutTask(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    status: "rendering",
    stage: "正在生成混剪成片",
    progress: 45,
    total: plans.length,
    analysisSummary,
    plans,
    events: appendEvent(
      appendEvent(taskBeforeRender?.events, event(planningStatus.level, planningStatus.message)),
      event(
        request.settings.encoder === "nvidia" && !supportsNvidia ? "warning" : "success",
        `分析完成，已规划 ${plans.length} 条有效混剪版本；${request.settings.encoder === "nvidia" && !supportsNvidia ? "显卡实测编码不可用，已切换" : "使用"}${selectedEncoder === "nvidia" ? " NVIDIA 编码" : " CPU 软件编码"}`,
      ),
    ),
  });
  const batchResult = await runQuickCutJobs({
    plans,
    signal: controller.signal,
    onProgress: async (progressEvent: { type: string; index?: number; total?: number; planId?: string; value?: number; error?: string }) => {
      const index = Number(progressEvent.index || 0);
      const total = Number(progressEvent.total || plans.length || 1);
      const renderingProgress = progressEvent.type === "job-progress" ? Number(progressEvent.value || 0) : progressEvent.type === "job-completed" ? 1 : 0;
      const progress = Math.min(99, 45 + Math.round(((index + renderingProgress) / total) * 54));
      const stage = progressEvent.type === "job-failed"
        ? `${progressEvent.planId || "当前成片"} 生成失败`
        : progressEvent.type === "job-completed"
          ? `${progressEvent.planId || "当前成片"} 已生成`
          : `正在生成 ${progressEvent.planId || "混剪成片"}`;
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      const plan = progressEvent.planId ? plans.find((item) => String(item.id || "") === progressEvent.planId) : null;
      const planUnits = plan ? (Array.isArray(plan.units) ? plan.units : Array.isArray(plan.segments) ? plan.segments : []) : [];
      const sourceNames = plan ? planSources(plan) : [];
      const shouldLogStart = progressEvent.type === "job-started" && Boolean(progressEvent.planId);
      await updateRunState(ownerId, taskId, {
        stage,
        progress,
        ...(shouldLogStart ? {
          events: appendEvent(latest?.events, event("info", `${progressEvent.planId} 开始生成：${sourceNames.join("、") || "未记录来源素材"}，${planUnits?.length || 0} 段`)),
        } : {}),
      });
    },
    onRow: async (row: Record<string, unknown>, rawRows: Array<Record<string, unknown>>) => {
      rows = rawRows.map((item) => relativeRow(taskRoot, item, sourceNameByStagedName));
      const fresh = await getOwnedQuickCutTask(ownerId, taskId);
      await updateRunState(ownerId, taskId, {
          rows,
          completed: rows.filter((item) => item.status === "done").length,
          failed: rows.filter((item) => item.status === "failed").length,
          events: appendEvent(fresh?.events, event(row.status === "failed" ? "error" : "success", row.status === "failed"
            ? `${row.planId} 生成失败：${row.error || "未知错误"}`
            : `${row.planId} 已生成：${(Array.isArray(row.sources) ? row.sources : []).map((source) => sourceNameByStagedName.get(path.basename(String(source)).toLowerCase()) || path.basename(String(source))).join("、") || "未记录来源素材"}，${Array.isArray(row.segments) ? row.segments.length : 0} 段${row.output ? `，输出 ${path.basename(String(row.output))}` : ""}`)),
      });
    },
    render: async (plan: Record<string, unknown>, context: { signal: AbortSignal; onProgress: (value: number) => void }) => {
      const number = Number(String(plan.id || "").split("-").at(-1) || 0);
      const suffix = String(number || 1).padStart(3, "0");
      const outputPath = path.join(delivery.videos, `video-${suffix}.mp4`);
      const subtitlePath = path.join(delivery.subtitles, `subtitle-${suffix}.srt`);
      const bgmPath = bgmFiles.length ? bgmFiles[(number - 1) % bgmFiles.length] : "";
      const productImagePath = productImages.length ? productImages[(number - 1) % productImages.length] : "";
      const cues = subtitlesFromPlan(plan);
      const useSubtitles = request.settings.subtitles && cues.length > 0;
      if (useSubtitles) await writeFile(subtitlePath, toSrt(cues), "utf8");
      let lastProgress = 0;
      const execute = async (encoder: "cpu" | "nvidia") => {
        const args = buildRenderArgs({
          plan,
          outputPath,
          bgmPath,
          productImagePath,
          subtitlePath: useSubtitles ? subtitlePath : "",
          settings: { ...request.settings, encoder },
        });
        await runQuickCutProcess(runtime.ffmpeg, args, {
          signal: context.signal,
          onStderr: (chunk: string) => {
            const seconds = timestampToSeconds(chunk);
            if (seconds === null) return;
            const duration = Number(plan.totalDuration || 0) + (productImagePath ? request.settings.productTailDuration : 0);
            const value = duration ? Math.min(1, seconds / duration) : 0;
            if (value - lastProgress >= 0.01) {
              lastProgress = value;
              context.onProgress(value);
            }
          },
        });
      };
      const expectedDuration = Number(plan.totalDuration || 0) + (productImagePath ? request.settings.productTailDuration : 0);
      try {
        try {
          await execute(selectedEncoder);
        } catch (error) {
          if (selectedEncoder !== "nvidia" || context.signal.aborted || !isNvidiaEncodingError(error)) throw error;
          selectedEncoder = "cpu";
          const latest = await getOwnedQuickCutTask(ownerId, taskId);
          await updateRunState(ownerId, taskId, { events: appendEvent(latest?.events, event("warning", `${plan.id} 显卡编码不可用，当前任务已自动切换 CPU 软件编码`)) });
          await execute("cpu");
        }
        await validateRenderedVideo({
          ffmpegPath: runtime.ffmpeg,
          ffprobePath: runtime.ffprobe,
          filePath: outputPath,
          expectedDuration,
          expectAudio: true,
        });
      } catch (error) {
        await Promise.all([
          rm(outputPath, { force: true }),
          rm(subtitlePath, { force: true }),
        ]);
        throw new Error(quickCutUserError(error));
      }
      return {
        output: outputPath,
        cover: "",
        bgm: bgmPath,
        productImage: productImagePath,
        subtitle: useSubtitles ? subtitlePath : "",
        diversityLevel: plan.diversityLevel,
        segments: plan.units,
      };
    },
  });

  const finalTask = await getOwnedQuickCutTask(ownerId, taskId);
  const finalRows = Array.isArray(finalTask?.rows) ? finalTask.rows as QuickCutRow[] : rows;
  const completedCount = finalRows.filter((row) => row.status === "done").length;
  const externalDeliveryName = path.basename(delivery.root).replace(/^delivery/, safeTaskName(request.taskName));
  const exportFolder = completedCount > 0
    ? await commitVideoDelivery({
      sourceFolder: delivery.videos,
      outputFolder,
      deliveryName: externalDeliveryName,
      expectedCount: completedCount,
      fileNamePrefix: safeTaskName(request.taskName),
    })
    : null;
  const deliveryPrefix = safeTaskName(request.taskName);
  let deliveredIndex = 0;
  const exportedRows = finalRows.map((row) => {
    if (row.status !== "done") return row;
    deliveredIndex += 1;
    return {
      ...row,
      output: "",
      outputName: `${deliveryPrefix}-${String(deliveredIndex).padStart(3, "0")}.mp4`,
      cover: "",
      subtitle: "",
    };
  });
  await clearQuickCutTransientArtifacts(ownerId, taskId);
  const taskAfterExport = await getOwnedQuickCutTask(ownerId, taskId);
  const failedCount = exportedRows.filter((item) => item.status === "failed").length;
  const status: QuickCutTaskStatus = batchResult.stopped
    ? "stopped"
    : failedCount > 0 && completedCount === 0
      ? "failed"
      : failedCount > 0
        ? "partial"
        : "completed";
  const nextSettings = { ...(taskAfterExport?.settings || {}) } as Record<string, unknown>;
  if (exportFolder) nextSettings.lastExportFolder = exportFolder;
  else delete nextSettings.lastExportFolder;
  const completionMessage = batchResult.stopped
    ? exportFolder ? `任务已停止，已将完成的成片写入：${exportFolder}` : "任务已停止，没有生成可交付成片"
    : status === "failed"
      ? `流光快剪失败：${failedCount} 条成片均未通过生成或完整性校验`
      : status === "partial"
        ? `流光快剪部分完成：${failedCount} 条成片失败，其余成片已写入：${exportFolder}`
        : `流光快剪任务完成，成片已写入：${exportFolder}`;
  await updateRunState(ownerId, taskId, {
    status,
    stage: batchResult.stopped ? "任务已停止" : status === "failed" ? "任务失败" : failedCount > 0 ? `部分完成：${failedCount} 条成片生成失败` : "成片已生成",
    progress: batchResult.stopped ? Math.min(99, Number(finalTask?.progress || 0)) : 100,
    rows: exportedRows,
    completed: exportedRows.filter((item) => item.status === "done").length,
    failed: failedCount,
    completedAt: new Date(),
    errorMessage: status === "failed" ? completionMessage : null,
    settings: nextSettings,
    events: appendEvent(taskAfterExport?.events, event(status === "completed" ? "success" : status === "failed" ? "error" : "warning", completionMessage)),
  });
}

async function runQuickCutMaterialProcessing(ownerId: string, taskId: string, mode: QuickCutProcessingMode, controller: AbortController) {
  const current = await getOwnedQuickCutTask(ownerId, taskId);
  if (!current) throw new Error("任务不存在或无权访问");
  const startSettings = { ...(current.settings || {}) } as Record<string, unknown>;
  const processing = processingSettings(current.settings);
  const sources = await validateMaterialSources(processing.sources);
  const runtime = quickCutRuntimePaths();
  const requiredRuntimeFiles = mode === "metadata-cleanup" || mode === "quality-optimize"
    ? [
      runtime.ffmpeg,
      runtime.ffprobe,
      runtime.metadataWatermarkPython,
      runtime.metadataWatermarkProcessor,
      runtime.qualityOptimizeProfileProcessor,
      runtime.metadataWatermarkFfmpeg,
      runtime.metadataWatermarkFfprobe,
      runtime.metadataWatermarkKey,
    ]
    : [runtime.ffmpeg, runtime.ffprobe];
  if (requiredRuntimeFiles.some((filePath) => !existsSync(filePath))) {
    throw new Error("流光快剪本地运行资源不完整，请运行安装脚本，检查本机运行资源");
  }
  if (mode === "metadata-cleanup" && !processing.outputFolder) {
    throw new Error("请先选择元数据清理的输出位置");
  }
  if (mode === "metadata-cleanup" && processing.outputFolder) {
    await ensureWritableFolder({ folder: processing.outputFolder });
  } else {
    await Promise.all([...new Set(sources.map((filePath) => path.dirname(filePath)))].map((folder) => ensureWritableFolder({ folder })));
  }

  const taskAfterPreflight = await getOwnedQuickCutTask(ownerId, taskId);
  await updateRunState(ownerId, taskId, {
    stage: mode === "metadata-cleanup" ? "预检完成，正在清理元数据" : "预检完成，正在进行轻微音画优化",
    progress: 2,
    events: appendEvent(taskAfterPreflight?.events, event("success", mode === "metadata-cleanup"
      ? `预检完成，开始清理 ${sources.length} 个本地视频的元数据`
      : `预检完成，开始优化 ${sources.length} 个本地视频的音画质量`)),
  });

  let rows: MaterialProcessingRow[] = [];
  let liveRows: MaterialProcessingRow[] = [];
  let lastProgressLog = "";
  rows = await processMaterialFiles({
    mode,
    sourceFiles: sources,
    outputFolder: processing.outputFolder,
    ffmpegPath: runtime.ffmpeg,
    ffprobePath: runtime.ffprobe,
    metadataCleanupRuntime: {
      pythonPath: runtime.metadataWatermarkPython,
      processorPath: runtime.metadataWatermarkProcessor,
      qualityProfilePath: runtime.qualityOptimizeProfileProcessor,
      ffmpegPath: runtime.metadataWatermarkFfmpeg,
      ffprobePath: runtime.metadataWatermarkFfprobe,
      keyPath: runtime.metadataWatermarkKey,
    },
    signal: controller.signal,
    onProgress: async (progressEvent) => {
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      const shouldAppendLog = Boolean(progressEvent.logMessage) && progressEvent.logMessage !== lastProgressLog;
      if (shouldAppendLog) lastProgressLog = progressEvent.logMessage || "";
      await updateRunState(ownerId, taskId, {
        stage: `${progressEvent.stage} ${progressEvent.fileIndex}/${progressEvent.total}：${progressEvent.fileName}`,
        progress: progressEvent.progress,
        ...(shouldAppendLog ? {
          events: appendEvent(latest?.events, event("info", progressEvent.logMessage || "正在处理本地视频")),
        } : {}),
      });
    },
    onRow: async (row) => {
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      liveRows = [...liveRows, row];
      const nextRows = liveRows;
      await updateRunState(ownerId, taskId, {
        rows: nextRows,
        completed: nextRows.filter((item) => item.status === "done").length,
        failed: nextRows.filter((item) => item.status === "failed").length,
        events: appendEvent(latest?.events, event(row.status === "done" ? "success" : "error", row.status === "done"
          ? `${mode === "metadata-cleanup" ? "元数据清理" : "轻微音画优化"}完成：${row.planId}`
          : `${mode === "metadata-cleanup" ? "元数据清理" : "轻微音画优化"}失败：${row.planId}，${row.error}`)),
      });
    },
    onEncoderFallback: async (fileName) => {
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      await updateRunState(ownerId, taskId, {
        events: appendEvent(latest?.events, event("warning", `${fileName} 的显卡编码不可用，已切换 CPU 继续优化`)),
      });
    },
  });

  const completed = rows.filter((item) => item.status === "done").length;
  const failed = rows.filter((item) => item.status === "failed").length;
  const status: QuickCutTaskStatus = failed === 0 ? "completed" : completed > 0 ? "partial" : "failed";
  const latest = await getOwnedQuickCutTask(ownerId, taskId);
  const finalSettings = { ...(latest?.settings || startSettings) } as Record<string, unknown>;
  if (mode === "metadata-cleanup" && processing.outputFolder) finalSettings.lastProcessingOutputFolder = processing.outputFolder;
  else delete finalSettings.lastProcessingOutputFolder;
  const completionMessage = status === "completed"
    ? mode === "metadata-cleanup"
      ? `元数据清理完成，已生成 ${completed} 个新文件`
      : `轻微音画优化完成，已安全覆盖 ${completed} 个原文件`
    : status === "partial"
      ? `处理部分完成：${completed} 个成功，${failed} 个失败`
      : `处理失败：${failed} 个视频均未完成`;
  await updateRunState(ownerId, taskId, {
    status,
    stage: status === "completed" ? "本次处理已完成" : status === "partial" ? "部分处理完成" : "本次处理失败",
    progress: 100,
    rows,
    total: rows.length,
    completed,
    failed,
    completedAt: new Date(),
    errorMessage: status === "failed" ? completionMessage : null,
    settings: finalSettings,
    events: appendEvent(latest?.events, event(status === "completed" ? "success" : status === "failed" ? "error" : "warning", completionMessage)),
  });
}

export async function startQuickCutMaterialProcessing(ownerId: string, taskId: string, mode: QuickCutProcessingMode) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  if (activeControllers.has(taskKey(ownerId, taskId))) throw new Error("当前任务正在运行");
  if (mode !== "metadata-cleanup" && mode !== "quality-optimize") throw new Error("处理方式无效");
  const processing = processingSettings(task.settings);
  await validateMaterialSources(processing.sources);
  if (mode === "metadata-cleanup" && !processing.outputFolder) throw new Error("请先选择元数据清理的输出位置");
  const archivedRun = archiveQuickCutRun(task);
  const startSettings = settingsForNextRun({
    ...task.settings,
    processingMode: mode,
    lastProcessingOutputFolder: null,
  }, archivedRun);
  const key = taskKey(ownerId, taskId);
  const controller = new AbortController();
  activeControllers.set(key, controller);
  try {
    await updateRunState(ownerId, taskId, {
      status: "processing",
      stage: mode === "metadata-cleanup" ? "正在检查清理环境与本地视频" : "正在检查优化环境与本地视频",
      progress: 1,
      total: processing.sources.length,
      completed: 0,
      failed: 0,
      rows: [],
      plans: [],
      analysisSummary: null,
      completedAt: null,
      errorMessage: null,
      settings: startSettings,
      events: [event("info", mode === "metadata-cleanup"
        ? `任务已接收，正在检查 ${processing.sources.length} 个本地视频与清理输出位置`
        : `任务已接收，正在检查 ${processing.sources.length} 个本地视频与安全覆盖环境`)],
    });
  } catch (error) {
    activeControllers.delete(key);
    throw error;
  }
  const startedTask = await getOwnedQuickCutTask(ownerId, taskId);
  if (!startedTask) {
    activeControllers.delete(key);
    throw new Error("任务启动后无法读取运行状态");
  }
  void runQuickCutMaterialProcessing(ownerId, taskId, mode, controller)
    .catch(async (error) => {
      await recoverMaterialProcessingFiles(processing.sources).catch(() => undefined);
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      const message = controller.signal.aborted ? "任务已停止，原文件已保留" : quickCutUserError(error);
      await updateRunState(ownerId, taskId, {
        status: controller.signal.aborted ? "stopped" : "failed",
        stage: controller.signal.aborted ? "任务已停止" : "本次处理失败",
        errorMessage: controller.signal.aborted ? null : message,
        events: appendEvent(latest?.events, event(controller.signal.aborted ? "warning" : "error", message)),
      }).catch(() => undefined);
    })
    .finally(() => activeControllers.delete(key));
  return startedTask;
}

export async function startQuickCutTask(ownerId: string, taskId: string, request: QuickCutStartRequest) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  const key = taskKey(ownerId, taskId);
  if (activeControllers.has(key)) throw new Error("当前任务正在运行");
  const prepared = validateStartRequest(request);
  if (!configuredOutputFolder(task.settings)) throw new Error("请先选择本次任务的输出文件夹");
  if (prepared.settings.audioMode !== "original") {
    const bgmFiles = await listAssets(taskFolders(ownerId, taskId).bgm, "audio");
    if (!bgmFiles.length) throw new Error("当前声音模式下请至少导入一首背景音乐");
  }
  const archivedRun = archiveQuickCutRun(task);
  const startSettings = {
    ...settingsForNextRun(task.settings, archivedRun),
    quickCutRunConfig: {
      taskName: prepared.taskName,
      count: prepared.count,
      countMode: prepared.countMode,
      durationMode: prepared.durationMode,
      targetDuration: prepared.targetDuration,
      editingMode: prepared.editingMode,
      seed: prepared.seed,
      settings: prepared.settings,
      startedAt: new Date().toISOString(),
    },
  };
  const controller = new AbortController();
  activeControllers.set(key, controller);
  try {
    await updateRunState(ownerId, taskId, {
      status: "analyzing",
      stage: "正在检查运行环境与素材",
      progress: 1,
      total: 0,
      completed: 0,
      failed: 0,
      rows: [],
      plans: [],
      analysisSummary: null,
      settings: startSettings,
      completedAt: null,
      errorMessage: null,
      events: [event("info", archivedRun
        ? "已归档上一批成片；任务已接收，正在检查运行环境、磁盘空间与素材"
        : "任务已接收，正在检查运行环境、磁盘空间与素材"), event("info", `本次参数：${prepared.editingMode === "fashion-showcase" ? "女装穿搭展示" : prepared.editingMode}；${prepared.editingMode === "fashion-showcase" && prepared.countMode === "smart" ? "智能数量，分析后按真实容量确定" : `生成 ${prepared.count} 条`}；${prepared.durationMode === "smart" ? "智能时长" : `固定 ${prepared.targetDuration} 秒`}；声音 ${prepared.settings.audioMode === "original" ? "仅保留原声" : prepared.settings.audioMode === "mix" ? "原声加背景音乐" : "仅背景音乐"}；编码 ${prepared.settings.encoder}`)],
    });
  } catch (error) {
    activeControllers.delete(key);
    throw error;
  }
  const startedTask = await getOwnedQuickCutTask(ownerId, taskId);
  if (!startedTask) {
    activeControllers.delete(key);
    throw new Error("任务启动后无法读取运行状态");
  }
  void runQuickCutTask(ownerId, taskId, prepared, controller)
    .catch(async (error) => {
      await clearQuickCutTransientArtifacts(ownerId, taskId).catch(() => undefined);
      const latest = await getOwnedQuickCutTask(ownerId, taskId);
      const message = controller.signal.aborted ? "任务已停止" : quickCutUserError(error);
      await updateRunState(ownerId, taskId, {
        status: controller.signal.aborted ? "stopped" : "failed",
        stage: controller.signal.aborted ? "任务已停止" : "任务失败",
        errorMessage: controller.signal.aborted ? null : message,
        events: appendEvent(latest?.events, event(controller.signal.aborted ? "warning" : "error", message)),
      }).catch(() => undefined);
    })
    .finally(() => activeControllers.delete(key));
  return startedTask;
}

export async function stopQuickCutTask(ownerId: string, taskId: string) {
  let task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  task = await recoverInterruptedQuickCutTask(ownerId, taskId, task);
  const controller = activeControllers.get(taskKey(ownerId, taskId));
  if (!controller) return false;
  controller.abort();
  await updateRunState(ownerId, taskId, { stage: "正在停止任务" });
  return true;
}

export async function openQuickCutOutput(ownerId: string, taskId: string) {
  const task = await getOwnedQuickCutTask(ownerId, taskId);
  if (!task) throw new Error("任务不存在或无权访问");
  const folders = taskFolders(ownerId, taskId);
  const target = processingSettings(task.settings).lastOutputFolder
    || configuredOutputFolder(task.settings, "lastExportFolder");
  if (!target) throw new Error("本批没有可打开的结果目录");
  assertExternalQuickCutOutputFolder(folders.root, target);
  if (!await existingDirectory(target)) throw new Error("本批结果目录已不存在，请重新生成");
  await new Promise<void>((resolve, reject) => {
    const explorer = spawn("explorer.exe", [target], {
      detached: true,
      stdio: "ignore",
      // This process is the visible result window. Hiding it can make the API
      // report success while Windows never presents an Explorer window.
      windowsHide: false,
    });
    explorer.once("spawn", () => {
      explorer.unref();
      resolve();
    });
    explorer.once("error", () => reject(new Error("Windows 资源管理器启动失败")));
  });
}

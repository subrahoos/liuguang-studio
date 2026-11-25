"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Check,
  ChevronDown,
  FileVideo,
  FolderOpen,
  ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tags,
  Trash2,
} from "lucide-react";

type QuickCutStatus = "draft" | "scanning" | "ready" | "analyzing" | "rendering" | "processing" | "completed" | "partial" | "failed" | "stopped";
type AssetKind = "source" | "product" | "bgm";
type QuickCutMode = "quick-cut" | "metadata-cleanup" | "quality-optimize";

type QuickCutOutputRow = {
  planId: string;
  duration: number;
  status: "done" | "failed";
  error: string;
  outputName?: string;
  sources?: string[];
  sourceNames?: string[];
  segments?: Array<Record<string, unknown>>;
  diversityLevel?: string;
};

type QuickCutTask = {
  id: string;
  name: string;
  status: QuickCutStatus;
  stage: string;
  scan?: {
    validCount: number;
    invalidCount: number;
    totalDuration: number;
    sources?: Array<{ id: string; duration: number; width: number; height: number; fps: number; hasAudio: boolean }>;
  } | null;
  analysisSummary?: {
    detectedType?: string;
    speechCoverage?: number;
    segmentCount?: number;
    presenterSourceCount?: number;
    fashionVisionAvailable?: boolean;
    fashionVisionWarning?: string | null;
    fashionCandidateCount?: number;
    fashionVisionModelUsage?: {
      device?: string;
      fashionclip?: { loaded?: boolean; rolePromptCount?: number };
      mmpose?: { loaded?: boolean; poseCandidateCount?: number; fullBodyCount?: number; motionCandidateCount?: number };
      pose?: { loaded?: boolean; backend?: string; poseCandidateCount?: number; fullBodyCount?: number; motionCandidateCount?: number };
      roleCounts?: Record<string, number>;
    } | null;
    lockedShotCount?: number;
    replaceableShotCount?: number;
    tagCounts?: Record<string, number>;
    planning?: {
      requestedCount?: number;
      meaningfulCapacity?: number;
      eligibleAnchorCount?: number;
      usedAnchorCount?: number;
      clauseCount?: number;
      exactMatchCount?: number;
      detectedEditingMode?: string;
      shortages?: Array<{ label?: string; missing?: number }>;
      anchorWarnings?: string[];
      countMode?: "smart" | "custom";
      roughEstimatedCount?: number;
      actualCount?: number;
      audioSpineCount?: number;
      selectedDuration?: number;
      capacityReason?: string;
      constraintDetails?: string[];
    };
  } | null;
  rows: QuickCutOutputRow[];
  runHistory?: Array<{
    id: string;
    taskName: string;
    status: QuickCutStatus;
    archivedAt: string;
    completed: number;
    failed: number;
    rows: QuickCutOutputRow[];
  }>;
  events: Array<{ at: string; level: "info" | "success" | "warning" | "error"; message: string }>;
  progress: number;
  total: number;
  completed: number;
  failed: number;
  errorMessage?: string | null;
  outputReady: boolean;
  hasOutput: boolean;
  outputFolder?: string | null;
  lastExportFolder?: string | null;
  assetCounts?: Partial<Record<AssetKind, number>>;
  processing?: {
    mode: Exclude<QuickCutMode, "quick-cut"> | null;
    sourceCount: number;
    sourceNames: string[];
    outputFolder?: string | null;
    lastOutputFolder?: string | null;
  };
  updatedAt?: string;
};

type Settings = {
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

type QueuedImportFile = {
  file: File;
  relativePath: string;
};

const importExtensions: Record<AssetKind, Set<string>> = {
  source: new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]),
  product: new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]),
  bgm: new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]),
};

const defaultSettings: Settings = {
  fit: "blur",
  audioMode: "original",
  bgmVolume: 0.2,
  fps: 30,
  quality: "balanced",
  encoder: "auto",
  transition: "cut",
  productTailDuration: 1.5,
  subtitles: false,
};

const runningStatuses = new Set<QuickCutStatus>(["scanning", "analyzing", "rendering", "processing"]);

const modeDefinitions: Array<{ id: QuickCutMode; label: string; description: string; icon: LucideIcon }> = [
  { id: "quick-cut", label: "快剪生成", description: "本机混剪与成片交付", icon: Scissors },
  { id: "metadata-cleanup", label: "清理元数据", description: "生成新文件，不覆盖原件", icon: Tags },
  { id: "quality-optimize", label: "轻微音画优化", description: "校验后覆盖原文件", icon: Sparkles },
];

function statusLabel(status: QuickCutStatus) {
  return {
    draft: "待导入",
    scanning: "扫描中",
    ready: "待开始",
    analyzing: "分析中",
    rendering: "生成中",
    processing: "处理中",
    completed: "已完成",
    partial: "部分完成",
    failed: "已失败",
    stopped: "已停止",
  }[status];
}

function statusClass(status: QuickCutStatus) {
  if (status === "completed") return "luma-status-pill luma-quick-cut-status is-complete";
  if (status === "partial") return "luma-status-pill luma-quick-cut-status is-warning";
  if (status === "failed") return "luma-status-pill luma-quick-cut-status is-error";
  if (runningStatuses.has(status)) return "luma-status-pill luma-quick-cut-status is-running";
  return "luma-status-pill luma-quick-cut-status";
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  return safe >= 60 ? `${Math.floor(safe / 60)}分${String(safe % 60).padStart(2, "0")}秒` : `${safe}秒`;
}

function requestError(body: unknown, fallback: string) {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
}

function fileExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function importKindLabel(kind: AssetKind) {
  return kind === "source" ? "视频素材" : kind === "product" ? "商品主图" : "背景音乐";
}

function containsReplacementCharacter(value: string | null | undefined) {
  return Boolean(value?.includes("\uFFFD"));
}

function displayOutputFolder(value: string | null | undefined) {
  if (!value) return "请先选择本次任务的输出文件夹";
  return containsReplacementCharacter(value) ? "历史输出路径编码异常，请重新选择输出位置" : value;
}

function displayEventMessage(message: string) {
  return containsReplacementCharacter(message)
    ? "历史日志包含无法识别的路径字符，请重新选择输出位置后再生成。"
    : message;
}

function displayFileName(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || value;
}

function formatSegmentSeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)}秒` : "未知时间";
}

function describeSegment(segment: Record<string, unknown>, index: number) {
  const source = segment.videoPath || segment.path || segment.sourcePath || "未记录素材";
  const start = Number(segment.videoStart ?? segment.start ?? segment.startTime ?? 0);
  const duration = Number(segment.duration ?? segment.outputDuration ?? 0);
  const end = Number.isFinite(start) && Number.isFinite(duration) ? start + duration : null;
  return `${index + 1}. ${displayFileName(String(source))} · ${formatSegmentSeconds(start)}-${end === null ? "未知时间" : formatSegmentSeconds(end)}`;
}

function QuickCutResultRow({ row }: { row: QuickCutOutputRow }) {
  const sources = row.sourceNames?.length ? row.sourceNames : (row.sources || []).map(displayFileName);
  const segments = Array.isArray(row.segments) ? row.segments : [];
  return <article className={`luma-quick-cut-result rounded-md px-3 py-2.5 ${row.status === "failed" ? "is-error" : ""}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className={`truncate text-sm font-semibold ${row.status === "failed" ? "text-rose-100" : "text-slate-100"}`}>{row.planId}</p>
        <p className="mt-1 truncate text-xs text-slate-400">{row.status === "failed" ? "生成失败" : `${formatDuration(row.duration)} · ${segments.length} 段 · ${sources.length ? sources.join("、") : "未记录来源素材"}`}</p>
      </div>
      <span className={`shrink-0 text-xs ${row.status === "failed" ? "text-rose-100" : "text-cyan-100"}`}>{row.status === "failed" ? "失败" : "已完成"}</span>
    </div>
    {row.outputName && row.status === "done" && <p className="mt-2 truncate text-xs text-emerald-200/80" title={row.outputName}>输出：{row.outputName}</p>}
    {row.status === "failed" && <p className="mt-1 text-xs text-rose-100/80">{row.error || "未知错误"}</p>}
    {segments.length > 0 && <details className="mt-2 border-t border-cyan-100/10 pt-2">
      <summary className="cursor-pointer text-xs font-semibold text-slate-300">查看素材与片段</summary>
      <div className="mt-2 space-y-1 text-xs leading-5 text-slate-400">{segments.map((segment, index) => <p key={`${row.planId}-segment-${index}`}>{describeSegment(segment, index)}</p>)}</div>
    </details>}
  </article>;
}

function PlanningSummary({ planning }: { planning: NonNullable<NonNullable<QuickCutTask["analysisSummary"]>["planning"]> | null }) {
  if (!planning) return null;
  const requested = planning.requestedCount ?? 0;
  const exact = planning.exactMatchCount ?? 0;
  const estimate = planning.roughEstimatedCount ?? 0;
  const capacity = planning.meaningfulCapacity ?? 0;
  const actual = planning.actualCount ?? capacity;
  const smartCount = planning.countMode === "smart";
  const shortages = (planning.shortages || []).map((item) => `${item.label || "匹配镜头"}${item.missing ? ` 缺 ${item.missing}` : ""}`);
  return <div className="luma-quick-cut-fact mt-4 rounded-md px-3 py-3">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><InfoCell label={smartCount ? "智能数量" : "素材预计"} value={`预计 ${estimate} 条`} /><InfoCell label="分析确认" value={`高质量 ${capacity} 条`} /><InfoCell label={smartCount ? "实际计划" : "请求成片"} value={`${smartCount ? actual : requested} 条`} /><InfoCell label={smartCount ? "使用原声主线" : "准确匹配"} value={smartCount ? `${planning.usedAnchorCount ?? 0}/${planning.eligibleAnchorCount ?? 0}` : `${exact}/${requested}`} /></div>
    {smartCount && Number(planning.selectedDuration) > 0 && <p className="mt-3 text-xs font-semibold text-cyan-100">智能时长：约 {Math.round(Number(planning.selectedDuration))} 秒/条，优先保证单条不重复。</p>}
    {(planning.capacityReason || shortages.length > 0 || (planning.anchorWarnings || []).length > 0) && <p className="mt-3 text-xs leading-5 text-amber-100">{planning.capacityReason ? `数量说明：${planning.capacityReason}` : shortages.length ? `素材缺口：${shortages.join("、")}` : `锚点提示：${(planning.anchorWarnings || []).join("、")}`}</p>}
  </div>;
}

function FashionSmartCount({
  totalDuration,
  durationMode,
  targetDuration,
  planning,
}: {
  totalDuration: number;
  durationMode: "smart" | "fixed";
  targetDuration: number;
  planning: NonNullable<NonNullable<QuickCutTask["analysisSummary"]>["planning"]> | null;
}) {
  const hasScannedSources = Number.isFinite(totalDuration) && totalDuration > 0;
  const fallbackEstimate = hasScannedSources
    ? Math.max(1, Math.floor(totalDuration / (durationMode === "fixed" ? targetDuration : 30)))
    : null;
  const estimate = planning?.roughEstimatedCount ?? fallbackEstimate;
  const capacity = planning?.meaningfulCapacity;
  return <div className="mt-3 rounded-md border border-cyan-100/10 bg-cyan-100/[0.035] px-3 py-2.5">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><p className="text-xs font-semibold text-slate-200">智能数量</p><span className="text-sm font-black text-cyan-100">{estimate === null ? "等待素材" : `预计 ${estimate} 条`}</span></div>
    {capacity === undefined
      ? <p className="mt-1.5 text-xs leading-5 text-slate-400">{hasScannedSources ? "待本地分析原声主线、镜头质量和重复率后确认。" : "导入并扫描视频素材后显示预计数量。"}</p>
      : <><p className="mt-1.5 text-xs font-semibold text-emerald-100">分析确认：可高质量生成 {capacity} 条</p>{planning?.capacityReason && <p className="mt-1 text-xs leading-5 text-slate-400">{planning.capacityReason}</p>}</>}
  </div>;
}

function FashionVisionSummary({ analysis }: { analysis: QuickCutTask["analysisSummary"] | null }) {
  const usage = analysis?.fashionVisionModelUsage;
  if (!usage) return null;
  const roles = Object.entries(usage.roleCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([role, count]) => `${role} ${count}`)
    .join(" · ");
  const fashionclip = usage.fashionclip?.loaded ? `已参与（${usage.fashionclip.rolePromptCount || 0} 类提示）` : "未参与";
  const pose = usage.pose || usage.mmpose;
  const poseName = usage.pose?.backend || "MMPose";
  const mmpose = pose?.loaded
    ? `已参与 ${pose.poseCandidateCount || 0} 个镜头`
    : "未参与";
  return <div className="luma-quick-cut-fact mt-4 rounded-md px-3 py-3"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><InfoCell label="FashionCLIP" value={fashionclip} /><InfoCell label={poseName} value={mmpose} /><InfoCell label="人物全身" value={`${pose?.fullBodyCount || 0} 个`} /><InfoCell label="动态镜头" value={`${pose?.motionCandidateCount || 0} 个`} /></div><p className="mt-3 text-xs text-cyan-100">运行设备：{usage.device || "未知"}{roles ? ` · 角色分布：${roles}` : ""}</p></div>;
}

function fashionVisionLabel(analysis: QuickCutTask["analysisSummary"] | null) {
  const usage = analysis?.fashionVisionModelUsage;
  if (!usage) return analysis?.fashionVisionAvailable ? "历史记录未保存完整模型证据" : "未完成模型分析";
  const complete = analysis?.fashionVisionAvailable === true && usage.fashionclip?.loaded === true && (usage.pose || usage.mmpose)?.loaded === true;
  return complete ? `FashionCLIP 与 ${usage.pose?.backend || "MMPose"} 均已参与` : "模型未完整参与，任务已阻止";
}

export function LumaQuickCutPage({ initialTaskId = null }: { initialTaskId?: string | null } = {}) {
  const [task, setTask] = useState<QuickCutTask | null>(null);
  const [taskName, setTaskName] = useState("流光快剪");
  const [activeMode, setActiveMode] = useState<QuickCutMode>("quick-cut");
  const [count, setCount] = useState(20);
  const [countInput, setCountInput] = useState("20");
  const [countMode, setCountMode] = useState<"smart" | "custom">("smart");
  const [durationMode, setDurationMode] = useState<"smart" | "fixed">("smart");
  const [targetDuration, setTargetDuration] = useState<15 | 30 | 45 | 60>(30);
  const [editingMode, setEditingMode] = useState<"auto" | "presenter" | "voice-over" | "product-footage" | "fashion-showcase">("auto");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isOpeningOutput, setIsOpeningOutput] = useState(false);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const productInputRef = useRef<HTMLInputElement | null>(null);
  const bgmInputRef = useRef<HTMLInputElement | null>(null);

  function applyCountValue(value: number) {
    const next = Math.min(50, Math.max(1, Math.trunc(value) || 1));
    setCount(next);
    setCountInput(String(next));
  }

  const isServerRunning = Boolean(task && runningStatuses.has(task.status));
  const isRunning = isServerRunning || isStarting;
  const isTaskActive = isRunning;
  const sourceCount = task?.scan?.validCount || 0;
  const sourceAssetCount = task?.assetCounts?.source ?? (task?.scan?.validCount || 0) + (task?.scan?.invalidCount || 0);
  const productAssetCount = task?.assetCounts?.product || 0;
  const bgmAssetCount = task?.assetCounts?.bgm || 0;
  const processing = task?.processing;
  const processingSourceCount = processing?.sourceCount || 0;
  const processingOutputFolder = processing?.outputFolder || null;
  const hasProcessingOutputFolder = Boolean(processingOutputFolder) && !containsReplacementCharacter(processingOutputFolder);
  const analysis = task?.analysisSummary || null;
  const tagSummary = useMemo(() => Object.entries(analysis?.tagCounts || {}).sort((left, right) => right[1] - left[1]).slice(0, 4).map(([tag, value]) => `${tag} ${value}`).join(" · "), [analysis]);
  const planning = analysis?.planning || null;
  const shortageSummary = useMemo(() => (planning?.shortages || []).slice(0, 2).map((item) => `${item.label || "匹配镜头"}${item.missing ? ` 缺 ${item.missing}` : ""}`).join(" · "), [planning]);

  const applyTask = useCallback((next: QuickCutTask) => {
    setTask(next);
  }, []);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/quick-cut/tasks", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(requestError(body, "读取流光快剪任务失败"));
      const nextTasks = Array.isArray(body.tasks) ? body.tasks as QuickCutTask[] : [];
      setTask((current) => {
        const requested = initialTaskId ? nextTasks.find((item) => item.id === initialTaskId) : null;
        if (requested) return requested;
        return current ? nextTasks.find((item) => item.id === current.id) || current : nextTasks[0] || null;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取流光快剪任务失败");
    } finally {
      setIsLoading(false);
    }
  }, [initialTaskId]);

  const refreshTask = useCallback(async (taskId: string) => {
    const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(requestError(body, "刷新任务状态失败"));
    if (body.task) applyTask(body.task as QuickCutTask);
  }, [applyTask]);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  useEffect(() => {
    if (task?.status === "processing" && task.processing?.mode) setActiveMode(task.processing.mode);
  }, [task?.processing?.mode, task?.status]);

  useEffect(() => {
    if (!task || !runningStatuses.has(task.status)) return;
    const timer = window.setInterval(() => { void refreshTask(task.id).catch((error) => setNotice(error instanceof Error ? error.message : "刷新任务状态失败")); }, 1200);
    return () => window.clearInterval(timer);
  }, [task, refreshTask]);

  async function createTask() {
    const res = await fetch("/api/quick-cut/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: taskName.trim() || "流光快剪" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.task) throw new Error(requestError(body, "创建流光快剪任务失败"));
    const created = body.task as QuickCutTask;
    applyTask(created);
    return created;
  }

  async function ensureTask() {
    return task || createTask();
  }

  async function uploadFiles(kind: AssetKind, files: QueuedImportFile[]) {
    if (!files.length || isTaskActive) return;
    setIsImporting(true);
    setNotice("");
    try {
      const activeTask = await ensureTask();
      const renamedFiles: string[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const entry = files[index];
        const search = new URLSearchParams({ kind, relativePath: entry.relativePath });
        const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(activeTask.id)}/assets?${search}`, {
          method: "POST",
          headers: { "Content-Type": entry.file.type || "application/octet-stream", "X-Luma-Quick-Cut-Size": String(entry.file.size) },
          body: entry.file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(requestError(body, `导入 ${entry.file.name} 失败`));
        if (body.asset?.renamed && typeof body.asset.relativePath === "string") renamedFiles.push(body.asset.relativePath);
        setNotice(`正在导入 ${index + 1}/${files.length}：${entry.file.name}`);
      }
      if (kind === "source") {
        const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(activeTask.id)}/scan`, { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(requestError(body, "扫描素材失败"));
        if (body.task) applyTask(body.task as QuickCutTask);
        setNotice(`素材扫描完成：${body.scan?.validCount || 0} 条可用视频${renamedFiles.length ? `；${renamedFiles.length} 个同名文件已自动重命名` : ""}`);
      } else {
          await refreshTask(activeTask.id);
        setNotice(`${kind === "product" ? "商品主图" : "背景音乐"}已导入${renamedFiles.length ? `；${renamedFiles.length} 个同名文件已自动重命名` : ""}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入素材失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function handleFileInput(kind: AssetKind, event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    event.target.value = "";
    importSelectedFiles(kind, files);
  }

  function importSelectedFiles(kind: AssetKind, files: QueuedImportFile[]) {
    const accepted = files.filter((entry) => importExtensions[kind].has(fileExtension(entry.file.name)));
    if (!accepted.length) {
      setNotice(`所选文件中没有可导入的${importKindLabel(kind)}`);
      return;
    }
    void uploadFiles(kind, accepted);
  }

  function selectFiles(kind: AssetKind) {
    if (isTaskActive || isImporting) return;
    if (kind === "source" && sourceAssetCount > 0) {
      setNotice("当前任务已有视频素材，请先清除素材后再重新选择文件");
      return;
    }
    const input = kind === "source" ? sourceInputRef : kind === "product" ? productInputRef : bgmInputRef;
    input.current?.click();
  }

  async function clearSources() {
    if (!task || !sourceAssetCount || isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/sources`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.task) throw new Error(requestError(body, "清除视频素材失败"));
      applyTask(body.task as QuickCutTask);
      setNotice("已清除当前视频素材；已有成片已收入历史记录，可重新选择文件");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "清除视频素材失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function clearOptionalAssets(kind: Exclude<AssetKind, "source">) {
    if (!task || isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/assets?kind=${kind}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.task) throw new Error(requestError(body, "清除素材失败"));
      applyTask(body.task as QuickCutTask);
      setNotice(`已清除当前任务的${kind === "product" ? "商品主图" : "背景音乐"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "清除素材失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function selectProcessingSources() {
    if (isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const activeTask = await ensureTask();
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(activeTask.id)}/processing/sources`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(requestError(body, "选择本地视频失败"));
      if (body.task) {
        applyTask(body.task as QuickCutTask);
        setNotice((body.task as QuickCutTask).processing?.sourceCount ? `已选择 ${(body.task as QuickCutTask).processing?.sourceCount} 个本地视频` : "已取消选择本地视频");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "选择本地视频失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function clearProcessingSources() {
    if (!task || isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/processing/sources`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.task) throw new Error(requestError(body, "清除本地视频失败"));
      applyTask(body.task as QuickCutTask);
      setNotice("已清除本次素材处理的视频选择");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "清除本地视频失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function selectProcessingOutputFolder() {
    if (isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const activeTask = await ensureTask();
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(activeTask.id)}/processing/output-folder`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(requestError(body, "选择输出位置失败"));
      if (body.task) {
        const selected = body.task as QuickCutTask;
        applyTask(selected);
        setNotice(selected.processing?.outputFolder ? `元数据清理将输出到：${selected.processing.outputFolder}` : "已取消选择输出位置");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "选择输出位置失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function selectOutputFolder() {
    if (isTaskActive || isImporting) return;
    setIsImporting(true);
    setNotice("");
    try {
      const activeTask = await ensureTask();
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(activeTask.id)}/output-folder`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(requestError(body, "选择输出位置失败"));
      if (body.task) {
        const selected = body.task as QuickCutTask;
        applyTask(selected);
        setNotice(selected.outputFolder ? `本次任务将输出到：${selected.outputFolder}` : "未选择输出位置");
      } else if (body.cancelled) {
        setNotice("已取消选择输出位置");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "选择输出位置失败");
    } finally {
      setIsImporting(false);
    }
  }

  async function startTask() {
    const effectiveCount = editingMode === "fashion-showcase" && countMode === "smart"
      ? Math.max(1, Math.min(50, Math.floor((task?.scan?.totalDuration || 30) / (durationMode === "fixed" ? targetDuration : 30))))
      : count;
    if (!task || !sourceCount || (!isValidCount && !(editingMode === "fashion-showcase" && countMode === "smart")) || isImporting || isTaskActive) return;
    setIsStarting(true);
    setNotice("正在提交混剪任务...");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskName: taskName.trim() || task.name,
          count: effectiveCount,
          countMode: editingMode === "fashion-showcase" && countMode === "smart" ? "smart" : "custom",
          durationMode,
          targetDuration: durationMode === "smart" ? null : targetDuration,
          editingMode,
          settings,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.task) throw new Error(requestError(body, "启动流光快剪失败"));
      applyTask(body.task as QuickCutTask);
      setNotice("任务已启动，正在本机分析素材");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "启动流光快剪失败");
    } finally {
      setIsStarting(false);
    }
  }

  async function startMaterialProcessing() {
    if (!task || activeMode === "quick-cut" || isImporting || isTaskActive) return;
    const mode = activeMode;
    setIsStarting(true);
    setNotice(mode === "metadata-cleanup" ? "正在提交元数据清理任务..." : "正在提交音画优化任务...");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/processing/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.task) throw new Error(requestError(body, "启动素材处理失败"));
      applyTask(body.task as QuickCutTask);
      setNotice(mode === "metadata-cleanup" ? "元数据清理已启动，正在生成新文件" : "轻微音画优化已启动，校验后才会覆盖原文件");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "启动素材处理失败");
    } finally {
      setIsStarting(false);
    }
  }

  async function stopTask() {
    if (!task || !isServerRunning) return;
    const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/stop`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNotice(requestError(body, "停止流光快剪失败"));
      return;
    }
    setNotice(body.stopping ? "正在停止任务，已完成的成片会被保留" : "当前没有运行中的任务");
    await refreshTask(task.id).catch(() => undefined);
  }

  async function openOutput() {
    if (!task || isOpeningOutput) return;
    setIsOpeningOutput(true);
    setNotice("正在打开本批结果目录...");
    try {
      const res = await fetch(`/api/quick-cut/tasks/${encodeURIComponent(task.id)}/open`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(requestError(body, "打开输出目录失败"));
      setNotice("已打开本批结果目录");
    } catch (error) {
      const message = error instanceof TypeError
        ? "3100 服务未连接，请刷新页面后重试"
        : error instanceof Error ? error.message : "打开输出目录失败";
      setNotice(message);
    } finally {
      setIsOpeningOutput(false);
    }
  }

  const hasOutputFolder = Boolean(task?.outputFolder);
  const hasUsableOutputFolder = hasOutputFolder && !containsReplacementCharacter(task?.outputFolder);
  const hasUsableLastExportFolder = Boolean(task?.lastExportFolder) && !containsReplacementCharacter(task?.lastExportFolder);
  const finishedOutputFolder = hasUsableLastExportFolder ? task?.lastExportFolder || null : null;
  const hasUsableProcessingLastOutputFolder = Boolean(processing?.lastOutputFolder) && !containsReplacementCharacter(processing?.lastOutputFolder);
  const isQuickCutMode = activeMode === "quick-cut";
  const isValidCount = /^\d+$/.test(countInput) && Number(countInput) >= 1 && Number(countInput) <= 50;
  const smartFashionCount = editingMode === "fashion-showcase" && countMode === "smart";
  const canStartQuickCut = Boolean(task && sourceCount && (isValidCount || smartFashionCount) && hasUsableOutputFolder && !isTaskActive && !isImporting);
  const canStartMaterialProcessing = Boolean(task && processingSourceCount && !isTaskActive && !isImporting && (activeMode === "quality-optimize" || hasProcessingOutputFolder));
  const canStart = isQuickCutMode ? canStartQuickCut : canStartMaterialProcessing;
  const isFinished = Boolean(!isTaskActive && task && ["completed", "partial", "failed", "stopped"].includes(task.status));
  const isCurrentModeFinished = Boolean(isFinished && (isQuickCutMode || processing?.mode === activeMode));
  const currentStage = isStarting ? "正在启动" : isRunning ? "运行进度" : isCurrentModeFinished ? "处理结果" : isQuickCutMode ? "素材与参数" : activeMode === "metadata-cleanup" ? "元数据清理" : "轻微音画优化";
  const visibleStatusLabel = isStarting ? "启动中" : task ? statusLabel(task.status) : "";
  const visibleStatusClass = isStarting ? "luma-status-pill luma-quick-cut-status is-running" : task ? statusClass(task.status) : "";
  const visibleStage = isStarting ? "正在提交任务，请稍候" : task?.stage || "正在准备任务";
  const visibleProgress = isStarting ? Math.max(1, task?.progress || 0) : task?.progress || 0;
  const fieldClass = "luma-quick-cut-input mt-1.5 h-10 w-full rounded-md px-3 text-sm font-medium text-slate-100 outline-none transition disabled:cursor-not-allowed disabled:opacity-50";
  const iconButtonClass = "luma-action-button inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";

  if (!isQuickCutMode) {
    const materialLabel = activeMode === "metadata-cleanup" ? "元数据清理" : "轻微音画优化";
    const materialFinished = isCurrentModeFinished;
    const canOpenMaterialOutput = activeMode === "metadata-cleanup" && hasUsableProcessingLastOutputFolder;
    return (
      <section className="luma-glass-panel luma-quick-cut-page flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg">
        <header className="luma-topbar luma-quick-cut-topbar flex shrink-0 items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="luma-quick-cut-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-md"><Scissors className="h-4 w-4" /></span>
            <div className="min-w-0"><p className="luma-quick-cut-eyebrow">LOCAL QUICK CUT</p><h2 className="truncate text-2xl font-black text-slate-50">流光快剪</h2></div>
            {task && <span className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold ${visibleStatusClass}`}>{visibleStatusLabel}</span>}
          </div>
          <button type="button" title="刷新任务" aria-label="刷新任务" onClick={() => task && void refreshTask(task.id).catch((error) => setNotice(error instanceof Error ? error.message : "刷新任务失败"))} className="luma-action-button inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md" disabled={!task}><RefreshCw className="h-3.5 w-3.5" /></button>
        </header>
        <QuickCutModeSelector activeMode={activeMode} disabled={isTaskActive || isImporting} onChange={setActiveMode} />
        <div className="luma-quick-cut-stages grid shrink-0 grid-cols-3 px-5 py-2.5 text-xs font-semibold">
          {[{ label: "素材与处理", active: !isTaskActive && !materialFinished }, { label: "处理进度", active: isTaskActive }, { label: "处理结果", active: materialFinished }].map((stage) => <div key={stage.label} className={`luma-quick-cut-stage ${stage.active ? "is-current" : ""}`}><span>{stage.label}</span></div>)}
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4 [scrollbar-color:rgba(207,250,254,0.42)_transparent] [scrollbar-width:thin]">
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <main className="min-w-0 space-y-4">
              <section className="luma-quick-cut-panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="luma-quick-cut-eyebrow">LOCAL MEDIA PROCESSING</p><h3 className="mt-1 text-xl font-black text-slate-50">{materialLabel}</h3></div><span className="luma-quick-cut-local-note">全程本机处理</span></div>
                <div className="mt-4 border-t border-cyan-100/10 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-bold text-slate-100">本地视频</p><p className="mt-1 text-xs text-slate-400">通过 Windows 文件选择器多选，本批最多 200 个，按顺序处理</p></div><div className="flex items-center gap-2">{processingSourceCount > 0 && <button type="button" onClick={() => void clearProcessingSources()} className="luma-quick-cut-danger inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40" disabled={isTaskActive || isImporting}><Trash2 className="h-3.5 w-3.5" />清除</button>}<button type="button" onClick={() => void selectProcessingSources()} className={iconButtonClass} disabled={isTaskActive || isImporting}><FolderOpen className="h-3.5 w-3.5" />选择文件</button></div></div>
                  <div className="luma-quick-cut-source-bar mt-3 flex min-h-14 items-center gap-3 px-3"><FileVideo className="h-5 w-5 shrink-0 text-cyan-100" /><span className="min-w-0 truncate text-sm text-slate-300">{processingSourceCount ? `已选择 ${processingSourceCount} 个本地视频：${(processing?.sourceNames || []).slice(0, 3).join("、")}${processingSourceCount > 3 ? " 等" : ""}` : "选择视频后将在本机直接处理，快剪素材保持不变。"}</span></div>
                </div>
                {activeMode === "metadata-cleanup" ? <div className="mt-4 border-t border-cyan-100/10 pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-bold text-slate-100">输出位置</p><p className="mt-1 text-xs text-slate-400">清除后生成新文件，原文件不覆盖</p></div><button type="button" onClick={() => void selectProcessingOutputFolder()} className={iconButtonClass} disabled={isTaskActive || isImporting}><FolderOpen className="h-3.5 w-3.5" />{hasProcessingOutputFolder ? "更换位置" : "选择位置"}</button></div><p className="luma-quick-cut-processing-path mt-3 truncate text-xs" title={processingOutputFolder || undefined}>{hasProcessingOutputFolder ? processingOutputFolder : "尚未选择清理后的文件输出位置"}</p></div> : <div className="luma-quick-cut-overwrite-note mt-4 flex items-start gap-3 px-3 py-3"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-100" /><p className="text-xs leading-5 text-slate-300">处理会先写入同目录临时文件，完成音画校验后替换原文件；停止或失败时恢复原件。</p></div>}
              </section>
              <section className="luma-quick-cut-panel p-4"><div className="grid gap-3 sm:grid-cols-2"><InfoCell label="处理方式" value={materialLabel} /><InfoCell label="原始文件" value={activeMode === "metadata-cleanup" ? "保留不变" : "校验后覆盖"} /></div>{activeMode === "metadata-cleanup" ? <p className="mt-3 text-xs leading-5 text-slate-400">按原始自动剪辑脚本执行深度元数据、SEI 与技术标签清理；高强度伽马、频域 DWT/SVD/QIM/ECC、LSB 与时序混合标记后，固定 QP 重编码并完成兼容性终检。</p> : <p className="mt-3 text-xs leading-5 text-slate-400">保留分辨率、帧率与时长，使用保守的降噪、轻微色彩校正、响度统一与 CPU 自动回退。</p>}</section>
            </main>
            <aside className="luma-quick-cut-control-panel min-w-0 p-4 xl:sticky xl:top-0 xl:self-start">
              <div className="flex items-start justify-between gap-3"><div><p className="luma-quick-cut-eyebrow">{isTaskActive ? "LIVE MONITOR" : materialFinished ? "RESULT" : "READY CHECK"}</p><h3 className="mt-1 text-xl font-black text-slate-50">{currentStage}</h3></div>{isLoading && <LoaderCircle className="h-5 w-5 animate-spin text-cyan-100" />}</div>
              {!isTaskActive && !materialFinished && <div className="mt-4 space-y-2"><ReadinessRow label="本地视频" value={processingSourceCount ? `${processingSourceCount} 个已选择` : "待选择"} complete={Boolean(processingSourceCount)} />{activeMode === "metadata-cleanup" ? <ReadinessRow label="输出位置" value={hasProcessingOutputFolder ? "已选择" : "待选择"} complete={hasProcessingOutputFolder} /> : <ReadinessRow label="覆盖策略" value="校验后替换原文件" complete />}</div>}
              {isTaskActive && <div className="mt-4"><div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-slate-300">{visibleStage}</span><span className="shrink-0 font-black text-cyan-100">{visibleProgress}%</span></div><div className="luma-quick-cut-progress mt-3 h-2 overflow-hidden rounded-full"><div className="h-full rounded-full transition-all" style={{ width: `${visibleProgress}%` }} /></div><div className="mt-3 grid grid-cols-3 gap-2"><Metric label="完成" value={task?.completed || 0} suffix="个" /><Metric label="失败" value={task?.failed || 0} suffix="个" /><Metric label="总数" value={task?.total || 0} suffix="个" /></div></div>}
              {materialFinished && <div className="mt-4"><div className="grid grid-cols-3 gap-2"><Metric label="完成" value={task?.completed || 0} suffix="个" /><Metric label="失败" value={task?.failed || 0} suffix="个" /><Metric label="总数" value={task?.total || 0} suffix="个" /></div>{task?.rows?.length ? <div className="mt-4"><h4 className="text-sm font-bold text-slate-100">本次处理结果</h4><div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1 [scrollbar-color:rgba(207,250,254,0.42)_transparent] [scrollbar-width:thin]">{task.rows.map((row, index) => row.status === "done" ? <article key={`${row.planId}-${index}`} className="luma-quick-cut-result flex items-center justify-between gap-3 rounded-md px-3 py-2.5"><span className="min-w-0 truncate text-sm font-semibold text-slate-100">{row.planId}</span><span className="shrink-0 text-xs text-cyan-100">已完成</span></article> : <article key={`${row.planId}-${index}`} className="luma-quick-cut-result is-error rounded-md px-3 py-2.5"><span className="text-sm font-semibold text-rose-100">{row.planId}</span><p className="mt-1 text-xs text-rose-100/80">{row.error}</p></article>)}</div></div> : <p className="luma-quick-cut-empty mt-4">本次未生成可用处理结果。</p>}</div>}
              <div className="mt-4 border-t border-cyan-100/10 pt-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-bold text-slate-100">运行记录</h4>{canOpenMaterialOutput && <button type="button" onClick={() => void openOutput()} aria-busy={isOpeningOutput} disabled={isOpeningOutput} className="luma-action-button inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold disabled:cursor-wait disabled:opacity-70">{isOpeningOutput ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}{isOpeningOutput ? "正在打开" : "结果目录"}</button>}</div><div className={`luma-quick-cut-log mt-2 font-mono text-xs leading-5 ${isTaskActive ? "is-live" : ""}`}>{task?.events?.length ? task.events.slice().reverse().map((item, index) => <p key={`${item.at}-${index}`} className={item.level === "error" ? "text-rose-200" : item.level === "warning" ? "text-amber-200" : item.level === "success" ? "text-emerald-200" : "text-slate-400"}>{displayEventMessage(item.message)}</p>) : <p className="text-slate-500">选择本地视频后显示处理记录。</p>}</div></div>
            </aside>
          </div>
        </div>
        <footer className="luma-quick-cut-footer flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3"><p className="min-w-0 text-xs font-semibold text-slate-200">{notice || (isTaskActive ? "任务运行中，实时进度和错误会显示在右侧。" : activeMode === "metadata-cleanup" ? "清理结果将写入选择的位置，原文件保持不变。" : "优化结果通过校验后覆盖原文件，临时文件不会保留。")}</p><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => void stopTask()} className="luma-quick-cut-danger inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40" disabled={!isServerRunning}><Square className="h-3.5 w-3.5 fill-current" />停止</button><button type="button" onClick={() => void startMaterialProcessing()} aria-busy={isStarting} className={`luma-quick-cut-primary inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${isStarting ? "is-pending" : ""}`} disabled={!canStart}>{isStarting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}{isStarting ? "正在启动" : activeMode === "metadata-cleanup" ? "开始清理" : "开始优化"}</button></div></footer>
      </section>
    );
  }

  return (
    <section className="luma-glass-panel luma-quick-cut-page flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg">
      <input ref={sourceInputRef} type="file" multiple accept=".mp4,.mov,.mkv,.avi,.webm,.m4v,video/*" className="hidden" onChange={(event) => void handleFileInput("source", event)} />
      <input ref={productInputRef} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.bmp,image/*" className="hidden" onChange={(event) => void handleFileInput("product", event)} />
      <input ref={bgmInputRef} type="file" multiple accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*" className="hidden" onChange={(event) => void handleFileInput("bgm", event)} />
      <header className="luma-topbar luma-quick-cut-topbar flex shrink-0 items-center justify-between gap-4 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="luma-quick-cut-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-md"><Scissors className="h-4 w-4" /></span>
          <div className="min-w-0">
            <p className="luma-quick-cut-eyebrow">LOCAL QUICK CUT</p>
            <h2 className="truncate text-2xl font-black text-slate-50">流光快剪</h2>
          </div>
          {task && <span className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold ${visibleStatusClass}`}>{visibleStatusLabel}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" title="刷新任务" aria-label="刷新任务" onClick={() => task && void refreshTask(task.id).catch((error) => setNotice(error instanceof Error ? error.message : "刷新任务失败"))} className="luma-action-button inline-flex h-9 w-9 items-center justify-center rounded-md" disabled={!task}><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
      </header>

      <QuickCutModeSelector activeMode={activeMode} disabled={isTaskActive || isImporting} onChange={setActiveMode} />

      <div className="luma-quick-cut-stages grid shrink-0 grid-cols-3 px-5 py-2.5 text-xs font-semibold">
        {[{ label: "素材与参数", active: !isTaskActive && !isFinished }, { label: "生成进度", active: isTaskActive }, { label: "交付结果", active: isFinished }].map((stage) => <div key={stage.label} className={`luma-quick-cut-stage ${stage.active ? "is-current" : ""}`}><span>{stage.label}</span></div>)}
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4 [scrollbar-color:rgba(207,250,254,0.42)_transparent] [scrollbar-width:thin]">
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <main className="min-w-0 space-y-4">
            <section className="luma-quick-cut-panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="luma-quick-cut-eyebrow">BATCH SETUP</p><h3 className="mt-1 text-xl font-black text-slate-50">素材与成片设置</h3></div><span className="luma-quick-cut-local-note">全程本机处理</span></div>
              <label className="mt-4 block text-sm font-semibold text-slate-200">任务名称<input value={taskName} onChange={(event) => setTaskName(event.target.value)} disabled={isTaskActive} className={fieldClass} maxLength={60} /></label>
              {editingMode === "fashion-showcase" && <div className="mt-4 rounded-md border border-cyan-100/10 bg-black/10 p-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-slate-200">生成数量策略</p><span className="text-xs text-slate-400">按真实素材容量收口</span></div><div className="luma-quick-cut-segment mt-2 grid h-9 grid-cols-2 gap-1 rounded-md p-1"><button type="button" onClick={() => setCountMode("smart")} disabled={isTaskActive} className={countMode === "smart" ? "is-selected" : ""}>智能数量</button><button type="button" onClick={() => setCountMode("custom")} disabled={isTaskActive} className={countMode === "custom" ? "is-selected" : ""}>自定义数量</button></div>{countMode === "smart" ? <FashionSmartCount totalDuration={Number(task?.scan?.totalDuration || 0)} durationMode={durationMode} targetDuration={targetDuration} planning={planning?.countMode === "smart" ? planning : null} /> : <p className="mt-2 text-xs text-slate-400">自定义数量仍会在真实容量不足时自动收口。</p>}</div>}
              <div className="mt-4 border-t border-cyan-100/10 pt-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-bold text-slate-100">视频素材</p><p className="mt-1 text-xs text-slate-400">{sourceCount ? `已扫描 ${sourceCount} 条可用视频` : "可一次选择多个视频文件"}</p></div><div className="flex items-center gap-2">{sourceAssetCount > 0 && <button type="button" onClick={() => void clearSources()} className="luma-quick-cut-danger inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40" disabled={isTaskActive || isImporting}><Trash2 className="h-3.5 w-3.5" />清除素材</button>}<button type="button" onClick={() => selectFiles("source")} className={iconButtonClass} disabled={isTaskActive || isImporting || sourceAssetCount > 0}><FolderOpen className="h-3.5 w-3.5" />选择文件</button></div></div><div className="luma-quick-cut-source-bar mt-3 flex min-h-14 items-center gap-3 px-3"><FileVideo className="h-5 w-5 shrink-0 text-cyan-100" /><span className="min-w-0 truncate text-sm text-slate-300">{sourceCount ? `${sourceCount} 条视频素材已完成扫描，可开始设置本批成片。` : "导入视频后会自动扫描可用素材与异常文件。"}</span></div></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">{smartFashionCount ? <div><p className="text-sm font-semibold text-slate-200">生成数量</p><p className="mt-1.5 flex h-10 items-center rounded-md border border-cyan-100/15 bg-cyan-200/8 px-3 text-sm font-bold text-cyan-100">由分析自动确定</p></div> : <label className="text-sm font-semibold text-slate-200">{editingMode === "fashion-showcase" ? "期望生成数量" : "生成数量"}<div className="luma-quick-cut-stepper mt-1.5 grid h-10 grid-cols-[40px_1fr_40px] overflow-hidden rounded-md"><button type="button" aria-label="减少生成数量" onClick={() => applyCountValue(count - 1)} disabled={isTaskActive}>-</button><input type="number" min={1} max={50} inputMode="numeric" value={countInput} onChange={(event) => { const value = event.target.value; if (!/^\d*$/.test(value)) return; const nextInput = value.slice(0, 2); setCountInput(nextInput); if (nextInput) setCount(Number(nextInput)); }} onBlur={() => applyCountValue(Number(countInput))} disabled={isTaskActive} className="min-w-0 bg-transparent text-center text-sm font-bold outline-none" /><button type="button" aria-label="增加生成数量" onClick={() => applyCountValue(count + 1)} disabled={isTaskActive}>+</button></div></label>}<div><p className="text-sm font-semibold text-slate-200">成片时长</p><div className="luma-quick-cut-segment mt-1.5 grid h-10 grid-cols-2 gap-1 rounded-md p-1"><button type="button" onClick={() => setDurationMode("smart")} disabled={isTaskActive} className={durationMode === "smart" ? "is-selected" : ""}>智能时长</button><button type="button" onClick={() => setDurationMode("fixed")} disabled={isTaskActive} className={durationMode === "fixed" ? "is-selected" : ""}>固定时长</button></div></div></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2"><AssetPicker icon={ImageIcon} title="商品主图" value={productAssetCount ? `已导入 ${productAssetCount} 张，可清空后替换` : "可选，自动追加至成片结尾"} onClick={() => selectFiles("product")} onClear={productAssetCount ? () => void clearOptionalAssets("product") : undefined} clearLabel="清除商品主图" disabled={isTaskActive || isImporting} /><AssetPicker icon={AudioLines} title="背景音乐" value={bgmAssetCount ? `已导入 ${bgmAssetCount} 首，可清空后替换` : settings.audioMode === "original" ? "可选" : "当前声音模式需要"} onClick={() => selectFiles("bgm")} onClear={bgmAssetCount ? () => void clearOptionalAssets("bgm") : undefined} clearLabel="清除背景音乐" disabled={isTaskActive || isImporting} /></div>
            </section>
            <details className="luma-quick-cut-panel group"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-sm font-semibold text-slate-200"><span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-cyan-100" />高级设置</span><ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" /></summary><div className="grid gap-3 border-t border-cyan-100/10 p-4 sm:grid-cols-2"><SelectField label="剪辑模式" value={editingMode} disabled={isRunning} onChange={(value) => setEditingMode(value as typeof editingMode)} options={[["auto", "自动判断"], ["presenter", "主播口播"], ["voice-over", "纯旁白"], ["product-footage", "纯商品素材"]]} />{durationMode === "fixed" ? <SegmentField label="固定时长" value={String(targetDuration)} onChange={(value) => setTargetDuration(Number(value) as typeof targetDuration)} values={["15", "30", "45", "60"]} suffix="秒" disabled={isRunning} /> : <StaticField label="时长策略" value="按完整内容自然结束" />}<SelectField label="画面适配" value={settings.fit} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, fit: value as Settings["fit"] }))} options={[["blur", "模糊背景"], ["crop", "居中裁剪"], ["pad", "黑边填充"]]} /><SelectField label="声音模式" value={settings.audioMode} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, audioMode: value as Settings["audioMode"] }))} options={[["original", "仅保留原声"], ["mix", "原声 + 背景音乐"], ["bgm", "仅背景音乐"]]} /><div><p className="text-xs font-medium text-slate-400">背景音乐音量</p><div className="luma-quick-cut-range mt-1.5 flex h-10 items-center gap-2 rounded-md px-3"><input type="range" min={0} max={0.5} step={0.01} value={settings.bgmVolume} onChange={(event) => setSettings((current) => ({ ...current, bgmVolume: Number(event.target.value) }))} disabled={isRunning} className="h-1 flex-1 accent-cyan-200" /><span className="w-9 text-right text-xs text-cyan-100">{Math.round(settings.bgmVolume * 100)}%</span></div></div><SelectField label="转场" value={settings.transition} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, transition: value as Settings["transition"] }))} options={[["cut", "自然硬切"], ["fade", "短淡化"]]} /><SelectField label="帧率" value={String(settings.fps)} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, fps: Number(value) as Settings["fps"] }))} options={[["24", "24 fps"], ["25", "25 fps"], ["30", "30 fps"]]} /><SelectField label="导出质量" value={settings.quality} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, quality: value as Settings["quality"] }))} options={[["compact", "节省空间"], ["balanced", "均衡"], ["high", "高质量"]]} /><SelectField label="编码方式" value={settings.encoder} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, encoder: value as Settings["encoder"] }))} options={[["auto", "自动检测"], ["nvidia", "NVIDIA 显卡"], ["cpu", "CPU 兼容模式"]]} /><SelectField label="商品图停留" value={String(settings.productTailDuration)} disabled={isRunning} onChange={(value) => setSettings((current) => ({ ...current, productTailDuration: Number(value) as Settings["productTailDuration"] }))} options={[["1", "1 秒"], ["1.5", "1.5 秒"], ["2", "2 秒"], ["3", "3 秒"]]} /><label className="luma-quick-cut-checkbox flex h-10 items-center gap-2 rounded-md px-3 text-sm text-slate-300"><input type="checkbox" checked={settings.subtitles} onChange={(event) => setSettings((current) => ({ ...current, subtitles: event.target.checked }))} disabled={isRunning} className="h-4 w-4 accent-cyan-200" />生成本地字幕</label></div></details>
          </main>
    <aside className="luma-quick-cut-control-panel min-w-0 p-4 xl:sticky xl:top-0 xl:self-start"><div className="flex items-start justify-between gap-3"><div><p className="luma-quick-cut-eyebrow">{isRunning ? "LIVE MONITOR" : isFinished ? "DELIVERY" : "READY CHECK"}</p><h3 className="mt-1 text-xl font-black text-slate-50">{currentStage}</h3></div>{isLoading && <LoaderCircle className="h-5 w-5 animate-spin text-cyan-100" />}</div>{!isRunning && !isFinished && <div className="mt-4 space-y-2"><ReadinessRow label="视频素材" value={sourceCount ? `${sourceCount} 条已扫描` : "待选择"} complete={Boolean(sourceCount)} /><ReadinessRow label="输出位置" value={hasOutputFolder ? hasUsableOutputFolder ? "已选择" : "路径异常" : "待选择"} complete={hasUsableOutputFolder} /><ReadinessRow label="生成参数" value={`${smartFashionCount ? "智能数量（分析确定）" : `${count} 条`} · ${durationMode === "smart" ? "智能时长" : `${targetDuration} 秒`}`} complete /></div>}{isRunning && <div className="mt-4"><div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-slate-300">{task?.stage || "正在准备任务"}</span><span className="shrink-0 font-black text-cyan-100">{task?.progress || 0}%</span></div><div className="luma-quick-cut-progress mt-3 h-2 overflow-hidden rounded-full"><div className="h-full rounded-full transition-all" style={{ width: `${task?.progress || 0}%` }} /></div><div className="mt-3 grid grid-cols-3 gap-2"><Metric label="完成" value={task?.completed || 0} suffix="条" /><Metric label="失败" value={task?.failed || 0} suffix="条" /><Metric label="总数" value={task?.total || 0} suffix="条" /></div>{editingMode === "fashion-showcase" && planning?.countMode === "smart" && <PlanningSummary planning={planning} />}</div>}{isFinished && <div className="mt-4"><div className="grid grid-cols-3 gap-2"><Metric label="完成" value={task?.completed || 0} suffix="条" /><Metric label="失败" value={task?.failed || 0} suffix="条" /><Metric label="总数" value={task?.total || 0} suffix="条" /></div><PlanningSummary planning={planning} /><FashionVisionSummary analysis={analysis} />{analysis?.fashionVisionAvailable !== undefined && <p className="mt-3 text-xs text-cyan-100">女装视觉分析：{fashionVisionLabel(analysis)}{analysis.fashionCandidateCount ? "，" + analysis.fashionCandidateCount + " 个候选时间窗口" : ""}</p>}{task?.rows?.length ? <div className="mt-4"><h4 className="text-sm font-bold text-slate-100">本批成片</h4><div className="mt-2 space-y-2">{task.rows.slice(0, 8).map((row) => <QuickCutResultRow key={row.planId} row={row} />)}</div></div> : <p className="luma-quick-cut-empty mt-4">本次任务尚未生成可交付成片。</p>}{finishedOutputFolder && <div className="mt-4 border-t border-cyan-100/10 pt-4"><p className="text-xs font-semibold text-slate-300">本批输出位置</p><p className="luma-quick-cut-output-path mt-2 truncate text-xs" title={finishedOutputFolder}>{finishedOutputFolder}</p></div>}</div>}<div className="mt-4 border-t border-cyan-100/10 pt-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-bold text-slate-100">运行记录</h4>{hasUsableLastExportFolder && <button type="button" onClick={() => void openOutput()} aria-busy={isOpeningOutput} disabled={isOpeningOutput} className="luma-action-button inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold disabled:cursor-wait disabled:opacity-70">{isOpeningOutput ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}{isOpeningOutput ? "正在打开" : "结果目录"}</button>}</div><div className={`luma-quick-cut-log mt-2 font-mono text-xs leading-5 ${isRunning ? "is-live" : ""}`}>{task?.events?.length ? task.events.slice().reverse().map((item, index) => <p key={`${item.at}-${index}`} className={item.level === "error" ? "text-rose-200" : item.level === "warning" ? "text-amber-200" : item.level === "success" ? "text-emerald-200" : "text-slate-400"}>{displayEventMessage(item.message)}</p>) : <p className="text-slate-500">选择视频素材后显示处理记录。</p>}</div></div>{!isRunning && !isFinished && <div className="mt-4 border-t border-cyan-100/10 pt-4"><p className="truncate text-xs text-slate-400" title={hasUsableOutputFolder ? task?.outputFolder || undefined : undefined}>{displayOutputFolder(task?.outputFolder)}</p><button type="button" onClick={() => void selectOutputFolder()} disabled={isImporting} className={`${iconButtonClass} mt-3 w-full`}><FolderOpen className="h-3.5 w-3.5" />{hasUsableOutputFolder ? "更换输出位置" : hasOutputFolder ? "重新选择输出位置" : "选择输出位置"}</button></div>}{analysis && !isRunning && !isFinished && <details className="mt-4 border-t border-cyan-100/10 pt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-300">查看素材分析</summary><div className="mt-3 grid grid-cols-2 gap-2"><InfoCell label="识别类型" value={analysis.detectedType || "待分析"} /><InfoCell label="口播比例" value={`${Math.round(Number(analysis.speechCoverage || 0) * 100)}%`} /><InfoCell label="片段数量" value={analysis.segmentCount ?? "-"} /><InfoCell label="主讲素材" value={analysis.presenterSourceCount ?? "-"} /><InfoCell label="女装视觉" value={fashionVisionLabel(analysis)} /><InfoCell label="候选镜头" value={analysis.fashionCandidateCount ?? "-"} /></div>{tagSummary && <p className="mt-3 text-xs text-cyan-100">识别卖点：{tagSummary}</p>}{shortageSummary && <p className="mt-2 text-xs text-amber-100">素材提示：{shortageSummary}</p>}{analysis.fashionVisionWarning && <p className="mt-2 text-xs text-amber-100">女装视觉提示：{analysis.fashionVisionWarning}</p>}</details>}</aside>
        </div>
      </div>
      <footer className="luma-quick-cut-footer flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3"><p className="min-w-0 text-xs font-semibold text-slate-200">{notice || (isTaskActive ? "任务运行中，实时进度和错误会显示在右侧。" : "仅将 MP4 成片写入所选位置，3100 不保留预览或排错副本。")}</p><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => void stopTask()} className="luma-quick-cut-danger inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40" disabled={!isServerRunning}><Square className="h-3.5 w-3.5 fill-current" />停止</button><button type="button" onClick={() => void startTask()} aria-busy={isStarting} className={`luma-quick-cut-primary inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${isStarting ? "is-pending" : ""}`} disabled={!canStart}>{isStarting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}{isStarting ? "正在启动" : "开始混剪"}</button></div></footer>
    </section>
  );
}

function AssetPicker({ icon: Icon, title, value, onClick, onClear, clearLabel, disabled }: { icon: LucideIcon; title: string; value: string; onClick: () => void; onClear?: () => void; clearLabel?: string; disabled: boolean }) {
  return <div className="luma-quick-cut-asset flex min-w-0 items-center gap-2 rounded-md px-3 py-2.5"><button type="button" onClick={onClick} disabled={disabled} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-40"><span className="luma-quick-cut-asset-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-md"><Icon className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-100">{title}</span><span className="mt-0.5 block truncate text-xs text-slate-400">{value}</span></span><span className="text-xs font-semibold text-cyan-100">选择</span></button>{onClear && <button type="button" title={clearLabel} aria-label={clearLabel} onClick={onClear} disabled={disabled} className="luma-quick-cut-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>}</div>;
}

function Metric({ label, value, suffix }: { label: string; value: string | number; suffix: string }) {
  return <div className="luma-quick-cut-stat rounded-md p-2.5"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 truncate text-lg font-black text-slate-100">{value}<span className="ml-0.5 text-xs font-medium text-slate-500">{suffix}</span></p></div>;
}

function InfoCell({ label, value }: { label: string; value: string | number }) {
  return <div className="luma-quick-cut-fact rounded-md px-2.5 py-2"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 truncate text-sm font-semibold text-slate-200">{value}</p></div>;
}

function ReadinessRow({ label, value, complete }: { label: string; value: string; complete: boolean }) {
  return <div className={`luma-quick-cut-readiness flex items-center justify-between gap-3 rounded-md px-3 py-2.5 ${complete ? "is-complete" : ""}`}><span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-200"><Check className="h-4 w-4 shrink-0" />{label}</span><span className="shrink-0 text-xs text-slate-400">{value}</span></div>;
}

function QuickCutModeSelector({ activeMode, disabled, onChange }: { activeMode: QuickCutMode; disabled: boolean; onChange: (mode: QuickCutMode) => void }) {
  return <nav aria-label="流光快剪功能模式" className="luma-quick-cut-mode-switch grid shrink-0 grid-cols-3 gap-1 px-5 py-3">{modeDefinitions.map(({ id, label, description, icon: Icon }) => <button type="button" key={id} title={description} aria-pressed={activeMode === id} disabled={disabled} onClick={() => onChange(id)} className={`luma-quick-cut-mode flex min-w-0 items-center justify-center gap-2 rounded-md px-2 py-2 text-xs font-semibold transition ${activeMode === id ? "is-selected" : ""}`}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{label}</span></button>)}</nav>;
}

function SelectField({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resolvedOptions = label === "剪辑模式"
    ? [...options, ["fashion-showcase", "女装穿搭展示"] as [string, string]]
    : options;
  const selected = resolvedOptions.find(([optionValue]) => optionValue === value)?.[1] || value;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return <div ref={rootRef} className="relative"><span className="text-[10px] font-medium text-slate-400">{label}</span><button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} disabled={disabled} className="mt-1.5 flex h-9 w-full items-center justify-between rounded-md border border-cyan-100/14 bg-black/20 px-2.5 text-left text-[11px] font-semibold text-slate-100 outline-none transition hover:border-cyan-100/30 hover:bg-cyan-100/[0.05] focus:border-cyan-100/40 disabled:cursor-not-allowed disabled:opacity-50"><span className="truncate">{selected}</span><ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-100 transition ${open ? "rotate-180" : ""}`} /></button>{open && <div role="listbox" aria-label={label} className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-md border border-cyan-100/22 bg-[#081722]/98 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.42),0_0_24px_rgba(103,232,249,0.07)] backdrop-blur-xl">{resolvedOptions.map(([optionValue, labelText]) => <button type="button" role="option" aria-selected={optionValue === value} key={optionValue} onClick={() => { onChange(optionValue); setOpen(false); }} className={`flex h-8 w-full items-center justify-between rounded px-2 text-left text-[11px] font-semibold transition ${optionValue === value ? "bg-cyan-200/16 text-cyan-50" : "text-slate-300 hover:bg-cyan-100/[0.09] hover:text-cyan-50"}`}><span>{labelText}</span>{optionValue === value && <Check className="h-3.5 w-3.5 text-cyan-100" />}</button>)}</div>}</div>;
}

function SegmentField({ label, value, onChange, values, suffix, disabled }: { label: string; value: string; onChange: (value: string) => void; values: string[]; suffix: string; disabled: boolean }) {
  return <div><p className="text-[10px] font-medium text-slate-400">{label}</p><div className="luma-quick-cut-segment mt-1.5 grid h-9 grid-cols-4 gap-1 rounded-md p-1">{values.map((item) => <button type="button" key={item} onClick={() => onChange(item)} disabled={disabled} className={value === item ? "is-selected" : ""}>{item}{suffix}</button>)}</div></div>;
}

function StaticField({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-medium text-slate-400">{label}</p><p className="mt-1.5 flex h-9 items-center rounded-md border border-cyan-100/10 bg-black/14 px-2.5 text-[11px] text-slate-400">{value}</p></div>;
}

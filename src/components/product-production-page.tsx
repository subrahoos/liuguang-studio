"use client";

/* eslint-disable @next/next/no-img-element -- Local authenticated production assets are intentionally rendered without remote optimization. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Copy, Factory, Film, FolderOpen, ImageIcon, Images,
  LoaderCircle, PackageCheck, Plus, RefreshCw, Settings2, Sparkles, Upload,
  Trash2, WandSparkles, X,
} from "lucide-react";
import { LumaSelect } from "@/components/model-channel-select";
import { LumaConfirmDialog } from "@/components/ui/luma-action-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resultEmptyMessage } from "@/lib/product-production-state";
import { ProductionSaveLedger } from "@/lib/product-production-save-ledger";
import { productionLocationUrl, readProductionLocation, type ProductionLocation } from "@/lib/product-production-location";

type ProductionMode = "video" | "detail" | "both";
type SetupStep = "product" | "production";
type TaskLoadMode = "open" | "refresh" | "poll";
type AssetKind = "product_source" | "product_master" | "reference_video" | "detail_image" | "face_image" | "scene_image" | "audio" | "video_output" | "detail_output";
type Asset = { id: string; kind: AssetKind; name: string; publicUrl: string; mimeType: string; width?: number; height?: number; durationSeconds?: number; bytes?: number; createdAt: string };
type VideoSource = { id: string; assetId: string; copies: number; channelId?: string; generationSeconds?: number; resolution?: "720p" | "1080p" };
type Job = { id: string; kind: "product_master" | "video" | "detail"; status: string; sourceAssetId?: string; variantIndex?: number; channelId: string; outputAssetId?: string; error?: string; remoteTaskId?: string; startedAt?: string; submittedAt?: string; finishedAt?: string; generationSeconds?: number; resolution?: string; channelSnapshot?: { name: string }; cleanup?: { status: string }; referenceTransport?: string; referenceUploadCount?: number; referenceExpiresAt?: string };
type Task = {
  id: string; revision: number; name: string; status: string; updatedAt: string; outputDirectory: string;
  payload: {
    productionMode: ProductionMode; assets: Asset[]; productSourceAssetIds: string[]; productMasterAssetId?: string;
    approvedProductMasterAssetId?: string; productMasterReviewStatus: "not_ready" | "pending" | "approved"; productMasterApprovedAt?: string;
    videoSources: VideoSource[]; detailAssetIds: string[]; faceAssetId?: string; sceneAssetId?: string; audioAssetId?: string;
    imageChannelId?: string; videoChannelId?: string; defaultVideoSeconds?: number; defaultVideoResolution?: "720p" | "1080p"; jobs: Job[];
  };
};
type TaskSummary = { id: string; name: string; status: string; updatedAt: string; productMasterUrl?: string; productMasterReviewStatus?: "not_ready" | "pending" | "approved"; productionMode?: ProductionMode; plannedVideos: number; detailImages: number; completedJobs: number; failedJobs: number; runningJobs: number; totalJobs: number };
type ImageChannel = { id: string; name: string; model: string; available: boolean };
type VideoChannel = { id: string; name: string; model: string; available: boolean; hostingReady: boolean; temporaryFiles: boolean; durationOptions: number[]; resolutionOptions: Array<"720p" | "1080p">; defaultDuration: number; defaultResolution: "720p" | "1080p"; faceOptional: boolean; sceneOptional: boolean; audioSupported: boolean };

const statusText: Record<string, string> = {
  draft: "待准备白底图", master_review: "白底图待验收", ready: "白底图已通过", queued: "等待执行", running: "生成中", partial: "部分完成", done: "已完成", failed: "有失败项", cancelled: "已取消",
  waiting: "等待商品白底图", submitting: "正在提交", uncertain: "提交状态待核实",
};

async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}
async function copyText(value: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝了复制操作。");
}
function modeLabel(mode: ProductionMode) { return mode === "video" ? "商品视频" : mode === "detail" ? "详情图换装" : "商品生产"; }
function includesVideo(mode: ProductionMode) { return mode !== "detail"; }
function includesDetail(mode: ProductionMode) { return mode !== "video"; }
function producesVideo(task: Task) { return includesVideo(task.payload.productionMode) && task.payload.videoSources.length > 0; }
function producesDetail(task: Task) { return includesDetail(task.payload.productionMode) && task.payload.detailAssetIds.length > 0; }
function productReady(task: Task) { return Boolean(task.payload.approvedProductMasterAssetId && task.payload.productMasterReviewStatus === "approved"); }
function sourcesReady(task: Task) {
  return task.payload.productionMode === "both"
    ? producesVideo(task) || producesDetail(task)
    : task.payload.productionMode === "video" ? producesVideo(task) : producesDetail(task);
}
function needsImageModel(task: Task) { return producesDetail(task); }
function modelsReady(task: Task) {
  return (!needsImageModel(task) || Boolean(task.payload.imageChannelId))
    && (!producesVideo(task) || task.payload.videoSources.every((source) => Boolean(source.channelId || task.payload.videoChannelId)));
}
function videoModelRequirements(task: Task, videoChannels: VideoChannel[]) {
  const channels = task.payload.videoSources.map((source) => videoChannels.find((item) => item.id === (source.channelId || task.payload.videoChannelId))).filter(Boolean) as VideoChannel[];
  return {
    needsFace: channels.some((channel) => !channel.faceOptional),
    needsScene: channels.some((channel) => !channel.sceneOptional),
    audioUnsupported: Boolean(task.payload.audioAssetId) && channels.some((channel) => !channel.audioSupported),
  };
}
function allModelInputsReady(task: Task, imageChannels: ImageChannel[], videoChannels: VideoChannel[]) {
  const requirements = videoModelRequirements(task, videoChannels);
  return modelsReady(task)
    && (!needsImageModel(task) || imageChannels.some((channel) => channel.id === task.payload.imageChannelId && channel.available))
    && (!producesVideo(task) || task.payload.videoSources.every((source) => videoChannels.some((channel) => channel.id === (source.channelId || task.payload.videoChannelId) && channel.available)))
    && (!requirements.needsFace || Boolean(task.payload.faceAssetId))
    && (!requirements.needsScene || Boolean(task.payload.sceneAssetId))
    && !requirements.audioUnsupported;
}
function firstIncompleteStep(task: Task): SetupStep {
  return productReady(task) ? "production" : "product";
}

function videoConfigError(task: Task, channels: VideoChannel[]) {
  if (!producesVideo(task)) return "";
  for (const source of task.payload.videoSources) {
    const channel = channels.find((item) => item.id === (source.channelId || task.payload.videoChannelId));
    if (!channel?.available) return "所选视频模型不可用，请选择模型或配置当前账户凭证。";
    const seconds = source.generationSeconds || task.payload.defaultVideoSeconds || channel.defaultDuration;
    const resolution = source.resolution || task.payload.defaultVideoResolution || channel.defaultResolution;
    if (!channel.durationOptions.includes(seconds)) return `模型「${channel.name}」不支持 ${seconds} 秒，请调整对应视频设置。`;
    if (!channel.resolutionOptions.includes(resolution)) return `模型「${channel.name}」不支持 ${resolution}，请调整清晰度。`;
    const video = task.payload.assets.find((item) => item.id === source.assetId);
    if (video?.durationSeconds && video.durationSeconds > seconds + 0.25) return `「${video.name}」为 ${video.durationSeconds.toFixed(2)} 秒，请选足够长的模型档位或缩短参考视频。`;
    if (!channel.hostingReady) return `模型「${channel.name}」缺少当前账户的参考素材托管配置。`;
    const ids = [source.assetId, task.payload.approvedProductMasterAssetId, task.payload.faceAssetId, task.payload.sceneAssetId, task.payload.audioAssetId];
    if (channel.temporaryFiles && ids.some((id) => Number(task.payload.assets.find((item) => item.id === id)?.bytes || 0) > 20 * 1024 * 1024)) return "当前模型参考素材单文件最多 20MB，请缩小后上传。";
  }
  return "";
}

export function ProductProductionPage() {
  const [summaries, setSummaries] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [imageChannels, setImageChannels] = useState<ImageChannel[]>([]);
  const [videoChannels, setVideoChannels] = useState<VideoChannel[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [activeView, setActiveView] = useState<"setup" | "results">("setup");
  const [setupStep, setSetupStep] = useState<SetupStep>("product");
  const isEditingName = useRef(false);
  const taskRef = useRef<Task | null>(null);
  const pending = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveFailed = useRef(false);
  const saveLedger = useRef(new ProductionSaveLedger());
  const dirtyName = useRef(false);
  const restoreLocation = useRef<ProductionLocation | null>(null);
  const [saveState, setSaveState] = useState("");
  const [syncState, setSyncState] = useState("");
  const [uploadFailures, setUploadFailures] = useState<{ kind: AssetKind; files: File[] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskSummary | null>(null);
  const openRequest = useRef(0);
  useEffect(() => { taskRef.current = task; }, [task]);
  const taskId = task?.id;

  const loadList = useCallback(async () => {
    const data = await responseJson(await fetch("/api/product-production", { cache: "no-store" }));
    setSummaries(data.tasks || []);
  }, []);
  const loadChannels = useCallback(async () => {
    const data = await responseJson(await fetch("/api/product-production/channels", { cache: "no-store" }));
    setImageChannels(data.imageChannels || []); setVideoChannels(data.videoChannels || []);
  }, []);
  const loadTask = useCallback(async (id: string, mode: TaskLoadMode = "open") => {
    if (mode === "open" && pending.current) return;
    const request = mode === "open" ? ++openRequest.current : openRequest.current;
    try {
      const response = await fetch(`/api/product-production/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (mode === "open" && restoreLocation.current?.id === id && [401, 403, 404].includes(response.status)) {
        restoreLocation.current = null;
        window.history.replaceState(null, "", productionLocationUrl(window.location.href, null));
      }
      const data = await responseJson(response);
      if (request !== openRequest.current || (mode !== "open" && taskRef.current?.id !== id) || (mode === "poll" && pending.current > 0)) return;
      setTask((current) => {
        if (current?.id === id && current.revision > data.task.revision) return current;
        const next = isEditingName.current && current?.id === id ? { ...data.task, name: current.name } : data.task;
        taskRef.current = next;
        return next;
      });
      setSyncState(`已同步 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
      if (mode === "open") {
        saveLedger.current.clear(); saveFailed.current = false; dirtyName.current = false; setSaveState(""); setUploadFailures(null);
        const restored = restoreLocation.current?.id === id ? restoreLocation.current : null;
        restoreLocation.current = null;
        const contentExists = data.task.payload.jobs.some((job: Job) => job.kind === "video" || job.kind === "detail");
        setMessage(""); setSetupStep(restored?.step === "product" || !productReady(data.task) ? "product" : firstIncompleteStep(data.task));
        setActiveView(contentExists && (!restored || restored.view === "results") ? "results" : "setup");
      }
      if (mode === "refresh") setMessage("已刷新当前任务，页面位置保持不变。");
    } catch (error) { setSyncState("连接中断，正在等待重新同步"); if (mode !== "poll") setMessage(error instanceof Error ? error.message : "读取任务失败。"); }
  }, []);

  useEffect(() => {
    const restored = readProductionLocation(window.location.href);
    if (restored) { restoreLocation.current = restored; void loadTask(restored.id); }
    void Promise.all([
      loadList(),
      loadChannels(),
    ]).catch((error) => setMessage(error instanceof Error ? error.message : "加载商品生产线失败。"));
  }, [loadList, loadChannels, loadTask]);
  useEffect(() => {
    if (!taskId) return;
    const href = productionLocationUrl(window.location.href, { id: taskId, view: activeView, step: setupStep });
    window.history.replaceState(null, "", href);
  }, [taskId, activeView, setupStep]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!pending.current && !saveLedger.current.hasFailures && !dirtyName.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);
  const activeTask = Boolean(task?.payload.jobs.some((job) => ["queued", "submitting", "running"].includes(job.status)));
  useEffect(() => {
    if (!taskId) return;
    const timer = window.setInterval(() => { if (!document.hidden && !pending.current) void loadTask(taskId, "poll"); }, activeTask ? 3000 : 30_000);
    return () => window.clearInterval(timer);
  }, [loadTask, taskId, activeTask]);

  async function createTask() {
    if (busy) return;
    openRequest.current++; restoreLocation.current = null;
    setBusy("create"); setMessage("");
    try {
      const data = await responseJson(await fetch("/api/product-production", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionMode: "both" }) }));
      taskRef.current = data.task; setTask(data.task); setActiveView("setup"); setSetupStep("product");
      await loadList().catch(() => setMessage("任务已创建，但列表暂未同步，请稍后刷新。"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建失败。"); } finally { setBusy(""); }
  }
  function requestDeleteTask(id: string) {
    if (busy) return;
    const target = summaries.find((item) => item.id === id);
    if (target) setDeleteTarget(target);
  }
  async function confirmDeleteTask() {
    const target = deleteTarget;
    if (!target || busy) return;
    setBusy(`delete:${target.id}`); setMessage("");
    try {
      await responseJson(await fetch(`/api/product-production/${encodeURIComponent(target.id)}`, { method: "DELETE" }));
      setDeleteTarget(null);
      await loadList();
      setMessage("任务已删除。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "删除任务失败。"); }
    finally { setBusy(""); }
  }
  function patchTask(patch: Record<string, unknown>): Promise<Task | null> {
    const id = taskRef.current?.id;
    if (!id) return Promise.resolve(null);
    pending.current++; setSaveState("保存中…");
    const saveAttempt = saveLedger.current.begin(patch);
    saveFailed.current = saveLedger.current.hasFailures;
    const work = saveQueue.current.then(async () => {
      try {
        if (taskRef.current?.id !== id) return null;
        let revision = taskRef.current.revision;
        for (let attempt = 0; attempt < 3; attempt++) {
          const effectivePatch = saveLedger.current.currentPatch(saveAttempt);
          if (!Object.keys(effectivePatch).length) return taskRef.current;
          const response = await fetch(`/api/product-production/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...effectivePatch, expectedRevision: revision }) });
          const data = await response.json();
          if (response.status === 409 && data.task) { revision = data.task.revision; continue; }
          if (!response.ok) throw new Error(data.error || "保存失败。");
          if (taskRef.current?.id === id) {
            const next = isEditingName.current ? { ...data.task, name: taskRef.current.name } : data.task;
            taskRef.current = next; setTask(next);
          }
          saveLedger.current.succeed(saveAttempt);
          saveFailed.current = saveLedger.current.hasFailures;
          if ("name" in effectivePatch && !isEditingName.current) dirtyName.current = false;
          setSyncState(`已同步 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
          return data.task as Task;
        }
        throw new Error("配置同时发生变化，请刷新后重新保存。");
      } catch (error) {
        saveLedger.current.fail(saveAttempt);
        saveFailed.current = saveLedger.current.hasFailures;
        setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
        return null;
      } finally {
        pending.current--;
        setSaveState(pending.current ? "保存中…" : saveFailed.current ? "保存失败，请重新设置" : "已保存");
      }
    });
    saveQueue.current = work;
    return work;
  }
  async function upload(kind: AssetKind, files: File[]) {
    if (!task || files.length === 0 || busy) return;
    setBusy(`upload:${kind}`); setMessage("");
    const failed: File[] = [];
    const failedMessages: string[] = [];
    let successful = 0;
    try {
      await saveQueue.current;
      for (const [index, file] of files.entries()) {
        setMessage(`正在上传 ${index + 1}/${files.length}：${file.name}`);
        try {
          const form = new FormData(); form.set("kind", kind); form.append("files", file);
          const latest = (await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/assets`, { method: "POST", body: form }))).task;
          if (taskRef.current?.id === task.id && taskRef.current.revision <= latest.revision) {
            const next = isEditingName.current ? { ...latest, name: taskRef.current.name } : latest;
            taskRef.current = next; setTask(next);
          }
          successful++;
        } catch (error) { failed.push(file); failedMessages.push(`${file.name}：${error instanceof Error ? error.message : "上传失败"}`); }
      }
      setUploadFailures(failed.length ? { kind, files: failed } : null);
      setMessage(`上传完成：成功 ${successful} 个${failed.length ? `，失败 ${failed.length} 个。${failedMessages.join("；")}` : ""}。`);
      await loadList();
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传失败。"); } finally { setBusy(""); }
  }
  async function generateMaster() {
    if (!task) return; setBusy("generate-master"); setMessage("");
    try {
      await saveQueue.current;
      if (saveFailed.current) throw new Error("还有未保存的设置，请重试保存后再生成白底图。");
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/generate-master`, { method: "POST" }));
      setTask(data.task); setActiveView("setup"); setSetupStep("product"); setMessage("产品白底图已进入生成队列；完成后需要你验收，不会自动开始内容生产。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法生成产品白底图。"); } finally { setBusy(""); }
  }
  async function approveMaster() {
    if (!task) return; setBusy("approve-master"); setMessage("");
    try {
      await saveQueue.current;
      if (saveFailed.current) throw new Error("还有未保存的设置，请重试保存后再验收。");
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/approve-master`, { method: "POST" }));
      setTask(data.task); setSetupStep("production"); setMessage("产品白底图已验收并锁定，可以开始准备原素材。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法验收产品白底图。"); } finally { setBusy(""); }
  }
  async function resetMasterApproval() {
    if (!task) return; setBusy("reset-master"); setMessage("");
    try {
      await saveQueue.current;
      if (saveFailed.current) throw new Error("还有未保存的设置，请重试保存后再更换白底图。");
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/reset-master-approval`, { method: "POST" }));
      setTask(data.task); setSetupStep("product"); setMessage("已解除白底图验收，可以重新上传或重新生成。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法更换产品白底图。"); } finally { setBusy(""); }
  }
  async function start() {
    if (!task) return; setBusy("start"); setMessage("");
    try {
      await saveQueue.current;
      if (saveFailed.current) throw new Error("还有未保存的设置，请重新设置后再开始。");
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/start`, { method: "POST" }));
      setTask(data.task); setActiveView("results"); setMessage("生产任务已经进入队列。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法开始生产。"); } finally { setBusy(""); }
  }
  async function retry(includeUncertain = false, jobId?: string) {
    if (!task) return; setBusy("retry"); setMessage("");
    try { const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmUncertain: includeUncertain, jobId }) })); setTask(data.task); setMessage(includeUncertain ? "待核实项已在人工确认后重新进入队列。" : "失败项已重新进入队列。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "重试失败。"); } finally { setBusy(""); }
  }
  async function retryUncertainMaster() {
    if (!task) return; setBusy("retry-master"); setMessage("");
    try {
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmUncertain: true, includeProductMaster: true }),
      }));
      setTask(data.task); setMessage("已确认上游没有白底图结果，本次重新提交白底图生成。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "重新提交白底图失败。"); }
    finally { setBusy(""); }
  }
  async function resolveMasterWithUpload() {
    if (!task) return; setBusy("resolve-master"); setMessage("");
    try {
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/resolve-master`, { method: "POST" }));
      setTask(data.task); setMessage("已记录从模型平台取回的白底图，请检查大图后点击验收通过。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法核实已上传的白底图。"); }
    finally { setBusy(""); }
  }
  async function cancelQueued() {
    if (!task) return; setBusy("cancel"); setMessage("");
    try { const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/cancel`, { method: "POST" })); setTask(data.task); setMessage("尚未提交给模型的执行项已停止；已经提交的远端任务会继续回收结果。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "停止失败。"); } finally { setBusy(""); }
  }
  async function removeAsset(assetId: string) {
    setMessage(""); await patchTask({ removeAssetId: assetId });
  }
  async function duplicateTask() {
    if (!task || busy) return;
    setBusy("duplicate");
    try {
      await saveQueue.current;
      if (saveFailed.current) throw new Error("还有未保存的设置，请重试保存后再新建批次。");
      const data = await responseJson(await fetch(`/api/product-production/${encodeURIComponent(task.id)}/duplicate`, { method: "POST" }));
      taskRef.current = data.task; setTask(data.task); setActiveView("setup"); setSetupStep("production");
      setMessage("已沿用人工验收通过的白底图。请上传本批原素材，确认后才会调用模型。");
      await loadList().catch(() => setMessage("新批次已创建，但列表暂未同步，请稍后刷新。"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "新建批次失败。"); }
    finally { setBusy(""); }
  }

  function returnToList() {
    if (busy || pending.current) return;
    if ((saveLedger.current.hasFailures || dirtyName.current) && !window.confirm("还有未保存的设置。返回列表将丢弃这些修改，是否仍然返回？")) return;
    openRequest.current++; restoreLocation.current = null;
    saveLedger.current.clear(); saveFailed.current = false; dirtyName.current = false; setSaveState("");
    taskRef.current = null; setTask(null); setUploadFailures(null); setMessage("");
    window.history.replaceState(null, "", productionLocationUrl(window.location.href, null));
    void loadList().catch(() => setMessage("读取列表失败，请刷新。"));
  }

  if (!task) return <>
    <TaskLibrary summaries={summaries} busy={busy} message={message} onCreate={() => void createTask()} onOpen={(id) => void loadTask(id)} onDelete={requestDeleteTask} />
    <LumaConfirmDialog
      open={Boolean(deleteTarget)}
      onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}
      title="删除商品生产任务"
      description={<>确定删除“{deleteTarget?.name || "当前任务"}”吗？任务素材和结果文件都会删除，此操作不可恢复。</>}
      confirmLabel="确认删除"
      onConfirm={() => void confirmDeleteTask()}
      pending={busy.startsWith("delete:")}
    />
  </>;

  const asset = (id?: string) => task.payload.assets.find((item) => item.id === id);
  const master = asset(task.payload.productMasterAssetId);
  const approvedMaster = asset(task.payload.approvedProductMasterAssetId);
  const plannedVideos = producesVideo(task) ? task.payload.videoSources.reduce((sum, item) => sum + item.copies, 0) : 0;
  const plannedDetails = producesDetail(task) ? task.payload.detailAssetIds.length : 0;
  const contentJobs = task.payload.jobs.filter((job) => job.kind === "video" || job.kind === "detail");
  const completed = contentJobs.filter((job) => job.status === "done").length;
  const failed = contentJobs.filter((job) => job.status === "failed").length;
  const outputs = contentJobs.filter((job) => job.outputAssetId).map((job) => ({ job, output: asset(job.outputAssetId), source: asset(job.sourceAssetId) })).filter((item) => item.output);
  const hasQueued = contentJobs.some((job) => ["waiting", "queued"].includes(job.status));
  const locked = contentJobs.length > 0;
  const masterBusy = task.payload.jobs.some((job) => job.kind === "product_master" && ["queued", "submitting", "running"].includes(job.status));

  return <section className="luma-product-production flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-cyan-100/14 bg-[#061019]/34 shadow-[0_28px_90px_rgba(0,0,0,0.28)] backdrop-blur-[18px]">
    <header className="product-production-header shrink-0 border-b border-cyan-100/12 bg-black/16 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><button disabled={Boolean(busy) || saveState === "保存中…"} onClick={returnToList} className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-xs font-bold text-slate-200 transition hover:border-cyan-100/25 hover:bg-cyan-100/[0.06]"><ArrowLeft className="h-4 w-4" />全部任务</button><div className="min-w-0"><input value={task.name} onFocus={() => { isEditingName.current = true; }} onChange={(event) => { dirtyName.current = true; setTask({ ...task, name: event.target.value }); }} onBlur={() => { isEditingName.current = false; void patchTask({ name: task.name }); }} className="product-production-task-title block min-w-0 max-w-md bg-transparent text-lg font-black text-slate-50 outline-none focus:text-cyan-50" aria-label="任务名称" /><p className="mt-0.5 text-[11px] text-slate-500">{modeLabel(task.payload.productionMode)} · {[saveState, syncState].filter(Boolean).join(" · ") || "跟着步骤完成本次生产"}</p></div><StatusPill status={task.status} /></div><div className="flex items-center gap-2"><ViewTabs active={activeView} resultCount={outputs.length} resultsEnabled={contentJobs.length > 0} onChange={setActiveView} /><button disabled={Boolean(busy) || saveState === "保存中…"} onClick={() => { void loadTask(task.id, "refresh"); void loadChannels().catch(() => setMessage("模型配置刷新失败，请稍后重试。")); }} className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-slate-300 transition hover:border-cyan-100/25 hover:text-cyan-100" title="刷新"><RefreshCw className="h-4 w-4" /></button></div></div></header>
    <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 pb-24">
      {message && <Notice text={message} />}
      {saveState === "保存失败，请重新设置" && <button disabled={Boolean(busy)} onClick={() => { for (const patch of saveLedger.current.retryPatches()) void patchTask(patch); }} className="mb-4 rounded-lg border border-rose-200/20 px-4 py-2 text-sm text-rose-100">重试保存未成功的设置</button>}
      {uploadFailures && <button disabled={Boolean(busy)} onClick={() => void upload(uploadFailures.kind, uploadFailures.files)} className="mb-4 rounded-lg border border-rose-200/20 px-4 py-2 text-sm text-rose-100">仅重传失败的 {uploadFailures.files.length} 个文件</button>}
      {activeView === "results"
        ? <ResultsWorkspace task={task} outputs={outputs} completed={completed} failed={failed} asset={asset} busy={busy} hasQueued={hasQueued} onRetry={(includeUncertain, jobId) => void retry(includeUncertain, jobId)} onDuplicate={() => void duplicateTask()} onCancel={() => void cancelQueued()} />
        : <div className="w-full"><WizardProgress task={task} active={setupStep} onChange={setSetupStep} />
            {locked && <div className="mt-4 rounded-lg border border-cyan-100/14 bg-cyan-200/[0.045] px-4 py-3 text-xs leading-5 text-cyan-50/80">内容生产已经开始，本次验收通过的白底图、源素材和模型参数已锁定。生成进度和结果请到“生产结果”查看。</div>}
            {setupStep !== "product" && approvedMaster && <ApprovedMasterBanner master={approvedMaster} locked={locked} onChange={() => void resetMasterApproval()} />}
            <div className="mt-4">
              {setupStep === "product" && <MasterReviewStep task={task} master={master} asset={asset} imageChannels={imageChannels} busy={busy || (saveState === "保存中…" ? "saving" : "")} contentLocked={locked} masterBusy={masterBusy} onPatch={patchTask} onUpload={(kind, files) => void upload(kind, files)} onRemove={(id) => void removeAsset(id)} onGenerate={() => void generateMaster()} onApprove={() => void approveMaster()} onRetryUncertain={() => void retryUncertainMaster()} onResolveImported={() => void resolveMasterWithUpload()} onReset={() => void resetMasterApproval()} onNext={() => setSetupStep("production")} />}
              {setupStep === "production" && <div className="space-y-4">
                <SourcesStep task={task} asset={asset} busy={busy} locked={locked || Boolean(busy) || saveState === "保存中…"} onUpload={(kind, files) => void upload(kind, files)} onRemove={(id) => void removeAsset(id)} onUpdate={(sourceId, patch) => void patchTask({ videoSourceUpdate: { id: sourceId, patch } })} />
                <ModelsStep task={task} asset={asset} imageChannels={imageChannels} videoChannels={videoChannels} locked={locked || Boolean(busy)} onPatch={patchTask} onUpload={(kind, files) => void upload(kind, files)} onRemove={(id) => void removeAsset(id)} onUpdate={(sourceId, patch) => void patchTask({ videoSourceUpdate: { id: sourceId, patch } })} />
                <ReviewStep task={task} master={approvedMaster} imageChannels={imageChannels} videoChannels={videoChannels} plannedVideos={plannedVideos} plannedDetails={plannedDetails} busy={busy || (saveState === "保存中…" ? "saving" : "")} locked={locked} onStart={() => void start()} onResults={() => setActiveView("results")} />
              </div>}
            </div>
            <div className="mt-4"><OutputDirectoryCard taskId={task.id} directory={task.outputDirectory} /></div>
        </div>}
    </div>
  </section>;
}

function TaskLibrary({ summaries, busy, message, onCreate, onOpen, onDelete }: { summaries: TaskSummary[]; busy: string; message: string; onCreate: () => void; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const visible = summaries.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || (filter === "active" ? ["running", "queued"].includes(item.status) : filter === "attention" ? ["failed", "partial", "uncertain"].includes(item.status) : filter === "draft" ? ["draft", "master_review", "ready"].includes(item.status) : item.status === filter)));
  return <section className="luma-product-production flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden rounded-lg border border-cyan-100/14 bg-black/20">
    <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-black text-slate-50">商品生产线</h1><p className="mt-2 text-sm text-slate-300">验收白底图 → 上传视频或详情图 → 确认生产</p></div><button disabled={Boolean(busy)} onClick={onCreate} className="luma-action-button inline-flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-5 text-sm font-bold">{busy === "create" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}新建生产</button></div>
      {message && <div className="mt-4"><Notice text={message} /></div>}
      <div className="mt-6 flex flex-wrap items-center gap-3"><input aria-label="搜索生产任务" placeholder="搜索任务名称" value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/12 bg-black/10 px-3 text-sm text-slate-100" /><div className="w-40"><LumaSelect value={filter} emptyLabel="筛选任务状态" ariaLabel="筛选任务状态" onChange={setFilter} options={[{ value: "all", label: "全部任务" }, { value: "draft", label: "准备 / 待验收" }, { value: "active", label: "排队 / 运行" }, { value: "attention", label: "需处理" }, { value: "done", label: "已完成" }, { value: "cancelled", label: "已取消" }]} /></div></div>
      <div className="mt-4 text-xs text-slate-400">{visible.length} 项任务</div>
      <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.map((item) => {
        const active = ["queued", "running", "uncertain"].includes(item.status);
        return <article key={item.id} className="product-production-card group min-w-0 rounded-lg border border-cyan-100/12 bg-black/18 p-4 text-left hover:border-cyan-200/30">
          <div className="flex min-w-0 items-start gap-3"><button type="button" disabled={Boolean(busy)} onClick={() => onOpen(item.id)} className="min-w-0 flex-1 text-left"><div className="flex min-w-0 gap-3">{item.productMasterUrl ? <img src={item.productMasterUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-slate-950 object-contain" /> : <Factory className="h-10 w-10 shrink-0 text-cyan-100" />}<div className="min-w-0 flex-1"><p className="break-words text-sm font-bold text-slate-100">{item.name}</p><div className="mt-2"><StatusPill status={item.status} /></div><p className="mt-2 text-xs text-slate-300">{item.plannedVideos} 个视频 / {item.detailImages} 张图 · 完成 {item.completedJobs}/{item.totalJobs}</p><p className="mt-2 text-xs text-slate-400">{new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}</p></div></div></button><button type="button" aria-label={`删除任务 ${item.name}`} title={active ? "生产中的任务或待核实任务不能删除" : "删除任务"} disabled={Boolean(busy) || active} onClick={() => onDelete(item.id)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-rose-200/16 bg-rose-300/[0.04] text-rose-100/75 transition hover:border-rose-200/35 hover:bg-rose-300/[0.1] hover:text-rose-50 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-4 w-4" /></button></div>
        </article>;
      })}</div>
      {!visible.length && <div className="mt-4 rounded-lg border border-dashed border-white/15 p-8 text-center text-sm text-slate-300">{summaries.length ? "没有匹配任务，请调整搜索或筛选。" : "还没有生产任务，点击“新建生产”开始。"}</div>}
    </div>
  </section>;
}

function ViewTabs({ active, resultCount, resultsEnabled, onChange }: { active: "setup" | "results"; resultCount: number; resultsEnabled: boolean; onChange: (view: "setup" | "results") => void }) {
  return <div className="product-production-tabs flex h-10 rounded-lg border border-white/10 bg-black/24 p-1"><button onClick={() => onChange("setup")} className={`rounded-md px-3 text-xs font-bold transition ${active === "setup" ? "bg-cyan-200/12 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(165,243,252,0.16)]" : "text-slate-500 hover:text-slate-200"}`}>生产设置</button><button onClick={() => resultsEnabled && onChange("results")} disabled={!resultsEnabled} title={resultsEnabled ? "查看生产结果" : "白底图验收并开始内容生产后可查看"} className={`rounded-md px-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:text-slate-700 ${active === "results" ? "bg-cyan-200/12 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(165,243,252,0.16)]" : "text-slate-500 hover:text-slate-200"}`}>生产结果 <span className="ml-1 text-[10px]">{resultCount}</span></button></div>;
}

function WizardProgress({ task, active, onChange }: { task: Task; active: SetupStep; onChange: (step: SetupStep) => void }) {
  const approved = productReady(task);
  const contentStarted = task.payload.jobs.some((job) => job.kind === "video" || job.kind === "detail");
  return <section className="product-production-progress rounded-lg border border-cyan-100/14 bg-black/18 p-4">
    <p className="mb-3 text-sm text-slate-300">先验收商品白底图，再一次完成素材、模型与生产确认。</p>
    <div className="grid gap-2 md:grid-cols-2">
      <button type="button" onClick={() => onChange("product")} className={`flex min-h-16 items-center gap-3 rounded-lg border px-4 text-left transition ${active === "product" ? "border-cyan-200/35 bg-cyan-200/[0.085]" : "border-white/8 bg-black/14 hover:border-white/14"}`}>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-black ${approved ? "bg-emerald-300/[0.12] text-emerald-200" : "bg-cyan-200 text-slate-950"}`}>{approved ? <Check className="h-4 w-4" /> : "01"}</span>
        <span><span className="block text-sm font-black text-slate-100">制作并验收白底图</span><span className="mt-0.5 block text-xs text-slate-400">{approved ? "已通过，可进入内容生产" : "上传现成图，或用商品图生成"}</span></span>
      </button>
      <button type="button" onClick={() => onChange("production")} disabled={!approved} className={`flex min-h-16 items-center gap-3 rounded-lg border px-4 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${active === "production" ? "border-cyan-200/35 bg-cyan-200/[0.085]" : "border-white/8 bg-black/14 hover:border-white/14"}`}>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-black ${contentStarted ? "bg-emerald-300/[0.12] text-emerald-200" : active === "production" ? "bg-cyan-200 text-slate-950" : "bg-white/[0.045] text-slate-400"}`}>{contentStarted ? <Check className="h-4 w-4" /> : "02"}</span>
        <span><span className="block text-sm font-black text-slate-100">视频与详情图生产</span><span className="mt-0.5 block text-xs text-slate-400">{approved ? "上传原素材、选择模型、确认开始" : "请先验收白底图"}</span></span>
      </button>
    </div>
  </section>;
}

function StepShell({ number, title, desc, children, footer }: { number: string; title: string; desc: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return <section className="product-production-step overflow-hidden rounded-lg border border-white/9 bg-black/20"><div className="product-production-step-header border-b border-white/8 px-5 py-4"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-100/16 bg-cyan-200/[0.055] text-xs font-black text-cyan-100">{number}</span><div><h2 className="text-lg font-black text-slate-50">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-400">{desc}</p></div></div></div><div className="p-5">{children}</div>{footer && <div className="product-production-footer border-t border-white/8 bg-black/18 px-5 py-4">{footer}</div>}</section>;
}

function MasterReviewStep({ task, master, asset, imageChannels, busy, contentLocked, masterBusy, onPatch, onUpload, onRemove, onGenerate, onApprove, onRetryUncertain, onResolveImported, onReset, onNext }: { task: Task; master?: Asset; asset: (id?: string) => Asset | undefined; imageChannels: ImageChannel[]; busy: string; contentLocked: boolean; masterBusy: boolean; onPatch: (patch: Record<string, unknown>) => Promise<Task | null>; onUpload: (kind: AssetKind, files: File[]) => void; onRemove: (id: string) => void; onGenerate: () => void; onApprove: () => void; onRetryUncertain: () => void; onResolveImported: () => void; onReset: () => void; onNext: () => void }) {
  const [previewBackground, setPreviewBackground] = useState<"white" | "gray" | "dark">("dark");
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const sources = task.payload.productSourceAssetIds.map(asset).filter(Boolean) as Asset[];
  const candidates = task.payload.assets.filter((item) => item.kind === "product_master");
  const approved = productReady(task);
  const selectedImageChannel = imageChannels.find((item) => item.id === task.payload.imageChannelId);
  const latestMasterJob = task.payload.jobs.filter((job) => job.kind === "product_master").at(-1);
  const hasUncertainMaster = task.payload.jobs.some((job) => job.kind === "product_master" && job.status === "uncertain");
  const editable = !contentLocked && !masterBusy && !hasUncertainMaster;
  const canImportResult = !contentLocked && !masterBusy && hasUncertainMaster;
  const importedResult = canImportResult && master?.createdAt && latestMasterJob?.finishedAt && Date.parse(master.createdAt) > Date.parse(latestMasterJob.finishedAt);
  const previewClass = previewBackground === "white" ? "bg-white" : previewBackground === "gray" ? "bg-slate-500" : "bg-slate-950";
  const footer = approved
    ? <WizardFooter nextLabel="下一步：准备原素材" nextDisabled={Boolean(busy)} nextIcon={ChevronRight} onNext={onNext} />
    : <WizardFooter nextLabel={hasUncertainMaster ? "请先核实上次提交" : masterBusy ? "正在生成产品白底图" : master ? "验收通过，进入内容生产" : "请先生成或上传白底图"} nextDisabled={!master || masterBusy || hasUncertainMaster || Boolean(busy)} busy={busy === "approve-master" || masterBusy} nextIcon={PackageCheck} onNext={onApprove} />;
  return <StepShell number="01" title="制作并验收产品白底图" desc="这里只处理白底图。必须由你确认通过，系统才会解锁视频和详情图生产。" footer={footer}>
    <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.05fr)]">
      <section className="rounded-lg border border-cyan-100/14 bg-black/22 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><PackageCheck className="h-4 w-4 text-cyan-100" /><h3 className="text-sm font-black text-slate-100">白底图验收区</h3></div><p className="mt-1 text-[11px] leading-5 text-slate-500">检查商品完整度、边缘、颜色、文字和结构是否准确。</p></div><span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${approved ? "border-emerald-200/20 bg-emerald-300/[0.08] text-emerald-200" : master ? "border-amber-200/20 bg-amber-300/[0.07] text-amber-100" : "border-white/10 text-slate-500"}`}>{approved ? "已验收" : master ? "待验收" : masterBusy ? "生成中" : "待准备"}</span></div>
        <div className={`relative mx-auto mt-4 flex aspect-square w-full max-w-[520px] items-center justify-center overflow-hidden rounded-lg border border-white/12 ${previewClass}`}>{master ? <img src={master.publicUrl} alt="待验收产品白底图" className="h-full w-full object-contain" /> : <div className="px-6 text-center"><ImageIcon className="mx-auto h-8 w-8 text-slate-600" /><p className="mt-3 text-sm font-bold text-slate-400">还没有待验收白底图</p><p className="mt-1 text-xs leading-5 text-slate-600">可以直接上传现成白底图，或用 1–3 张商品图生成。</p></div>}</div>
        {master && <div className="mt-3"><ImageInspection image={master} originals={sources} /></div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div className="flex rounded-lg border border-white/9 bg-black/20 p-1">{(["white", "gray", "dark"] as const).map((value) => <button key={value} type="button" onClick={() => setPreviewBackground(value)} className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold ${previewBackground === value ? "bg-cyan-200/12 text-cyan-50" : "text-slate-500"}`}>{value === "white" ? "白底" : value === "gray" ? "灰底" : "深色"}</button>)}</div>{master && !approved && editable && <button type="button" onClick={() => onRemove(master.id)} className="text-xs font-semibold text-slate-500 hover:text-rose-200">移除当前白底图</button>}</div>
        {candidates.length > 1 && <div className="mt-4 border-t border-white/8 pt-4"><p className="text-xs font-bold text-slate-300">历史候选</p><div className="mt-2 flex gap-2 overflow-x-auto pb-1">{candidates.map((candidate, index) => <button key={candidate.id} type="button" disabled={!editable || approved} onClick={() => void onPatch({ productMasterAssetId: candidate.id })} className={`w-20 shrink-0 rounded-lg border p-1.5 text-left ${candidate.id === master?.id ? "border-cyan-200/40 bg-cyan-200/[0.06]" : "border-white/8 bg-black/14"}`}><img src={candidate.publicUrl} alt={`白底图候选 ${index + 1}`} className="aspect-square w-full rounded-md bg-white object-contain" /><span className="mt-1 block text-center text-[10px] text-slate-500">候选 {index + 1}</span></button>)}</div></div>}
        {latestMasterJob?.status === "failed" && <p className="mt-3 rounded-lg border border-rose-200/16 bg-rose-300/[0.05] px-3 py-2 text-[11px] leading-5 text-rose-100">{latestMasterJob.error || "产品白底图生成失败，请检查模型后重新生成。"}</p>}
        {hasUncertainMaster && <div className="mt-3 rounded-lg border border-amber-200/18 bg-amber-300/[0.055] p-3"><p className="text-sm font-bold text-amber-100">上次白底图提交状态待核实</p><p className="mt-1 text-xs leading-5 text-amber-50/75">服务在提交时中断，上游可能已经接单并扣费。请先到模型平台核对。有结果就下载并上传到右侧；确认没有结果时才重新提交。</p>{confirmUncertain ? <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setConfirmUncertain(false)} className="h-9 rounded-lg border border-white/10 px-3 text-xs text-slate-200">先不处理</button><button type="button" onClick={() => { setConfirmUncertain(false); onRetryUncertain(); }} disabled={Boolean(busy)} className="h-9 rounded-lg border border-amber-200/25 bg-amber-300/[0.1] px-3 text-xs font-bold text-amber-50">确认未出图，重新提交</button></div> : <button type="button" onClick={() => setConfirmUncertain(true)} disabled={Boolean(busy)} className="mt-3 h-9 rounded-lg border border-amber-200/25 px-3 text-xs font-bold text-amber-50">处理待核实项</button>}{importedResult && <button type="button" onClick={onResolveImported} disabled={Boolean(busy)} className="mt-3 h-9 rounded-lg border border-emerald-200/25 bg-emerald-300/[0.08] px-3 text-xs font-bold text-emerald-100">已上传上游结果，继续验收</button>}</div>}
      </section>
      <div className="space-y-4"><section className="rounded-lg border border-white/9 bg-black/18 p-4"><div className="flex items-center gap-2"><Upload className="h-4 w-4 text-cyan-100" /><h3 className="text-sm font-black text-slate-100">直接上传现成白底图</h3></div><p className="mt-2 text-xs leading-5 text-slate-500">上传后仍需在左侧验收，不会直接进入内容生产。</p><UploadButton label={master ? "上传另一张现成白底图" : "上传现成白底图"} accept="image/*" onFiles={(files) => onUpload("product_master", files)} busy={busy === "upload:product_master"} prominent disabled={(!editable && !canImportResult) || approved} /></section>
        <section className="rounded-lg border border-violet-100/12 bg-black/18 p-4"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><WandSparkles className="h-4 w-4 text-violet-100" /><h3 className="text-sm font-black text-slate-100">让系统生成白底图</h3></div><p className="mt-2 text-xs leading-5 text-slate-500">上传 1–3 张同款商品图，第一张决定主要展示角度。</p></div><span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-400">{sources.length}/3</span></div><div className="mt-4"><AssetStrip assets={sources} empty="商品正面、侧面或细节图" removable={editable && !approved} onRemove={onRemove} /></div>{sources.length < 3 && <UploadButton label={sources.length ? "继续添加同款商品图" : "选择 1–3 张商品图"} accept="image/*" multiple onFiles={(files) => onUpload("product_source", files)} busy={busy === "upload:product_source"} prominent={!sources.length} disabled={!editable || approved} />}{sources.length > 0 && <div className="mt-4"><p className="mb-2 text-xs font-bold text-slate-300">白底图模型</p>{imageChannels.length ? <LumaSelect value={task.payload.imageChannelId || ""} options={imageChannels.map((item) => ({ value: item.id, label: item.name, detail: item.available ? item.model : `${item.model} · 当前账户未配置凭证` }))} emptyLabel="请选择图片模型" ariaLabel="白底图模型" disabled={!editable || approved} onChange={(value) => void onPatch({ imageChannelId: value })} /> : <ModelEmptyState kind="image" label="白底图生成" />}{imageChannels.length > 0 && <button type="button" onClick={onGenerate} disabled={!editable || approved || !selectedImageChannel?.available || Boolean(busy)} className="luma-action-button mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-black disabled:cursor-not-allowed disabled:opacity-45">{masterBusy || busy === "generate-master" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{master ? "重新生成一张候选" : "生成产品白底图"}</button>}{selectedImageChannel && <p className="mt-2 text-[10px] text-slate-600">本次只调用白底图模型 1 次，生成后停在验收区。</p>}</div>}</section>
        {approved && <section className="rounded-lg border border-emerald-200/18 bg-emerald-300/[0.055] p-4"><p className="text-sm font-black text-emerald-100">这张白底图已经验收通过</p><p className="mt-1 text-xs leading-5 text-emerald-50/65">第二阶段只会使用这张已锁定图片。内容生产开始前仍可解除验收并更换。</p>{!contentLocked && <button type="button" onClick={onReset} disabled={Boolean(busy)} className="mt-3 h-9 w-full rounded-lg border border-emerald-100/16 text-xs font-bold text-emerald-100">更换白底图</button>}</section>}
      </div>
    </div>
  </StepShell>;
}

function ApprovedMasterBanner({ master, locked, onChange }: { master: Asset; locked: boolean; onChange: () => void }) {
  return <section className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200/16 bg-emerald-300/[0.045] px-4 py-3"><img src={master.publicUrl} alt="已验收产品白底图" className="h-14 w-14 rounded-lg border border-white/10 bg-white object-contain" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-200" /><p className="text-sm font-black text-emerald-100">产品白底图已验收并锁定</p></div><p className="mt-1 text-xs text-emerald-50/60">下面的视频和详情图都会使用这一张。</p></div>{!locked && <button type="button" onClick={onChange} className="h-9 rounded-lg border border-emerald-100/16 px-3 text-xs font-bold text-emerald-100">更换白底图</button>}</section>;
}

function SourcesStep({ task, asset, busy, locked, onUpload, onRemove, onUpdate }: { task: Task; asset: (id?: string) => Asset | undefined; busy: string; locked: boolean; onUpload: (kind: AssetKind, files: File[]) => void; onRemove: (id: string) => void; onUpdate: (sourceId: string, patch: Partial<VideoSource>) => void }) {
  return <StepShell number="A" title="上传需要处理的原素材" desc="参考视频用于生成商品视频，详情图用于批量换装。上传其中一类或两类，系统只生产已上传的内容。">
    <div className="grid gap-4 xl:grid-cols-2">
      {includesVideo(task.payload.productionMode) && <section className="rounded-lg border border-cyan-100/12 bg-black/16 p-4"><VideoSources task={task} asset={asset} busy={busy} locked={locked} onUpload={(files) => onUpload("reference_video", files)} onRemove={onRemove} onUpdate={onUpdate} /></section>}
      {includesDetail(task.payload.productionMode) && <section className="rounded-lg border border-violet-100/12 bg-black/16 p-4"><DetailSources task={task} asset={asset} busy={busy} locked={locked} onUpload={(files) => onUpload("detail_image", files)} onRemove={onRemove} /></section>}
    </div>
  </StepShell>;
}

function VideoSources({ task, asset, busy, locked, onUpload, onRemove, onUpdate }: { task: Task; asset: (id?: string) => Asset | undefined; busy: string; locked: boolean; onUpload: (files: File[]) => void; onRemove: (id: string) => void; onUpdate: (sourceId: string, patch: Partial<VideoSource>) => void }) {
  return <div><div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-black text-slate-100">需要照着生成的视频</h3><p className="mt-1 text-xs leading-5 text-slate-500">系统保留拍摄方式、动作和节奏，把视频里的商品换成你的商品。</p></div><span className="rounded-full border border-cyan-100/14 px-2 py-1 text-[10px] text-cyan-100/70">{task.payload.videoSources.length} 条</span></div><UploadButton label={task.payload.videoSources.length ? "继续添加参考视频" : "选择一个或多个参考视频"} accept="video/mp4,video/webm,video/quicktime" multiple onFiles={onUpload} busy={busy === "upload:reference_video"} prominent={!task.payload.videoSources.length} disabled={locked} /><div className="mt-4 space-y-2">{task.payload.videoSources.map((source, index) => { const item = asset(source.assetId); return <div key={source.id} className="flex min-h-14 items-center gap-3 rounded-lg border border-white/9 bg-black/22 px-3 py-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-300/[0.07] text-cyan-100"><Film className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-200">{item?.name || `参考视频 ${index + 1}`}</p><p className="mt-0.5 text-[10px] text-slate-600">参考视频 {String(index + 1).padStart(2, "0")}{item?.durationSeconds ? ` · ${item.durationSeconds.toFixed(1)} 秒` : ""}</p></div><div className="flex items-center gap-2"><span className="mr-1 text-[11px] text-slate-500">生成版本</span><button disabled={locked} onClick={() => onUpdate(source.id, { copies: Math.max(1, source.copies - 1) })} className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-slate-300 disabled:opacity-40">-</button><span className="w-5 text-center text-xs font-black text-slate-100">{source.copies}</span><button disabled={locked} onClick={() => onUpdate(source.id, { copies: Math.min(10, source.copies + 1) })} className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-slate-300 disabled:opacity-40">+</button></div>{!locked && <button onClick={() => onRemove(source.assetId)} className="rounded p-1.5 text-slate-600 hover:text-rose-200" title="移除参考视频"><X className="h-4 w-4" /></button>}</div>; })}{!task.payload.videoSources.length && <CompactEmpty icon={Film} text="上传后，每条视频可以生成 1–10 个版本。" />}</div></div>;
}

function DetailSources({ task, asset, busy, locked, onUpload, onRemove }: { task: Task; asset: (id?: string) => Asset | undefined; busy: string; locked: boolean; onUpload: (files: File[]) => void; onRemove: (id: string) => void }) {
  const detailAssets = task.payload.detailAssetIds.map(asset).filter(Boolean) as Asset[];
  return <div><div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-black text-slate-100">需要换商品的详情图</h3><p className="mt-1 text-xs leading-5 text-slate-500">系统逐张替换商品，并尽量保留原图人物、构图和排版。</p></div><span className="rounded-full border border-violet-100/14 px-2 py-1 text-[10px] text-violet-100/70">{detailAssets.length} 张</span></div><UploadButton label={detailAssets.length ? "继续添加详情图" : "批量选择原详情图"} accept="image/*" multiple onFiles={onUpload} busy={busy === "upload:detail_image"} prominent={!detailAssets.length} disabled={locked} /><div className="mt-4"><AssetStrip assets={detailAssets} empty="可以一次选择多张；方图和横图输出 1:1，竖图输出 9:16。" removable={!locked} onRemove={onRemove} /></div>{detailAssets.length > 0 && <div className="mt-4 grid grid-cols-2 gap-2"><Metric label="已上传原图" value={detailAssets.length} /><Metric label="预计生成新图" value={detailAssets.length} /></div>}</div>;
}

function ModelsStep({ task, asset, imageChannels, videoChannels, locked, onPatch, onUpload, onRemove, onUpdate }: { task: Task; asset: (id?: string) => Asset | undefined; imageChannels: ImageChannel[]; videoChannels: VideoChannel[]; locked: boolean; onPatch: (patch: Record<string, unknown>) => Promise<Task | null>; onUpload: (kind: AssetKind, files: File[]) => void; onRemove: (id: string) => void; onUpdate: (sourceId: string, patch: Partial<VideoSource>) => void }) {
  const imageEnabled = includesDetail(task.payload.productionMode);
  const videoEnabled = includesVideo(task.payload.productionMode);
  const imageRequired = needsImageModel(task);
  const videoRequired = producesVideo(task);
  const requirements = videoModelRequirements(task, videoChannels);
  const selectedVideoChannel = videoChannels.find((item) => item.id === task.payload.videoChannelId);
  return <StepShell number="B" title="选择内容生成模型" desc="按生产目标选择图片和视频模型；未上传素材的类型会在上传后生效。白底图模型不会在这里重复调用。">
    <div className={`grid gap-4 ${imageEnabled && videoEnabled ? "lg:grid-cols-2" : "grid-cols-1"}`}>
      {imageEnabled && <ModelCard icon={ImageIcon} title="详情图模型" required={imageRequired} pending={!imageRequired} note={imageRequired ? "用于批量处理详情图，不会重新生成产品白底图。" : "上传详情图后生效，可提前选好本批图片模型。"}>
        {imageChannels.length > 0
          ? <LumaSelect value={task.payload.imageChannelId || ""} options={imageChannels.map((item) => ({ value: item.id, label: item.name, detail: item.available ? item.model : `${item.model} · 当前账户未配置凭证` }))} emptyLabel="请选择详情图模型" ariaLabel="详情图模型" disabled={locked} onChange={(value) => void onPatch({ imageChannelId: value })} />
          : <ModelEmptyState kind="image" label="详情图生产" />}
      </ModelCard>}
      {videoEnabled && <ModelCard icon={Film} title="默认视频模型" required={videoRequired} pending={!videoRequired} note={videoRequired ? "所有参考视频默认使用它，单条视频可以在下方覆盖。" : "上传参考视频后生效，可提前选好本批视频模型。"}>
        {videoChannels.length > 0 ? <>
          <LumaSelect value={task.payload.videoChannelId || ""} options={videoChannels.map((item) => ({ value: item.id, label: item.name, detail: item.available ? item.model : `${item.model} · 当前账户未配置凭证` }))} emptyLabel="请选择视频模型" ariaLabel="默认视频模型" disabled={locked} onChange={(value) => { const channel = videoChannels.find((item) => item.id === value); void onPatch({ videoChannelId: value, defaultVideoSeconds: channel?.defaultDuration, defaultVideoResolution: channel?.defaultResolution }); }} />
          {selectedVideoChannel && <><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="mb-2 text-xs text-slate-300">默认生成时长</p><LumaSelect value={String(task.payload.defaultVideoSeconds || selectedVideoChannel.defaultDuration)} options={selectedVideoChannel.durationOptions.map((seconds) => ({ value: String(seconds), label: seconds + " 秒" }))} emptyLabel="默认生成时长" ariaLabel="默认生成时长" disabled={locked} onChange={(value) => void onPatch({ defaultVideoSeconds: Number(value) })} /></div><div><p className="mb-2 text-xs text-slate-300">默认清晰度</p><LumaSelect value={task.payload.defaultVideoResolution || selectedVideoChannel.defaultResolution} options={selectedVideoChannel.resolutionOptions.map((resolution) => ({ value: resolution, label: resolution.toUpperCase() }))} emptyLabel="默认清晰度" ariaLabel="默认清晰度" disabled={locked} onChange={(value) => void onPatch({ defaultVideoResolution: value })} /></div></div><div className="mt-3 grid grid-cols-3 gap-2 text-center text-[10px] text-slate-500"><span className="rounded-md border border-white/7 bg-black/14 px-2 py-1.5">人脸{selectedVideoChannel.faceOptional ? "可选" : "必需"}</span><span className="rounded-md border border-white/7 bg-black/14 px-2 py-1.5">场景{selectedVideoChannel.sceneOptional ? "可选" : "必需"}</span><span className="rounded-md border border-white/7 bg-black/14 px-2 py-1.5">{selectedVideoChannel.audioSupported ? "支持音频" : "不支持音频"}</span></div></>}
        </> : <ModelEmptyState kind="video" label="商品视频生产" />}
      </ModelCard>}
    </div>
    {videoRequired && task.payload.videoSources.length > 0 && <details className="group mt-4 rounded-lg border border-white/9 bg-black/16"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5"><div className="flex items-center gap-3"><Settings2 className="h-4 w-4 text-cyan-100/70" /><div><p className="text-sm font-black text-slate-100">为单个视频单独设置</p><p className="mt-0.5 text-xs text-slate-500">模型、生成时长和清晰度默认沿用上方设置。</p></div></div><ChevronDown className="h-4 w-4 text-slate-500 transition group-open:rotate-180" /></summary><div className="space-y-3 border-t border-white/8 p-4">{task.payload.videoSources.map((source, index) => { const sourceAsset = asset(source.assetId); const channel = videoChannels.find((item) => item.id === (source.channelId || task.payload.videoChannelId)); return <div key={source.id} className="rounded-lg border border-white/8 bg-black/18 p-3"><p className="truncate text-xs font-bold text-slate-200">{index + 1}. {sourceAsset?.name || "参考视频"}</p><div className="mt-3 grid gap-2 lg:grid-cols-3"><LumaSelect value={source.channelId || "__default__"} options={[{ value: "__default__", label: "使用默认视频模型", detail: selectedVideoChannel?.name || "尚未选择默认模型" }, ...videoChannels.map((item) => ({ value: item.id, label: item.name, detail: item.available ? item.model : `${item.model} · 当前账户未配置凭证` }))]} emptyLabel="使用默认视频模型" ariaLabel="单视频模型" disabled={locked} onChange={(value) => { const selected = videoChannels.find((item) => item.id === value); onUpdate(source.id, { channelId: value === "__default__" ? null : value, generationSeconds: selected?.defaultDuration ?? null, resolution: selected?.defaultResolution ?? null } as unknown as Partial<VideoSource>); }} /><LumaSelect value={String(source.generationSeconds || task.payload.defaultVideoSeconds || channel?.defaultDuration || "")} options={(channel?.durationOptions || []).map((value) => ({ value: String(value), label: `${value} 秒` }))} emptyLabel="生成时长" ariaLabel="生成时长" disabled={locked || !channel} onChange={(value) => onUpdate(source.id, { generationSeconds: Number(value) })} /><LumaSelect value={source.resolution || task.payload.defaultVideoResolution || channel?.defaultResolution || ""} options={(channel?.resolutionOptions || []).map((value) => ({ value, label: value.toUpperCase() }))} emptyLabel="清晰度" ariaLabel="清晰度" disabled={locked || !channel} onChange={(value) => onUpdate(source.id, { resolution: value as "720p" | "1080p" })} /></div></div>; })}</div></details>}
    {(videoRequired || imageRequired) && <details className="group mt-4 rounded-lg border border-white/9 bg-black/16" open={(requirements.needsFace && !task.payload.faceAssetId) || (requirements.needsScene && !task.payload.sceneAssetId) || requirements.audioUnsupported}><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5"><div className="flex items-center gap-3"><Sparkles className="h-4 w-4 text-violet-100/75" /><div><p className="text-sm font-black text-slate-100">{requirements.needsFace || requirements.needsScene ? "模型要求的补充素材" : "可选增强素材"}</p><p className="mt-0.5 text-xs text-slate-500">{requirements.needsFace || requirements.needsScene ? "当前模型要求补齐标记为必需的素材。" : "需要换脸、指定场景或参考音频时再添加。"}</p></div></div><ChevronDown className="h-4 w-4 text-slate-500 transition group-open:rotate-180" /></summary><div className="grid gap-3 border-t border-white/8 p-4 md:grid-cols-3"><OptionalAsset label={`人脸正面图${requirements.needsFace ? "（必需）" : ""}`} asset={asset(task.payload.faceAssetId)} accept="image/*" disabled={locked} onFiles={(files) => onUpload("face_image", files)} onClear={!locked && task.payload.faceAssetId ? () => onRemove(task.payload.faceAssetId!) : undefined} />{videoRequired && <><OptionalAsset label={`场景参考图${requirements.needsScene ? "（必需）" : ""}`} asset={asset(task.payload.sceneAssetId)} accept="image/*" disabled={locked} onFiles={(files) => onUpload("scene_image", files)} onClear={!locked && task.payload.sceneAssetId ? () => onRemove(task.payload.sceneAssetId!) : undefined} /><OptionalAsset label={requirements.audioUnsupported ? "参考音频（当前不支持）" : "参考音频"} asset={asset(task.payload.audioAssetId)} accept="audio/*" disabled={locked || requirements.audioUnsupported} onFiles={(files) => onUpload("audio", files)} onClear={!locked && task.payload.audioAssetId ? () => onRemove(task.payload.audioAssetId!) : undefined} /></>}</div></details>}
  </StepShell>;
}

function ModelCard({ icon: Icon, title, required, pending = false, note, children }: { icon: typeof Film; title: string; required: boolean; pending?: boolean; note: string; children: React.ReactNode }) {
  return <section className={`rounded-lg border p-4 ${required || pending ? "border-cyan-100/14 bg-cyan-200/[0.025]" : "border-white/8 bg-black/14 opacity-70"}`}><div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.045] text-cyan-100"><Icon className="h-4 w-4" /></span><div><div className="flex items-center gap-2"><h3 className="text-sm font-black text-slate-100">{title}</h3><span className="text-[10px] text-slate-500">{required ? "必选" : pending ? "上传后生效" : "无需选择"}</span></div><p className="mt-0.5 text-[11px] text-slate-500">{note}</p></div></div><div className="mt-4">{children}</div></section>;
}

function ModelEmptyState({ kind, label }: { kind: "image" | "video"; label: string }) {
  const modelLabel = kind === "image" ? "图片模型" : "视频模型";
  return <div className="rounded-lg border border-amber-200/18 bg-amber-300/[0.055] px-3 py-3.5"><div className="flex items-start gap-3"><span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-amber-100/20 bg-amber-200/[0.08] text-amber-100"><Settings2 className="h-3.5 w-3.5" /></span><div className="min-w-0"><p className="text-sm font-bold text-amber-50">暂无可用{modelLabel}</p><p className="mt-1 text-xs leading-5 text-amber-100/70">{label}需要先配置并启用{modelLabel}，当前任务暂时无法选择。</p><a href="/settings" className="mt-2 inline-flex text-xs font-bold text-cyan-100 underline decoration-cyan-100/30 underline-offset-4 hover:text-cyan-50">前往“模型与 API”配置</a></div></div></div>;
}

function ReviewStep({ task, master, imageChannels, videoChannels, plannedVideos, plannedDetails, busy, locked, onStart, onResults }: { task: Task; master?: Asset; imageChannels: ImageChannel[]; videoChannels: VideoChannel[]; plannedVideos: number; plannedDetails: number; busy: string; locked: boolean; onStart: () => void; onResults: () => void }) {
  const configError = videoConfigError(task, videoChannels);
  const modelOptionsError = needsImageModel(task) && imageChannels.length === 0
    ? "当前没有可用图片模型，请先到“模型与 API”配置并启用图片通道。"
    : producesVideo(task) && videoChannels.length === 0
      ? "当前没有可用视频模型，请先到“模型与 API”配置并启用视频通道。"
      : "";
  const ready = productReady(task) && sourcesReady(task) && allModelInputsReady(task, imageChannels, videoChannels) && !configError && !modelOptionsError;
  const imageChannel = producesDetail(task) ? imageChannels.find((item) => item.id === task.payload.imageChannelId) : undefined;
  const actualVideoModels = producesVideo(task) ? task.payload.videoSources.map((source) => videoChannels.find((item) => item.id === (source.channelId || task.payload.videoChannelId))) : [];
  const totalCalls = plannedVideos + plannedDetails;
  const contentLabel = plannedVideos && plannedDetails ? "商品视频 + 详情图" : plannedVideos ? "商品视频" : plannedDetails ? "详情图换装" : "未选择生产内容";
  const requirements = videoModelRequirements(task, videoChannels);
  const missing = configError || modelOptionsError || (!productReady(task) ? "请先验收产品白底图" : !sourcesReady(task) ? "还需上传参考视频或详情图" : !modelsReady(task) ? "还需选择模型" : requirements.needsFace && !task.payload.faceAssetId ? "还需上传人脸正面图" : requirements.needsScene && !task.payload.sceneAssetId ? "还需上传场景参考图" : requirements.audioUnsupported ? "请移除不兼容的参考音频" : !ready ? "所选模型当前不可用，请更换或配置凭证" : "确认并开始内容生产");
  return <StepShell number="C" title="确认并开始生产" desc="核对本次产出与预计模型调用次数。开始后锁定本次素材和参数。" footer={<WizardFooter nextLabel={locked ? "查看生产结果" : missing} nextDisabled={!locked && (!ready || Boolean(busy))} nextIcon={locked ? ChevronRight : Factory} busy={busy === "start"} onNext={locked ? onResults : onStart} />}>
    {(configError || modelOptionsError) && !locked && <Notice text={configError || modelOptionsError} />}
    <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]"><div className="mx-auto w-full max-w-[220px] rounded-lg border border-emerald-200/14 bg-emerald-300/[0.035] p-3 lg:mx-0 lg:max-w-none"><div className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-200" /><p className="text-xs font-bold text-emerald-100">已验收产品白底图</p></div>{master ? <img src={master.publicUrl} alt="本次已验收商品" className="mt-3 aspect-square w-full rounded-lg border border-white/10 bg-white object-contain" /> : <div className="mt-3 flex aspect-square items-center justify-center rounded-lg border border-dashed border-rose-200/16 px-4 text-center text-xs leading-5 text-rose-200">白底图验收状态异常</div>}</div><div className="space-y-3"><ReviewRow label="生产内容" value={contentLabel} detail={`${plannedVideos} 个视频 / ${plannedDetails} 张详情图`} /><ReviewRow label="原素材" value={`${task.payload.videoSources.length} 条参考视频，${task.payload.detailAssetIds.length} 张详情图`} detail={task.payload.faceAssetId ? "已添加人脸正面图" : "未添加人脸增强素材"} /><ReviewRow label="内容模型" value={[imageChannel?.name, ...actualVideoModels.map((item) => item?.name)].filter(Boolean).filter((value, index, items) => items.indexOf(value) === index).join(" / ") || "尚未选择"} detail={task.payload.videoSources.map((source, index) => (index + 1) + ". " + (actualVideoModels[index]?.name || "未选择") + " · " + (source.generationSeconds || task.payload.defaultVideoSeconds || actualVideoModels[index]?.defaultDuration || "未选") + " 秒 / " + (source.resolution || task.payload.defaultVideoResolution || actualVideoModels[index]?.defaultResolution || "未选") + " × " + source.copies + " 份").join("；")} /><div className="rounded-lg border border-cyan-100/16 bg-cyan-200/[0.045] px-4 py-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-cyan-50">预计内容模型调用</p><p className="mt-1 text-[11px] text-cyan-100/55">视频 {plannedVideos} 次 + 详情图 {plannedDetails} 次；不再调用白底图模型</p></div><span className="text-2xl font-black text-cyan-50">{totalCalls}</span></div></div></div></div>
  </StepShell>;
}

function ReviewRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-lg border border-white/8 bg-black/18 px-4 py-3"><div className="grid gap-1 sm:grid-cols-[110px_minmax(0,1fr)]"><p className="text-xs text-slate-500">{label}</p><div><p className="text-sm font-bold text-slate-100">{value}</p>{detail && <p className="mt-1 text-[11px] text-slate-500">{detail}</p>}</div></div></div>;
}

function WizardFooter({ backLabel, nextLabel, nextDisabled, busy, nextIcon: NextIcon = ChevronRight, onBack, onNext }: { backLabel?: string; nextLabel: string; nextDisabled?: boolean; busy?: boolean; nextIcon?: typeof ChevronRight; onBack?: () => void; onNext: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3">{onBack ? <button onClick={onBack} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-4 text-xs font-bold text-slate-300 hover:border-white/18"><ArrowLeft className="h-4 w-4" />{backLabel || "上一步"}</button> : <span />}<button onClick={onNext} disabled={nextDisabled} className="luma-action-button inline-flex max-w-full min-h-11 whitespace-normal py-2 text-left items-center justify-center gap-2 rounded-lg px-5 text-sm font-black disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.035] disabled:text-slate-500 disabled:shadow-none">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <NextIcon className="h-4 w-4" />}{nextLabel}</button></div>;
}

function ResultsWorkspace({ task, outputs, completed, failed, asset, busy, hasQueued, onRetry, onCancel, onDuplicate }: { task: Task; outputs: Array<{ job: Job; output?: Asset; source?: Asset }>; completed: number; failed: number; asset: (id?: string) => Asset | undefined; busy: string; hasQueued: boolean; onRetry: (includeUncertain?: boolean, jobId?: string) => void; onCancel: () => void; onDuplicate: () => void }) {
  const [kind, setKind] = useState<"video" | "detail">(task.payload.jobs.some((job) => job.kind === "video") ? "video" : "detail");
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const contentJobs = task.payload.jobs.filter((job) => job.kind !== "product_master");
  const running = contentJobs.filter((job) => ["submitting", "running"].includes(job.status)).length;
  const queued = contentJobs.filter((job) => ["waiting", "queued"].includes(job.status)).length;
  const uncertain = contentJobs.filter((job) => job.status === "uncertain").length;
  const cancelled = contentJobs.filter((job) => job.status === "cancelled").length;
  const visibleOutputs = outputs.filter(({ job }) => job.kind === kind);
  const visibleJobs = contentJobs.filter((job) => job.kind === kind);
  const sourceIds = Array.from(new Set(visibleOutputs.map(({ job }) => job.sourceAssetId)));
  const [observedAt, setObservedAt] = useState(() => Date.now());
  const active = running + queued > 0;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setObservedAt(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, [active]);
  return <div className="w-full space-y-4">
    <section className="rounded-lg border border-cyan-100/14 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-black text-slate-50">生产结果</h2><p className="mt-1 text-xs text-slate-400">每账户最多同时执行 2 项，其余排队。结果按原素材分组保存。</p></div>
        <button disabled={Boolean(busy)} onClick={onDuplicate} className="min-h-10 rounded-lg border border-cyan-100/20 px-3 text-sm font-bold text-cyan-100">沿用白底图新建一批</button>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 lg:grid-cols-6">
        <Metric label="排队" value={queued} /><Metric label="执行中" value={running} /><Metric label="完成" value={completed} /><Metric label="失败" value={failed} /><Metric label="待核实" value={uncertain} /><Metric label="已取消" value={cancelled} />
      </div>
      <p className="mt-3 text-xs text-slate-400">任务更新：{new Date(task.updatedAt).toLocaleString("zh-CN", { hour12: false })}</p>
    </section>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
      <section className="min-w-0 rounded-lg border border-white/9 bg-black/20 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex h-10 rounded-lg border border-white/10 bg-black/20 p-1">
            {contentJobs.some((job) => job.kind === "video") && <ResultTab active={kind === "video"} label="视频" count={outputs.filter(({ job }) => job.kind === "video").length} onClick={() => setKind("video")} />}
            {contentJobs.some((job) => job.kind === "detail") && <ResultTab active={kind === "detail"} label="详情图" count={outputs.filter(({ job }) => job.kind === "detail").length} onClick={() => setKind("detail")} />}
          </div>
          {visibleOutputs.length > 0 && <a href={'/api/product-production/' + encodeURIComponent(task.id) + '/download?kind=' + kind} download className="rounded-lg border border-cyan-100/16 px-3 py-2 text-sm font-bold text-cyan-100">打包下载 {visibleOutputs.length} 项</a>}
        </div>
        {sourceIds.map((sourceId) => <div key={sourceId || "unknown"} className="mb-5">
          <h3 className="mb-3 break-all text-sm font-bold text-slate-200">{asset(sourceId)?.name || "原素材"}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleOutputs.filter(({ job }) => job.sourceAssetId === sourceId).map(({ job, output }) => <div key={job.id} className="overflow-hidden rounded-lg border border-cyan-100/12 bg-black/20">
            {job.kind === "video" ? <video src={output!.publicUrl} preload="metadata" controls className="aspect-[9/16] max-h-[460px] w-full bg-black object-contain" /> : <img src={output!.publicUrl} alt={output!.name} className="aspect-square w-full bg-black object-contain" />}
            <div className="p-3"><p className="break-all text-sm font-bold text-slate-100">{output!.name}</p><p className="mt-1 text-xs text-slate-400">{job.channelSnapshot?.name || job.channelId}{job.generationSeconds ? ' · ' + job.generationSeconds + ' 秒 / ' + job.resolution : ''}</p>
              {output!.width && <p className="mt-1 text-xs text-slate-400">{output!.width}×{output!.height}{output!.durationSeconds ? ' · 实际 ' + output!.durationSeconds.toFixed(2) + ' 秒' : ''}</p>}
              <a href={output!.publicUrl + "?download=1"} download className="mt-3 inline-flex rounded-md border border-cyan-100/14 px-3 py-2 text-xs font-bold text-cyan-100">下载结果</a>
            </div>
          </div>)}</div>
        </div>)}
        {!visibleOutputs.length && <CompactEmpty icon={kind === "video" ? Film : Images} text={resultEmptyMessage(visibleJobs, kind === "video" ? "视频" : "详情图")} />}
      </section>
      <aside className="space-y-3 xl:sticky xl:top-0 xl:self-start">
        <section className="rounded-lg border border-cyan-100/14 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-100">执行明细</h3><StatusPill status={task.status} /></div>
          <div className="mt-3 max-h-[540px] space-y-3 overflow-y-auto pr-1">{visibleJobs.map((job) => <div key={job.id} className="rounded-lg border border-white/8 bg-black/18 p-3">
            <div className="flex items-start justify-between gap-2"><p className="min-w-0 break-all text-xs font-bold text-slate-200">{asset(job.sourceAssetId)?.name || "原素材"}{job.variantIndex ? ' · 版本 ' + job.variantIndex : ''}</p><StatusPill status={job.status} /></div>
            <p className="mt-2 text-xs text-slate-400">{job.channelSnapshot?.name || job.channelId}{job.generationSeconds ? ' · ' + job.generationSeconds + ' 秒 / ' + job.resolution : ''}</p>
            {job.startedAt && <p className="mt-1 text-xs text-slate-400">{job.finishedAt ? "结束" : job.remoteTaskId ? "等待模型回传" : "校验 / 准备 / 提交"} · 已耗时 {Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : observedAt) - Date.parse(job.startedAt)) / 1000))} 秒</p>}
            {job.error && <p className={'mt-2 break-words text-xs leading-5 ' + (job.status === "cancelled" ? "text-slate-400" : "text-rose-200")}>{job.error}</p>}
            {job.referenceTransport === "lingganya_file_id" && <p className="mt-1 text-xs text-slate-400">累计已上传 {job.referenceUploadCount || 0} 个临时参考，由模型平台自动失效。{job.referenceExpiresAt && <span>最早截止：{new Date(job.referenceExpiresAt).toLocaleString("zh-CN", { hour12: false })}。</span>}</p>}
            {job.cleanup && <p className="mt-1 text-xs text-slate-400">{job.cleanup.status === "confirmed" ? "临时参考清理已确认" : "临时参考清理未完全确认"}</p>}
            {job.status === "failed" && <button disabled={Boolean(busy)} onClick={() => onRetry(false, job.id)} className="mt-2 rounded-lg border border-rose-200/20 px-3 py-2 text-xs font-bold text-rose-100">{job.remoteTaskId ? "恢复查询 / 回收结果" : "重试此项"}</button>}
          </div>)}</div>
          {uncertain > 0 && <div className="mt-3 rounded-lg border border-amber-200/18 bg-amber-300/[0.055] p-3">
            <p className="text-sm font-bold text-amber-100">有 {uncertain} 项提交状态待核实</p><p className="mt-2 text-xs leading-5 text-amber-100">上游可能已接单并计费。先核对模型平台结果，确认没有结果后再重新提交。</p>
            {confirmUncertain ? <div className="mt-3 flex flex-wrap gap-2"><button onClick={() => setConfirmUncertain(false)} className="rounded-lg border border-white/10 px-3 py-2 text-xs">先不处理</button><button disabled={Boolean(busy)} onClick={() => { setConfirmUncertain(false); onRetry(true); }} className="rounded-lg border border-amber-200/25 px-3 py-2 text-xs font-bold text-amber-100">确认未出片，重新提交</button></div> : <button disabled={Boolean(busy)} onClick={() => setConfirmUncertain(true)} className="mt-3 rounded-lg border border-amber-200/20 px-3 py-2 text-xs font-bold text-amber-100">处理待核实项</button>}
          </div>}
          {failed > 0 && <button onClick={() => onRetry(false)} disabled={Boolean(busy)} className="mt-3 min-h-10 w-full rounded-lg border border-rose-200/20 text-xs font-bold text-rose-100">重试全部失败项</button>}
          {hasQueued && <button onClick={onCancel} disabled={Boolean(busy)} className="mt-2 min-h-10 w-full rounded-lg border border-white/10 text-xs text-slate-200">停止未提交项</button>}
        </section>
        <OutputDirectoryCard taskId={task.id} directory={task.outputDirectory} />
      </aside>
    </div>
  </div>;
}

function OutputDirectoryCard({ taskId, directory }: { taskId: string; directory: string }) {
  const [action, setAction] = useState<"" | "opening" | "opened" | "copied" | "failed">("");
  const [error, setError] = useState("");

  async function openDirectory() {
    if (action === "opening") return;
    setAction("opening");
    setError("");
    try {
      await responseJson(await fetch(`/api/product-production/${encodeURIComponent(taskId)}/open-output`, { method: "POST" }));
      setAction("opened");
    } catch (reason) {
      setAction("failed");
      setError(reason instanceof Error ? reason.message : "打开输出目录失败。");
    }
  }

  async function copyDirectory() {
    try {
      await copyText(directory);
      setError("");
      setAction("copied");
    } catch (reason) {
      setAction("failed");
      setError(reason instanceof Error ? reason.message : "复制输出路径失败。");
    }
  }

  return <section className="rounded-lg border border-cyan-100/14 bg-black/18 p-4"><div className="flex items-center gap-2"><FolderOpen className="h-4 w-4 text-cyan-100" /><h3 className="text-sm font-black text-slate-100">输出位置</h3></div><p className="mt-2 text-[11px] leading-5 text-slate-400">视频、详情图和自动生成的产品白底图都会保存到这里。</p><p className="mt-3 break-all rounded-lg border border-white/8 bg-black/22 px-3 py-2 font-mono text-[11px] leading-5 text-cyan-50/80" title={directory}>{directory}</p><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => void openDirectory()} disabled={action === "opening"} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-cyan-100/16 bg-cyan-200/[0.055] text-xs font-bold text-cyan-50 disabled:cursor-wait disabled:opacity-60">{action === "opening" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}{action === "opening" ? "正在打开" : "打开文件夹"}</button><button type="button" onClick={() => void copyDirectory()} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.025] text-xs font-bold text-slate-300">{action === "copied" ? <Check className="h-3.5 w-3.5 text-emerald-200" /> : <Copy className="h-3.5 w-3.5" />}{action === "copied" ? "已复制" : "复制路径"}</button></div>{action === "opened" && <p className="mt-2 text-[11px] text-emerald-200">已打开当前任务的输出文件夹。</p>}{error && <p className="mt-2 text-[11px] leading-5 text-rose-200">{error}</p>}</section>;
}

function ResultTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return <button onClick={onClick} className={`rounded-md px-3 text-xs font-bold transition ${active ? "bg-cyan-200/12 text-cyan-50" : "text-slate-500 hover:text-slate-200"}`}>{label}<span className="ml-1.5 text-[10px]">{count}</span></button>;
}

function Notice({ text }: { text: string }) { return <div className="mb-4 rounded-lg border border-cyan-100/18 bg-cyan-200/[0.055] px-3 py-2.5 text-xs text-cyan-50">{text}</div>; }
function ImageInspection({ image, originals }: { image: Asset; originals: Asset[] }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [originalId, setOriginalId] = useState(originals[0]?.id || "");
  const original = originals.find((item) => item.id === originalId) || originals[0];
  function close() {
    setOpen(false);
    setZoom(100);
  }
  const panels = [original, image].filter(Boolean) as Asset[];
  return <>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setOpen(true)} className="min-h-10 rounded-lg border border-cyan-100/20 px-3 text-sm font-bold text-cyan-100">
        放大验收{originals.length ? " / 原图对比" : ""}
      </button>
      <a href={image.publicUrl + "?download=1"} download className="min-h-10 rounded-lg border border-white/12 px-3 py-2 text-sm text-slate-200">下载白底图</a>
    </div>
    <Dialog open={open} onOpenChange={(nextOpen) => nextOpen ? setOpen(true) : close()}>
      <DialogContent
        showCloseButton={false}
        aria-label="产品白底图放大验收"
        className="h-[min(960px,calc(100dvh-1rem))] w-[calc(100vw-1rem)] !max-w-[calc(100vw-1rem)] gap-0 overflow-hidden border border-cyan-100/20 !bg-[#061019]/[0.97] p-0 text-slate-100 shadow-[0_30px_100px_rgba(0,0,0,0.64)] backdrop-blur-2xl sm:!max-w-[760px] lg:!max-w-[980px]"
      >
        <div className="flex h-full min-h-0 flex-col">
          <DialogHeader className="shrink-0 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle className="text-lg font-black text-slate-50">白底图放大验收</DialogTitle>
                <DialogDescription className="mt-1 text-sm leading-5 text-slate-300/80">对比原商品图，检查商品边缘、颜色、文字和结构是否准确。</DialogDescription>
              </div>
              <button type="button" onClick={close} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 text-sm font-bold text-slate-200 transition hover:border-cyan-100/30 hover:bg-cyan-200/[0.08] hover:text-cyan-50">
                <X className="h-4 w-4" />关闭
              </button>
            </div>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-end gap-4 border-b border-white/8 bg-black/16 px-5 py-3 sm:px-6">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1.5 text-xs font-bold text-slate-300">
              <span className="flex items-center justify-between gap-3"><span>预览比例</span><span className="text-cyan-100">{zoom}%</span></span>
              <input aria-label="图片放大比例" type="range" min={100} max={300} step={25} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-full accent-cyan-200" />
            </label>
            {originals.length > 1 && <div className="w-full min-w-0 sm:w-[min(22rem,42vw)]"><p className="mb-1.5 text-xs font-bold text-slate-300">对比原图</p><LumaSelect value={original?.id || ""} options={originals.map((item, index) => ({ value: item.id, label: `原商品图 ${index + 1} · ${item.name}` }))} emptyLabel="选择原商品图" ariaLabel="对比原商品图" onChange={setOriginalId} /></div>}
          </div>
          <div className={`grid min-h-0 flex-1 auto-rows-fr gap-4 overflow-hidden p-4 sm:p-5 ${panels.length > 1 ? "lg:grid-cols-2" : "grid-cols-1"}`}>
            {panels.map((item) => {
              const isMaster = item.id === image.id;
              return <section key={item.id} className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-white/12 bg-black/18">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5"><div className="min-w-0"><p className="text-sm font-black text-slate-100">{isMaster ? "待验收白底图" : "原商品图"}</p><p className="mt-0.5 truncate text-xs text-slate-400" title={item.name}>{item.name}</p></div><span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-bold ${isMaster ? "border-amber-200/25 bg-amber-300/[0.08] text-amber-100" : "border-cyan-100/18 bg-cyan-200/[0.06] text-cyan-100"}`}>{isMaster ? "待验收" : "对比参考"}</span></div>
                <div className="product-production-inspection-canvas min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-950/80 p-3"><div className="flex w-full items-start justify-center" style={{ minHeight: `${zoom}%` }}><img src={item.publicUrl} alt={item.name} style={{ transform: `scale(${zoom / 100})`, transformOrigin: "center top" }} className="block h-auto w-full max-w-full object-contain" /></div></div>
              </section>;
            })}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-cyan-100/10 bg-black/20 px-5 py-3 sm:px-6"><p className="text-sm leading-5 text-slate-300">确认无误后关闭此窗口，再点击“验收通过”解锁内容生产。</p><span className="text-xs text-slate-500">仅查看，不会修改原图</span></div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="min-w-20 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2 text-center"><p className="text-[10px] text-slate-500">{label}</p><p className="mt-0.5 text-lg font-black text-slate-100">{value}</p></div>; }
function StatusPill({ status }: { status: string }) { return <span className="shrink-0 rounded-full border border-cyan-100/18 bg-cyan-200/[0.065] px-2.5 py-1 text-[11px] font-semibold text-cyan-100">{statusText[status] || status}</span>; }
function CompactEmpty({ icon: Icon, text }: { icon: typeof Film; text: string }) { return <div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-white/9 bg-black/10 px-4 text-center text-xs leading-5 text-slate-500"><Icon className="h-4 w-4 shrink-0 text-slate-600" />{text}</div>; }
export function UploadButton({ label, accept, multiple, onFiles, busy, prominent, disabled }: { label: string; accept: string; multiple?: boolean; onFiles: (files: File[]) => void; busy?: boolean; prominent?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" className="hidden" aria-label={label + "文件选择器"} accept={accept} multiple={multiple} disabled={disabled || busy} onChange={(event) => { onFiles(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /><button type="button" disabled={disabled || busy} onClick={() => input.current?.click()} className={`${prominent ? "mt-4 flex min-h-14 w-full justify-center border-dashed bg-cyan-200/[0.06] text-cyan-50" : "mt-3 inline-flex min-h-10 bg-cyan-200/[0.045] text-cyan-100"} items-center gap-2 rounded-lg border border-cyan-100/18 px-3 py-2 text-xs font-bold transition ${disabled || busy ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:border-cyan-100/30 hover:bg-cyan-200/[0.09]"}`}>{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{label}</button></>;
}
function RemoveButton({ onClick }: { onClick: () => void }) { return <button onClick={onClick} className="absolute right-1 top-1 rounded-md border border-white/10 bg-black/75 p-1 text-slate-300 hover:text-rose-200" title="移除素材"><X className="h-3.5 w-3.5" /></button>; }
function AssetStrip({ assets, empty, removable, onRemove }: { assets: Asset[]; empty: string; removable?: boolean; onRemove?: (id: string) => void }) {
  if (!assets.length) return <CompactEmpty icon={ImageIcon} text={empty} />;
  return <div className="flex gap-2 overflow-x-auto pb-1">{assets.map((item) => <div key={item.id} className="relative w-20 shrink-0"><img src={item.publicUrl} alt={item.name} className="h-20 w-20 rounded-lg border border-white/10 bg-black object-cover" />{removable && onRemove && <RemoveButton onClick={() => onRemove(item.id)} />}<p className="mt-1 truncate text-[10px] text-slate-500">{item.name}</p></div>)}</div>;
}
function OptionalAsset({ label, asset, accept, disabled, onFiles, onClear }: { label: string; asset?: Asset; accept: string; disabled?: boolean; onFiles: (files: File[]) => void; onClear?: () => void }) {
  return <div className="rounded-lg border border-white/9 bg-black/18 p-3"><div className="flex items-center gap-2">{asset?.mimeType.startsWith("image/") ? <img src={asset.publicUrl} alt="" className="h-10 w-10 rounded-md object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.035]"><ImageIcon className="h-4 w-4 text-violet-200" /></span>}<div className="min-w-0 flex-1"><p className="text-xs font-bold text-slate-200">{label}</p><p className="mt-0.5 truncate text-[10px] text-slate-500">{asset?.name || "未选择"}</p></div>{onClear && <button onClick={onClear} className="rounded p-1 text-slate-500 hover:text-rose-200" title="清除"><X className="h-3.5 w-3.5" /></button>}</div><UploadButton label={asset ? "替换" : "选择"} accept={accept} disabled={disabled} onFiles={onFiles} /></div>;
}

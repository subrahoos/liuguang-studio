"use client";

/* eslint-disable @next/next/no-img-element -- Private local identity images use authenticated API URLs. */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, Check, ChevronDown, ChevronUp, Copy, Download, FolderOpen, Image as ImageIcon, Layers3, LockKeyhole, RefreshCw, Save, Sparkles, Trash2, UserRound, UserRoundPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ModelChannelSelect } from "@/components/model-channel-select";
import { useWorkspaceEmbed } from "@/components/workspace-embed-context";
import {
  getActiveImageChannel,
  getReadyImageChannels,
  useSettingsStore,
  type ImageModelChannel,
} from "@/lib/stores/settings-store";

type ReferenceStatus = "draft" | "approved" | "archived";
type ReferenceGroup = "source" | "base" | "camera" | "expression";
type AuxiliaryAssetKind = "expression_sheet" | "base_multiview_sheet" | "camera_pose_sheet" | "custom_sheet";
type AuxiliaryAssetLayout = "portrait" | "full_body" | "mixed";
type WorkspaceStage = ReferenceGroup | "assets";

interface IdentityReference {
  id: string;
  title: string;
  role: string;
  url: string;
  requiredFor: string[];
  generated?: boolean;
  createdAt?: string;
  sourceKind?: string;
  group: ReferenceGroup;
  status: ReferenceStatus;
  aspectRatio?: "3:4" | "9:16";
  generationTiming?: GenerationTiming;
}

interface IdentityAuxiliaryAssetPanel {
  referenceId: string;
  title: string;
  role: string;
  group: ReferenceGroup;
  sourceKind?: string;
  label: string;
  order: number;
}

interface IdentityAuxiliaryAsset {
  id: string;
  title: string;
  role: string;
  url: string;
  kind: AuxiliaryAssetKind;
  layout: AuxiliaryAssetLayout;
  panels: IdentityAuxiliaryAssetPanel[];
  createdAt: string;
  updatedAt: string;
}

interface GenerationTiming {
  upstreamProcessingMs?: number;
  resultTransferMs?: number;
  localSaveMs?: number;
  totalMs?: number;
  responseBodyBytes?: number;
}

interface IdentityPack {
  id: string;
  packName: string;
  description: string;
  identityLock: string;
  identityPerformanceBaseline: string;
  references: IdentityReference[];
  auxiliaryAssets: IdentityAuxiliaryAsset[];
  sourceReferenceId: string;
}

interface IdentityPendingResult {
  id: string;
  packId: string;
  kind: string;
  title: string;
  role: string;
  sourceKind: string;
  group: ReferenceGroup;
  aspectRatio: "3:4" | "9:16";
  requiredFor: string[];
  taskId?: string;
  modelId?: string;
  transport: "b64_json" | "url";
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  generationTiming?: GenerationTiming;
}

type GenerateKind =
  | "face_front" | "full_body_front" | "full_body_left_45" | "full_body_right_45" | "full_body_side" | "full_body_back"
  | "camera_eye_level" | "camera_high_angle" | "camera_low_angle"
  | "expression_neutral" | "expression_smile" | "expression_bright_smile" | "expression_turn_back" | "expression_gesture" | "expression_walk";

const generationGroups: Array<{ id: Exclude<ReferenceGroup, "source">; title: string; description: string; kinds: Array<{ value: GenerateKind; label: string }> }> = [
  {
    id: "base",
    title: "数字人白底定型组",
    description: "先锁定同一人的脸部、全身比例与前后左右视角。整组生成后逐张验收。",
    kinds: [
      { value: "face_front", label: "人脸正面" }, { value: "full_body_front", label: "全身正面" },
      { value: "full_body_left_45", label: "左45度（左肩近镜）" }, { value: "full_body_right_45", label: "右45度（右肩近镜）" },
      { value: "full_body_side", label: "全身侧面" }, { value: "full_body_back", label: "全身背面" },
    ],
  },
  {
    id: "camera",
    title: "镜头适配校准组",
    description: "在白底定型图验收后生成，处理平视、轻俯视和轻仰视的镜头一致性。",
    kinds: [
      { value: "camera_eye_level", label: "平视半身" }, { value: "camera_high_angle", label: "轻俯视半身" }, { value: "camera_low_angle", label: "轻仰视全身" },
    ],
  },
  {
    id: "expression",
    title: "表情与口型校准组",
    description: "用于数字人的六种表达状态参考；每次只使用已通过的人脸正面定型图，不创建声音档案。",
    kinds: [
      { value: "expression_neutral", label: "亲和开场" }, { value: "expression_smile", label: "热情分享" },
      { value: "expression_bright_smile", label: "专注讲解" }, { value: "expression_turn_back", label: "卖点强调" },
      { value: "expression_gesture", label: "互动疑问" }, { value: "expression_walk", label: "惊喜反应" },
    ],
  },
];

const workspaceStages: Array<{ id: WorkspaceStage; index: string; title: string; description: string }> = [
  { id: "source", index: "01", title: "身份来源", description: "人物脸部来源图" },
  { id: "base", index: "02", title: "白底定型", description: "6 张比例与视角" },
  { id: "camera", index: "03", title: "镜头适配", description: "3 张镜头校准" },
  { id: "expression", index: "04", title: "表情口型", description: "6 张面部校准" },
  { id: "assets", index: "05", title: "辅助资产", description: "本地组合参考板" },
];

const auxiliaryAssetKinds: Array<{ value: AuxiliaryAssetKind; label: string; description: string; defaultTitle: string }> = [
  { value: "expression_sheet", label: "表情口型故事板", description: "仅组合已通过的表情口型图，作为可选表情辅助参考。", defaultTitle: "表情口型故事板" },
  { value: "base_multiview_sheet", label: "白底多视角板", description: "仅组合白底定型图，锁定全身比例与前后左右视角。", defaultTitle: "人物白底多视角板" },
  { value: "camera_pose_sheet", label: "镜头姿态板", description: "仅组合镜头适配图，说明人物与镜头的角度关系。", defaultTitle: "镜头姿态参考板" },
  { value: "custom_sheet", label: "自定义组合板", description: "从白底定型、镜头适配和表情口型中手动选择。", defaultTitle: "自定义组合参考板" },
];

function channelLabel(channel: ImageModelChannel) {
  return channel.name || channel.model || channel.id;
}

function formatElapsed(milliseconds?: number) {
  if (milliseconds === undefined || milliseconds === null || !Number.isFinite(milliseconds)) return "--";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function formatBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timingSummary(timing?: GenerationTiming) {
  if (!timing) return "";
  const parts = [
    `上游处理 ${formatElapsed(timing.upstreamProcessingMs)}`,
    `结果回传 ${formatElapsed(timing.resultTransferMs)}`,
    `本地保存 ${formatElapsed(timing.localSaveMs)}`,
    `总计 ${formatElapsed(timing.totalMs)}`,
  ];
  const size = formatBytes(timing.responseBodyBytes);
  return size ? `${parts.join(" · ")} · 回传 ${size}` : parts.join(" · ");
}

function statusLabel(status: ReferenceStatus) {
  return status === "approved" ? "已通过" : status === "archived" ? "已归档" : "待验收";
}

function statusClass(status: ReferenceStatus) {
  return status === "approved"
    ? "border-emerald-300/30 bg-emerald-400/15 text-emerald-100"
    : status === "archived"
      ? "border-slate-200/15 bg-slate-200/10 text-slate-300"
      : "border-amber-300/35 bg-amber-300/15 text-amber-100";
}

function packSourceReference(pack: IdentityPack) {
  return pack.references.find((reference) => reference.id === pack.sourceReferenceId)
    || pack.references.find((reference) => reference.group === "source")
    || null;
}

function StageIcon({ stage, className }: { stage: WorkspaceStage; className?: string }) {
  const Icon = stage === "source" ? UserRound : stage === "base" ? ImageIcon : stage === "camera" ? FolderOpen : stage === "expression" ? Sparkles : Layers3;
  return <Icon className={className} />;
}

function IdentityPackWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const { providers } = useSettingsStore();
  const providerSetting = providers["openai-seedance"];
  const imageChannels = getReadyImageChannels(providerSetting, { allowServerManagedCredentials: true });
  const [selectedImageChannelId, setSelectedImageChannelId] = useState("");
  const selectedImageChannel = getActiveImageChannel(providerSetting, selectedImageChannelId);
  const [packs, setPacks] = useState<IdentityPack[]>([]);
  const [selectedPackId, setSelectedPackId] = useState("");
  const [pack, setPack] = useState<IdentityPack | null>(null);
  const [newPackName, setNewPackName] = useState("");
  const [newPackSource, setNewPackSource] = useState<File | null>(null);
  const [packNameDraft, setPackNameDraft] = useState("");
  const [createPackOpen, setCreatePackOpen] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingReference, setDeletingReference] = useState<IdentityReference | null>(null);
  const [activeStage, setActiveStage] = useState<WorkspaceStage>("base");
  const [selectedReferenceId, setSelectedReferenceId] = useState("");
  const [selectedGenerateKind, setSelectedGenerateKind] = useState<GenerateKind | "">("");
  const [selectedAuxiliaryAssetId, setSelectedAuxiliaryAssetId] = useState("");
  const [auxiliaryAssetKind, setAuxiliaryAssetKind] = useState<AuxiliaryAssetKind>("expression_sheet");
  const [auxiliaryAssetTitle, setAuxiliaryAssetTitle] = useState("表情口型故事板");
  const [selectedAuxiliaryReferenceIds, setSelectedAuxiliaryReferenceIds] = useState<string[]>([]);
  const [deletingAuxiliaryAsset, setDeletingAuxiliaryAsset] = useState<IdentityAuxiliaryAsset | null>(null);
  const [localImageFolder, setLocalImageFolder] = useState("");
  const [pendingResults, setPendingResults] = useState<IdentityPendingResult[]>([]);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [generationProgress, setGenerationProgress] = useState("");
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationElapsedMs, setGenerationElapsedMs] = useState(0);

  const approvedBaseReferences = useMemo(
    () => (pack?.references || []).filter((reference) => reference.group === "base" && reference.status === "approved"),
    [pack]
  );
  const sourceReference = useMemo(() => (pack ? packSourceReference(pack) : null), [pack]);
  const auxiliaryAssets = useMemo(() => pack?.auxiliaryAssets || [], [pack]);
  const approvedAuxiliaryReferences = useMemo(() => (pack?.references || []).filter((reference) => (
    reference.status === "approved" && reference.group !== "source"
  )), [pack]);
  const eligibleAuxiliaryReferences = useMemo(() => approvedAuxiliaryReferences.filter((reference) => {
    if (auxiliaryAssetKind === "expression_sheet") return reference.group === "expression";
    if (auxiliaryAssetKind === "base_multiview_sheet") return reference.group === "base";
    if (auxiliaryAssetKind === "camera_pose_sheet") return reference.group === "camera";
    return true;
  }), [approvedAuxiliaryReferences, auxiliaryAssetKind]);
  const selectedAuxiliaryReferences = useMemo(() => selectedAuxiliaryReferenceIds
    .map((referenceId) => approvedAuxiliaryReferences.find((reference) => reference.id === referenceId))
    .filter((reference): reference is IdentityReference => Boolean(reference)), [approvedAuxiliaryReferences, selectedAuxiliaryReferenceIds]);
  const selectedAuxiliaryAsset = auxiliaryAssets.find((asset) => asset.id === selectedAuxiliaryAssetId) || auxiliaryAssets[0] || null;

  const loadLibrary = useCallback(async (preferredPackId?: string) => {
    const targetPackId = preferredPackId || selectedPackId;
    const response = await fetch(targetPackId ? `/api/identity-pack?packId=${encodeURIComponent(targetPackId)}` : "/api/identity-pack", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "人物包加载失败");
    const nextPacks = Array.isArray(data.packs) ? data.packs : [];
    const nextPack = data.pack || nextPacks[0] || null;
    setPacks(nextPacks);
    setPack(nextPack);
    setSelectedPackId(nextPack?.id || "");
    setLocalImageFolder(typeof data.localImageFolder === "string" ? data.localImageFolder : "");
    setPendingResults(Array.isArray(data.pendingResults) ? data.pendingResults : []);
    return nextPack as IdentityPack | null;
  }, [selectedPackId]);

  useEffect(() => {
    loadLibrary().catch((reason) => setError(reason instanceof Error ? reason.message : "人物包加载失败"));
  }, [loadLibrary]);

  useEffect(() => {
    if (!generationStartedAt) return;
    const update = () => setGenerationElapsedMs(Date.now() - generationStartedAt);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt]);

  useEffect(() => {
    if (!selectedImageChannelId && selectedImageChannel?.id) setSelectedImageChannelId(selectedImageChannel.id);
  }, [selectedImageChannel?.id, selectedImageChannelId]);

  useEffect(() => {
    setPackNameDraft(pack?.packName || "");
    setDeleteDialogOpen(false);
    setDeletingReference(null);
  }, [pack?.id, pack?.packName]);

  useEffect(() => {
    setActiveStage("base");
    setSelectedReferenceId("");
  }, [pack?.id]);

  async function createPack() {
    if (!newPackSource) {
      setError("请先上传主模特身份来源图。");
      return;
    }
    setBusyKey("create-pack");
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("packName", newPackName || "未命名人物包");
      form.append("source", newPackSource);
      const response = await fetch("/api/identity-pack/packs", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建人物包失败");
      setNewPackName("");
      setNewPackSource(null);
      setCreatePackOpen(false);
      await loadLibrary(data.pack?.id);
      setMessage("人物包已创建。先生成并验收白底定型组，再继续镜头与表情口型校准。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建人物包失败");
    } finally {
      setBusyKey("");
    }
  }

  async function renameCurrentPack() {
    if (!pack) return;
    setBusyKey("rename-pack");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename-pack", packId: pack.id, packName: packNameDraft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "重命名人物包失败");
      setPack(data.pack);
      setPacks(data.library?.packs || []);
      setMessage("人物包名称已保存；之后新生成图片会使用新名称作为文件名前缀。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名人物包失败");
    } finally {
      setBusyKey("");
    }
  }

  async function copyLocalImageFolder() {
    if (!localImageFolder) return;
    setError("");
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(localImageFolder);
      } else {
        const clipboardFallback = document.createElement("textarea");
        clipboardFallback.value = localImageFolder;
        clipboardFallback.setAttribute("readonly", "");
        clipboardFallback.style.position = "fixed";
        clipboardFallback.style.opacity = "0";
        document.body.appendChild(clipboardFallback);
        clipboardFallback.select();
        const copied = document.execCommand("copy");
        clipboardFallback.remove();
        if (!copied) throw new Error("浏览器拒绝了复制操作");
      }
      setMessage("本地图片路径已复制。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复制本地图片路径失败，请直接选中路径复制。");
    }
  }

  async function deleteCurrentPack() {
    if (!pack) return;
    setBusyKey("delete-pack");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-pack", packId: pack.id, confirmed: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除人物包失败");
      const nextPacks = Array.isArray(data.library?.packs) ? data.library.packs : [];
      const nextPack = nextPacks[0] || null;
      setPacks(nextPacks);
      setPack(nextPack);
      setSelectedPackId(nextPack?.id || "");
      setDeleteDialogOpen(false);
      setMessage(`已彻底删除人物包“${data.deletedPackName || pack.packName}”及 ${data.deletedFileCount || 0} 个专属图片文件。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除人物包失败");
    } finally {
      setBusyKey("");
    }
  }

  async function deleteCurrentReference() {
    if (!pack || !deletingReference) return;
    setBusyKey(`delete-reference-${deletingReference.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-reference",
          packId: pack.id,
          referenceId: deletingReference.id,
          confirmed: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除人物图片失败");
      setPack(data.pack);
      setPacks((current) => current.map((item) => item.id === data.pack.id ? data.pack : item));
      setDeletingReference(null);
      setMessage(`已彻底删除图片“${data.deletedReferenceTitle || deletingReference.title}”及 ${data.deletedFileCount || 0} 个本地文件。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除人物图片失败");
    } finally {
      setBusyKey("");
    }
  }

  function resetAuxiliarySelection(kind: AuxiliaryAssetKind) {
    const nextKind = auxiliaryAssetKinds.find((item) => item.value === kind);
    setAuxiliaryAssetKind(kind);
    setAuxiliaryAssetTitle(nextKind?.defaultTitle || "自定义组合参考板");
    setSelectedAuxiliaryReferenceIds([]);
  }

  function toggleAuxiliaryReference(referenceId: string) {
    setError("");
    setSelectedAuxiliaryReferenceIds((current) => {
      if (current.includes(referenceId)) return current.filter((item) => item !== referenceId);
      if (current.length >= 6) {
        setError("单张辅助资产最多只能选择 6 张图片。");
        return current;
      }
      return [...current, referenceId];
    });
  }

  function moveAuxiliaryReference(referenceId: string, direction: -1 | 1) {
    setSelectedAuxiliaryReferenceIds((current) => {
      const index = current.indexOf(referenceId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  async function composeAuxiliaryAsset() {
    if (!pack) return;
    setBusyKey("compose-auxiliary-asset");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packId: pack.id,
          kind: auxiliaryAssetKind,
          title: auxiliaryAssetTitle,
          referenceIds: selectedAuxiliaryReferenceIds,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "本地合成辅助资产失败");
      setPack(data.pack);
      setPacks((current) => current.map((item) => item.id === data.pack.id ? data.pack : item));
      setSelectedAuxiliaryAssetId(data.asset?.id || "");
      setSelectedAuxiliaryReferenceIds([]);
      setMessage(`已在本地合成“${data.asset?.title || auxiliaryAssetTitle}”，未调用任何模型。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地合成辅助资产失败");
    } finally {
      setBusyKey("");
    }
  }

  async function deleteCurrentAuxiliaryAsset() {
    if (!pack || !deletingAuxiliaryAsset) return;
    setBusyKey(`delete-auxiliary-${deletingAuxiliaryAsset.id}`);
    setError("");
    setMessage("");
    try {
      const query = new URLSearchParams({
        packId: pack.id,
        assetId: deletingAuxiliaryAsset.id,
        confirmed: "true",
      });
      const response = await fetch(`/api/identity-pack/assets?${query.toString()}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除辅助资产失败");
      setPack(data.pack);
      setPacks((current) => current.map((item) => item.id === data.pack.id ? data.pack : item));
      setSelectedAuxiliaryAssetId("");
      setDeletingAuxiliaryAsset(null);
      setMessage(`已彻底删除辅助资产“${data.deletedAssetTitle || deletingAuxiliaryAsset.title}”。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除辅助资产失败");
    } finally {
      setBusyKey("");
    }
  }

  async function generateOne(kind: GenerateKind, group: Exclude<ReferenceGroup, "source">) {
    if (!pack) throw new Error("请先创建或选择一个人物包。");
    if (!selectedImageChannel?.apiKey || !selectedImageChannel.baseUrl || !selectedImageChannel.model) {
      throw new Error("请先在模型与 API 中配置可用的生图模型。");
    }
    const faceFrontReference = approvedBaseReferences.find((reference) => reference.sourceKind === "face_front");
    const referenceIds = group === "base"
      ? (sourceReference ? [sourceReference.id] : [])
      : group === "expression"
        ? (faceFrontReference ? [faceFrontReference.id] : [])
        : approvedBaseReferences.map((reference) => reference.id);
    if (!referenceIds.length) {
      throw new Error(group === "base"
        ? "当前人物包缺少主模特身份来源图。"
        : group === "expression"
          ? "请先通过一张人脸正面定型图；表情组只会使用这张图作为参考图 1。"
          : "请先验收至少一张白底定型组图片。");
    }
    const response = await fetch("/api/identity-pack/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packId: pack.id,
        channel: selectedImageChannel,
        kind,
        referenceIds,
        extraPrompt,
        replaceExisting: false,
        stableCalibrationMode: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "人物参考图生成失败");
    setPack(data.pack || pack);
    return data;
  }

  async function retryPendingResult(pending: IdentityPendingResult) {
    setBusyKey(`pending-${pending.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingId: pending.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "继续下载失败");
      setPack(data.pack || pack);
      await loadLibrary(pending.packId);
      if (data.reference?.id) setSelectedReferenceId(data.reference.id);
      setMessage(data.message || `“${pending.title}”已保存为待验收图片。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "继续下载失败");
    } finally {
      setBusyKey("");
    }
  }

  async function generateSelected(kind: GenerateKind, group: Exclude<ReferenceGroup, "source">) {
    const target = generationGroups
      .find((item) => item.id === group)
      ?.kinds.find((item) => item.value === kind);
    if (!target) return;

    setBusyKey(`generate-${kind}`);
    setError("");
    setMessage("");
    setGenerationStartedAt(Date.now());
    setGenerationElapsedMs(0);
    setGenerationProgress(`正在生成${target.label}。本次只提交 1 张，4K 图生图可能需要数分钟，请勿刷新页面。`);
    try {
      const data = await generateOne(kind, group);
      await loadLibrary(pack?.id);
      if (data.reference?.id) setSelectedReferenceId(data.reference.id);
      setMessage(data.pending
        ? `“${target.label}”已由上游生成，原始结果已保存在待处理区；稍后点击“继续下载”，无需重新生成。`
        : `已保存“${target.label}”为待验收图片。${timingSummary(data.timing || data.reference?.generationTiming)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${target.label}生成失败`);
    } finally {
      setGenerationProgress("");
      setGenerationStartedAt(null);
      setBusyKey("");
    }
  }

  async function generateGroup(group: (typeof generationGroups)[number]) {
    const selectedKind = selectedGenerateKind || group.kinds[0]?.value;
    if (selectedKind) {
      await generateSelected(selectedKind, group.id);
      return;
    }
    setBusyKey(`group-${group.id}`);
    setError("");
    setMessage("");
    setGenerationProgress(`正在生成${group.title} 0/${group.kinds.length}…`);
    let completedCount = 0;
    try {
      for (let index = 0; index < group.kinds.length; index += 1) {
        const item = group.kinds[index];
        setGenerationProgress(`正在生成${group.title}：${item.label} ${index + 1}/${group.kinds.length}…`);
        const data = await generateOne(item.value, group.id);
        if (data.pending) throw new Error(`“${item.label}”已生成但仍待本地保存，请到待处理结果中继续下载。`);
        completedCount += 1;
      }
      await loadLibrary(pack?.id);
      setMessage(`${group.title}已生成，所有新图均为“待验收”，不会自动用于任何项目。`);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "人物参考图生成失败";
      setError(completedCount > 0 ? `${group.title}已完成 ${completedCount}/${group.kinds.length} 张，剩余未生成：${detail}` : detail);
    } finally {
      setGenerationProgress("");
      setBusyKey("");
    }
  }

  async function updateReferenceStatus(reference: IdentityReference, status: ReferenceStatus) {
    if (!pack) return;
    setBusyKey(`reference-${reference.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/identity-pack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-reference-status", packId: pack.id, referenceId: reference.id, status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新图片状态失败");
      setPack(data.pack);
      setPacks((current) => current.map((item) => item.id === data.pack.id ? data.pack : item));
      setMessage(status === "approved" ? "图片已验收通过，可在项目、爆款复刻和画板中手动选择。" : "图片已归档，不会再出现在后续调用列表。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新图片状态失败");
    } finally {
      setBusyKey("");
    }
  }

  async function regenerateReference(reference: IdentityReference) {
    if (!reference.sourceKind || reference.group === "source") return;
    setBusyKey(`reference-${reference.id}`);
    setError("");
    setMessage("");
    setGenerationStartedAt(Date.now());
    setGenerationElapsedMs(0);
    setGenerationProgress(`正在重生成${reference.title}。本次只提交 1 张，4K 图生图可能需要数分钟，请勿刷新页面。`);
    try {
      const data = await generateOne(reference.sourceKind as GenerateKind, reference.group);
      await loadLibrary(pack?.id);
      setMessage(`已重新生成一张待验收图片，原图保持不动，方便你比较后决定采用哪张。${timingSummary(data.timing || data.reference?.generationTiming)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新生成失败");
    } finally {
      setGenerationProgress("");
      setGenerationStartedAt(null);
      setBusyKey("");
    }
  }

  const referencesByGroup = useMemo(() => ({
    source: (pack?.references || []).filter((reference) => reference.group === "source"),
    base: (pack?.references || []).filter((reference) => reference.group === "base" && reference.status !== "archived"),
    camera: (pack?.references || []).filter((reference) => reference.group === "camera" && reference.status !== "archived"),
    expression: (pack?.references || []).filter((reference) => reference.group === "expression" && reference.status !== "archived"),
  }), [pack]);

  const activeReferences = useMemo(() => (
    activeStage === "assets" ? [] : referencesByGroup[activeStage]
  ), [activeStage, referencesByGroup]);
  const selectedReference = activeReferences.find((reference) => reference.id === selectedReferenceId) || activeReferences[0] || null;
  const activeStageMeta = workspaceStages.find((stage) => stage.id === activeStage) || workspaceStages[1];
  const activeGenerationGroup = activeStage === "source" || activeStage === "assets" ? null : generationGroups.find((group) => group.id === activeStage) || null;
  const selectedGenerationTarget = activeGenerationGroup?.kinds.find((item) => item.value === selectedGenerateKind)
    || activeGenerationGroup?.kinds[0]
    || null;
  const activeStageIsGenerating = Boolean(activeGenerationGroup)
    && activeGenerationGroup!.kinds.some((item) => busyKey === `generate-${item.value}`);
  const approvedFaceFrontReference = approvedBaseReferences.find((reference) => reference.sourceKind === "face_front");
  const activeStageNeedsBaseApproval = Boolean(activeGenerationGroup)
    && (activeGenerationGroup?.id === "expression"
      ? !approvedFaceFrontReference
      : activeGenerationGroup?.id !== "base" && approvedBaseReferences.length === 0);
  const activeStageBusyElsewhere = Boolean(busyKey) && !activeStageIsGenerating;
  const activeStageCanGenerate = Boolean(activeGenerationGroup) && Boolean(selectedImageChannel) && !activeStageNeedsBaseApproval && !activeStageBusyElsewhere && !activeStageIsGenerating;
  const activeStageActionLabel = activeStageIsGenerating
    ? "正在生成，请等待"
    : !selectedImageChannel
      ? "请先配置生图模型"
      : activeStageNeedsBaseApproval
        ? activeGenerationGroup?.id === "expression"
          ? "需先通过人脸正面定型图"
          : "需先通过白底定型图"
        : activeStageBusyElsewhere
          ? "当前有任务进行中"
          : selectedGenerationTarget
            ? `生成${selectedGenerationTarget.label}`
            : "";
  const approvedReferenceCount = (pack?.references || []).filter((reference) => reference.status === "approved").length;
  const pendingReferenceCount = (pack?.references || []).filter((reference) => reference.group !== "source" && reference.status === "draft").length;

  useEffect(() => {
    setSelectedReferenceId((current) => (
      activeReferences.some((reference) => reference.id === current) ? current : activeReferences[0]?.id || ""
    ));
  }, [activeReferences]);

  useEffect(() => {
    setSelectedAuxiliaryAssetId((current) => (
      auxiliaryAssets.some((asset) => asset.id === current) ? current : auxiliaryAssets[0]?.id || ""
    ));
  }, [auxiliaryAssets]);

  useEffect(() => {
    setSelectedGenerateKind((current) => (
      activeGenerationGroup?.kinds.some((item) => item.value === current)
        ? current
        : activeGenerationGroup?.kinds[0]?.value || ""
    ));
  }, [activeGenerationGroup]);

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#061018]/70 backdrop-blur-2xl">
        <div className="mx-auto flex h-14 max-w-[1760px] items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-3">
            {embedded ? <span className="text-sm font-semibold text-slate-200">人物身份包</span> : <Link href="/workspace?module=identity" className="text-sm text-slate-400 transition hover:text-cyan-100">返回工作台</Link>}
            <span className="h-4 w-px bg-white/15" />
            <span className="truncate text-sm font-semibold tracking-[0.08em] text-cyan-50">人物身份包工作台</span>
          </div>
          <Badge className="border-cyan-200/25 bg-cyan-300/[0.09] text-cyan-50">账户独立保存</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-[1760px] px-4 py-5 lg:px-5">
        {(error || message || generationProgress) && <div className="mb-4 space-y-2">
          {error && <div className="rounded-lg border border-rose-300/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{error}</div>}
          {generationProgress && <div className="rounded-lg border border-cyan-300/35 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-50"><span>{generationProgress}</span>{generationStartedAt && <span className="ml-2 text-cyan-100/75">已等待 {formatElapsed(generationElapsedMs)}</span>}</div>}
          {message && <div className="whitespace-pre-line rounded-lg border border-emerald-300/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">{message}</div>}
        </div>}

        {pendingResults.length > 0 && <section className="mb-4 overflow-hidden rounded-lg border border-amber-200/25 bg-amber-300/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
            <div><div className="flex items-center gap-2 text-sm font-semibold text-amber-50"><Download className="h-4 w-4" />待处理生成结果</div><p className="mt-1 text-xs leading-relaxed text-slate-400">上游已经生成，原始结果已按账户保存；继续下载成功后才会生成图片卡片，不会重复调用模型。</p></div>
            <Badge className="border-amber-200/30 bg-amber-300/10 text-amber-100">{pendingResults.length} 条</Badge>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">{pendingResults.map((pending) => <div key={pending.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-white/10 bg-black/15 px-3 py-2.5">
            <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-100">{pending.title}</p><p className="mt-1 truncate text-xs text-slate-400">{pending.transport === "b64_json" ? "Base64 已保全" : "上游图片地址已保全"} · {new Date(pending.createdAt).toLocaleString("zh-CN")}</p>{pending.generationTiming && <p className="mt-1 truncate text-[11px] text-cyan-100/75" title={timingSummary(pending.generationTiming)}>{timingSummary(pending.generationTiming)}</p>}{pending.lastError && <p className="mt-1 truncate text-[11px] text-rose-200/85" title={pending.lastError}>{pending.lastError}</p>}</div>
            <Button size="sm" onClick={() => retryPendingResult(pending)} disabled={Boolean(busyKey)}><Download data-icon="inline-start" />{busyKey === `pending-${pending.id}` ? "下载中" : "继续下载"}</Button>
          </div>)}</div>
        </section>}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(220px,250px)_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_320px]">
          <aside className="self-start overflow-hidden rounded-lg border border-cyan-100/20 bg-[#071720]/[0.48] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_56px_rgba(0,0,0,0.18)] backdrop-blur-2xl xl:sticky xl:top-[72px]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold"><FolderOpen className="h-4 w-4 text-cyan-100" />人物包库</div>
              <div className="flex items-center gap-2"><Badge variant="secondary">{packs.length} 套</Badge><Button size="icon-sm" variant="outline" onClick={() => setCreatePackOpen((current) => !current)} title="新建人物包"><UserRoundPlus /></Button></div>
            </div>
            <div className="max-h-[calc(100vh-195px)] overflow-y-auto p-2">
              {packs.length ? packs.map((item) => {
                const cover = packSourceReference(item);
                const selected = item.id === selectedPackId;
                const approved = item.references.filter((reference) => reference.status === "approved").length;
                return <button key={item.id} type="button" onClick={() => loadLibrary(item.id).catch((reason) => setError(reason instanceof Error ? reason.message : "人物包切换失败"))} className={`group flex w-full items-center gap-3 rounded-md border p-2.5 text-left transition ${selected ? "border-cyan-200/50 bg-cyan-300/[0.12] shadow-[inset_2px_0_0_rgba(103,232,249,0.9)]" : "border-transparent hover:border-white/15 hover:bg-white/[0.06]"}`}>
                  <div className="h-11 w-9 shrink-0 overflow-hidden rounded-md border border-white/15 bg-black/20">{cover ? <img src={cover.url} alt="" className="h-full w-full object-cover" /> : <UserRound className="m-2 h-5 w-5 text-slate-400" />}</div>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-100">{item.packName}</span><span className="mt-0.5 block text-xs text-slate-400">{approved} 张已通过 · {item.references.length} 张图片</span></span>
                </button>;
              }) : <div className="px-3 py-6 text-center text-xs leading-relaxed text-slate-400">尚未创建人物包。上传一张人物脸部来源图后，即可开始定型。</div>}
            </div>
            {createPackOpen && <div className="space-y-3 border-t border-white/10 p-3">
              <div><p className="text-sm font-semibold text-slate-100">新建人物包</p><p className="mt-1 text-xs leading-relaxed text-slate-400">每个新人物单独建包，不与旧人物混用。</p></div>
              <Input value={newPackName} onChange={(event) => setNewPackName(event.target.value)} placeholder="人物包名称" maxLength={48} className="bg-black/10" />
              <input aria-label="人物脸部来源图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setNewPackSource(event.target.files?.[0] || null)} className="block h-9 w-full cursor-pointer rounded-md border border-white/15 bg-black/10 px-2 text-xs text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-cyan-300/15 file:px-2 file:py-1 file:text-xs file:font-medium file:text-cyan-50" />
              <Button className="w-full" onClick={createPack} disabled={busyKey === "create-pack"}><UserRoundPlus data-icon="inline-start" />{busyKey === "create-pack" ? "创建中" : "创建人物包"}</Button>
            </div>}
          </aside>

          <section className="min-w-0 space-y-4">
            {pack ? <>
              <section className="overflow-hidden rounded-lg border border-cyan-100/20 bg-[#071720]/[0.42] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_56px_rgba(0,0,0,0.18)] backdrop-blur-2xl">
                <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0"><Badge className="border-cyan-200/25 bg-cyan-300/[0.10] text-cyan-50">当前人物包</Badge><h1 className="mt-2 truncate text-2xl font-semibold text-white">{pack.packName}</h1><p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">{pack.description}</p></div>
                  <div className="flex shrink-0 gap-5 text-right"><Metric label="已通过" value={`${approvedReferenceCount} 张`} tone="text-emerald-200" /><Metric label="待验收" value={`${pendingReferenceCount} 张`} tone="text-amber-100" /></div>
                </div>
                <div className="grid gap-3 border-t border-white/10 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"><label className="min-w-0 space-y-1"><span className="text-xs text-slate-400">人物包名称</span><Input value={packNameDraft} onChange={(event) => setPackNameDraft(event.target.value)} maxLength={48} className="bg-black/10" /></label><Button variant="outline" onClick={renameCurrentPack} disabled={Boolean(busyKey) || packNameDraft.trim() === pack.packName}><Save data-icon="inline-start" />保存名称</Button><Button variant="destructive" onClick={() => setDeleteDialogOpen(true)} disabled={Boolean(busyKey)}><Trash2 data-icon="inline-start" />删除人物包</Button></div>
              </section>

              <nav aria-label="人物校准步骤" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-cyan-100/20 bg-white/10 sm:grid-cols-3 lg:grid-cols-5">
                {workspaceStages.map((stage) => {
                  const selected = stage.id === activeStage;
                  const count = stage.id === "assets" ? auxiliaryAssets.length : referencesByGroup[stage.id].length;
                  return <button key={stage.id} type="button" onClick={() => setActiveStage(stage.id)} aria-current={selected ? "step" : undefined} className={`min-h-[86px] px-3 py-3 text-left transition ${selected ? "bg-cyan-300/[0.16] text-cyan-50 shadow-[inset_0_-2px_0_rgba(103,232,249,0.95)]" : "bg-[#071720]/[0.48] text-slate-300 hover:bg-white/[0.06]"}`}>
                    <span className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold tracking-[0.16em] text-cyan-100/70">{stage.index}</span><StageIcon stage={stage.id} className="h-4 w-4" /></span>
                    <span className="mt-2 block text-sm font-semibold">{stage.title}</span><span className="mt-1 block text-xs text-slate-400">{stage.id === "assets" ? `${count} 个组合资产` : `${count} 张可见图片`}</span>
                  </button>;
                })}
              </nav>

              <section className="rounded-lg border border-cyan-100/20 bg-[#071720]/[0.42] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_56px_rgba(0,0,0,0.18)] backdrop-blur-2xl">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4"><div><div className="flex items-center gap-2"><StageIcon stage={activeStage} className="h-5 w-5 text-cyan-100" /><h2 className="text-lg font-semibold text-white">{activeStageMeta.title}</h2><Badge variant="secondary">{activeStage === "assets" ? `${auxiliaryAssets.length} 个` : `${activeReferences.length} 张`}</Badge></div><p className="mt-1 text-sm leading-relaxed text-slate-400">{activeStage === "assets" ? "从已验收的人物图本地拼接组合参考板。不会调用模型，也不会改变任何单张图片。" : activeGenerationGroup?.description || "此图固定作为参考图 1 锁定人物身份；不会自动写入任何项目。"}</p></div>{activeStage === "assets" ? <Badge className="border-emerald-300/30 bg-emerald-400/12 text-emerald-100">本地合成 · 不调用模型</Badge> : activeGenerationGroup && <Badge className={activeStageCanGenerate ? "border-emerald-300/30 bg-emerald-400/12 text-emerald-100" : "border-white/10 bg-white/[0.06] text-slate-300"}>{activeStageIsGenerating ? "生成中" : activeStageNeedsBaseApproval ? "等待白底验收" : selectedImageChannel ? "可准备生成" : "未配置模型"}</Badge>}</div>
                <div className="space-y-4 p-5">
                  {activeStage === "assets" ? <AuxiliaryAssetWorkspace
                    folder={localImageFolder}
                    onCopyFolder={copyLocalImageFolder}
                    kind={auxiliaryAssetKind}
                    onKindChange={resetAuxiliarySelection}
                    title={auxiliaryAssetTitle}
                    onTitleChange={setAuxiliaryAssetTitle}
                    eligibleReferences={eligibleAuxiliaryReferences}
                    selectedReferences={selectedAuxiliaryReferences}
                    onToggleReference={toggleAuxiliaryReference}
                    onMoveReference={moveAuxiliaryReference}
                    assets={auxiliaryAssets}
                    selectedAssetId={selectedAuxiliaryAsset?.id || ""}
                    onSelectAsset={setSelectedAuxiliaryAssetId}
                    onCompose={composeAuxiliaryAsset}
                    busy={busyKey === "compose-auxiliary-asset"}
                  /> : <>
                  <LocalFolderPath folder={localImageFolder} onCopy={copyLocalImageFolder} />
                  {activeGenerationGroup ? <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"><label className="space-y-1"><span className="text-xs text-slate-400">生图模型</span><ModelChannelSelect value={selectedImageChannel?.id || ""} onChange={setSelectedImageChannelId} emptyLabel="未配置可用生图模型" ariaLabel="生图模型" options={imageChannels.map((channel) => ({ id: channel.id, label: channelLabel(channel) }))} /></label><label className="space-y-1"><span className="text-xs text-slate-400">补充生成要求（可选）</span><Input value={extraPrompt} onChange={(event) => setExtraPrompt(event.target.value)} placeholder="例如：发丝更自然、保持当前刘海" className="bg-black/10" /></label><Button onClick={() => generateGroup(activeGenerationGroup)} disabled={!activeStageCanGenerate}>{activeStageIsGenerating ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : activeStageCanGenerate ? <Sparkles data-icon="inline-start" /> : <LockKeyhole data-icon="inline-start" />}{activeStageActionLabel}</Button></div> : <div className="grid gap-4 md:grid-cols-[190px_minmax(0,1fr)]"><button type="button" onClick={() => sourceReference && setSelectedReferenceId(sourceReference.id)} className="overflow-hidden rounded-md border border-cyan-100/25 bg-black/15 text-left transition hover:border-cyan-200/55">{sourceReference ? <img src={sourceReference.url} alt={sourceReference.title} className="aspect-[3/4] w-full object-cover" /> : <div className="flex aspect-[3/4] items-center justify-center text-slate-500"><UserRound className="h-10 w-10" /></div>}</button><div className="self-center"><p className="text-sm font-semibold text-slate-100">参考图 1：人物脸部来源图</p><p className="mt-2 text-sm leading-relaxed text-slate-400">白底定型组只使用这一张来源图来保持脸型、五官、发型、肤色、身材比例与人物气质一致。后续镜头组使用来源图与已通过的白底定型图；表情组只使用已通过的人脸正面定型图。</p><p className="mt-3 text-xs leading-relaxed text-cyan-100/75">来源图不能单独删除；需要换人物时请创建新的独立人物包。</p></div></div>}
                  {activeGenerationGroup && <div className="space-y-2"><div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-slate-300">本次只生成 1 张：先选择目标图，再提交生成。</p><span className="text-[11px] text-slate-500">已有同类图不会被覆盖</span></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{activeGenerationGroup.kinds.map((item) => { const selected = selectedGenerationTarget?.value === item.value; const existingCount = activeReferences.filter((reference) => reference.sourceKind === item.value).length; return <button key={item.value} type="button" aria-pressed={selected} onClick={() => setSelectedGenerateKind(item.value)} disabled={Boolean(busyKey)} className={`rounded-md border px-3 py-2.5 text-left transition ${selected ? "border-cyan-200/65 bg-cyan-300/[0.13] shadow-[inset_0_0_0_1px_rgba(103,232,249,0.16)]" : "border-white/12 bg-black/10 hover:border-cyan-100/35 hover:bg-white/[0.04]"}`}><span className="flex items-center justify-between gap-2"><strong className="text-sm text-slate-100">{item.label}</strong><Badge variant="secondary" className="text-[10px]">{existingCount ? `已有 ${existingCount} 张` : "未生成"}</Badge></span><span className="mt-1 block text-[11px] text-slate-400">{selected ? "本次将只提交这一张" : "点击选择"}</span></button>; })}</div></div>}
                  {activeStage !== "source" && <ReferenceGrid references={activeReferences} selectedReferenceId={selectedReference?.id || ""} onSelect={setSelectedReferenceId} />}
                  </>}
                </div>
              </section>
            </> : <section className="flex min-h-[440px] items-center justify-center rounded-lg border border-cyan-100/20 bg-[#071720]/[0.42] px-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl"><div><UserRoundPlus className="mx-auto h-10 w-10 text-cyan-100/70" /><h1 className="mt-4 text-xl font-semibold text-white">先创建一套人物包</h1><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-400">从左侧上传一张人物脸部来源图。每个新人物单独保存，后续只会使用你手动通过的校准图片。</p></div></section>}
          </section>

          <div className="space-y-3 lg:col-span-2 xl:col-span-1">
            {activeStage === "assets" ? <AuxiliaryAssetReviewPanel asset={selectedAuxiliaryAsset} busy={Boolean(busyKey)} onDelete={setDeletingAuxiliaryAsset} /> : <><ReviewPanel pack={pack} reference={selectedReference} busyKey={busyKey} onApprove={(reference) => updateReferenceStatus(reference, "approved")} onArchive={(reference) => updateReferenceStatus(reference, "archived")} onRegenerate={regenerateReference} onDelete={setDeletingReference} />
              {selectedReference?.generationTiming && <section className="rounded-lg border border-cyan-200/15 bg-[#071720]/[0.48] px-4 py-3 text-xs leading-relaxed text-cyan-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl"><p className="font-semibold text-cyan-100">本次真实耗时</p><p className="mt-1">{timingSummary(selectedReference.generationTiming)}</p></section>}</>}
          </div>
        </div>
      </main>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="w-[min(28rem,calc(100%-2rem))] border border-rose-200/30 !bg-[#08171d]/80 p-5 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <DialogHeader><DialogTitle className="text-lg text-white">彻底删除人物包</DialogTitle><DialogDescription className="leading-relaxed text-slate-300">这会移除“{pack?.packName}”及其在 3100 中保存的来源图、定型图、镜头图和动作图。此操作不可恢复，已引用这些图片的旧项目之后无法继续调用它们。</DialogDescription></DialogHeader>
          <DialogFooter className="-mx-5 -mb-5 border-white/10 !bg-black/15 px-5 py-4"><Button variant="outline" className="border-white/15 bg-white/[0.045] text-slate-100 hover:bg-white/10 hover:text-white" onClick={() => setDeleteDialogOpen(false)} disabled={busyKey === "delete-pack"}>取消</Button><Button variant="destructive" onClick={deleteCurrentPack} disabled={busyKey === "delete-pack"}><Trash2 data-icon="inline-start" />{busyKey === "delete-pack" ? "删除中" : "确认彻底删除"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(deletingReference)} onOpenChange={(open) => { if (!open) setDeletingReference(null); }}>
        <DialogContent className="w-[min(28rem,calc(100%-2rem))] border border-rose-200/30 !bg-[#08171d]/80 p-5 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <DialogHeader><DialogTitle className="text-lg text-white">彻底删除图片</DialogTitle><DialogDescription className="leading-relaxed text-slate-300">这会删除“{deletingReference?.title}”的卡片记录和本地图片文件。此操作不可恢复，已引用它的旧项目之后无法继续调用它。</DialogDescription></DialogHeader>
          <DialogFooter className="-mx-5 -mb-5 border-white/10 !bg-black/15 px-5 py-4"><Button variant="outline" className="border-white/15 bg-white/[0.045] text-slate-100 hover:bg-white/10 hover:text-white" onClick={() => setDeletingReference(null)} disabled={busyKey.startsWith("delete-reference-")}>取消</Button><Button variant="destructive" onClick={deleteCurrentReference} disabled={!deletingReference || busyKey.startsWith("delete-reference-")}><Trash2 data-icon="inline-start" />{busyKey.startsWith("delete-reference-") ? "删除中" : "确认彻底删除"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(deletingAuxiliaryAsset)} onOpenChange={(open) => { if (!open) setDeletingAuxiliaryAsset(null); }}>
        <DialogContent className="w-[min(28rem,calc(100%-2rem))] border border-rose-200/30 !bg-[#08171d]/80 p-5 text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <DialogHeader><DialogTitle className="text-lg text-white">彻底删除辅助资产</DialogTitle><DialogDescription className="leading-relaxed text-slate-300">这会删除“{deletingAuxiliaryAsset?.title}”的组合板与本地图片文件。原始单张人物图不会被删除。</DialogDescription></DialogHeader>
          <DialogFooter className="-mx-5 -mb-5 border-white/10 !bg-black/15 px-5 py-4"><Button variant="outline" className="border-white/15 bg-white/[0.045] text-slate-100 hover:bg-white/10 hover:text-white" onClick={() => setDeletingAuxiliaryAsset(null)} disabled={busyKey.startsWith("delete-auxiliary-")}>取消</Button><Button variant="destructive" onClick={deleteCurrentAuxiliaryAsset} disabled={!deletingAuxiliaryAsset || busyKey.startsWith("delete-auxiliary-")}><Trash2 data-icon="inline-start" />{busyKey.startsWith("delete-auxiliary-") ? "删除中" : "确认彻底删除"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div><p className="text-[11px] text-slate-400">{label}</p><p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p></div>;
}

function LocalFolderPath({ folder, onCopy }: { folder: string; onCopy: () => void }) {
  return <div className="flex min-w-0 items-center gap-2"><Input aria-label="本地图片路径" value={folder || "本地图片目录读取失败，请刷新页面重试"} readOnly onFocus={(event) => event.currentTarget.select()} className="h-9 min-w-0 bg-black/10 text-xs" /><Button size="sm" variant="outline" onClick={onCopy} disabled={!folder} title="复制本地图片路径"><Copy data-icon="inline-start" />复制路径</Button></div>;
}

function AuxiliaryAssetWorkspace({
  folder,
  onCopyFolder,
  kind,
  onKindChange,
  title,
  onTitleChange,
  eligibleReferences,
  selectedReferences,
  onToggleReference,
  onMoveReference,
  assets,
  selectedAssetId,
  onSelectAsset,
  onCompose,
  busy,
}: {
  folder: string;
  onCopyFolder: () => void;
  kind: AuxiliaryAssetKind;
  onKindChange: (kind: AuxiliaryAssetKind) => void;
  title: string;
  onTitleChange: (value: string) => void;
  eligibleReferences: IdentityReference[];
  selectedReferences: IdentityReference[];
  onToggleReference: (referenceId: string) => void;
  onMoveReference: (referenceId: string, direction: -1 | 1) => void;
  assets: IdentityAuxiliaryAsset[];
  selectedAssetId: string;
  onSelectAsset: (assetId: string) => void;
  onCompose: () => void;
  busy: boolean;
}) {
  return <>
    <LocalFolderPath folder={folder} onCopy={onCopyFolder} />
    <div className="grid gap-3 xl:grid-cols-[minmax(250px,0.82fr)_minmax(0,1.18fr)]">
      <section className="space-y-4 rounded-md border border-white/12 bg-black/10 p-4">
        <div><p className="text-sm font-semibold text-slate-100">新建组合参考板</p><p className="mt-1 text-xs leading-relaxed text-slate-400">只从已通过图片中手动选择，最多 6 张。合成过程完全在本地完成。</p></div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          {auxiliaryAssetKinds.map((item) => {
            const selected = kind === item.value;
            return <button key={item.value} type="button" aria-pressed={selected} onClick={() => onKindChange(item.value)} disabled={busy} className={`rounded-md border px-3 py-2.5 text-left transition ${selected ? "border-cyan-200/65 bg-cyan-300/[0.13]" : "border-white/12 bg-black/10 hover:border-cyan-100/35 hover:bg-white/[0.04]"}`}>
              <strong className="block text-sm text-slate-100">{item.label}</strong><span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{item.description}</span>
            </button>;
          })}
        </div>
        <label className="block space-y-1"><span className="text-xs text-slate-400">辅助资产名称</span><Input value={title} onChange={(event) => onTitleChange(event.target.value)} maxLength={48} className="bg-black/10" /></label>
        <Button className="w-full" onClick={onCompose} disabled={busy || selectedReferences.length < 2}>{busy ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <Layers3 data-icon="inline-start" />}{busy ? "正在本地合成" : `本地合成（${selectedReferences.length}/6）`}</Button>
      </section>

      <section className="min-w-0 overflow-hidden rounded-md border border-white/12 bg-black/10">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3"><div><p className="text-sm font-semibold text-slate-100">选择已验收图片</p><p className="mt-1 text-xs text-slate-400">勾选顺序就是故事板编号顺序。每种目标图只能选一个版本。</p></div><Badge variant="secondary">已选 {selectedReferences.length}/6</Badge></div>
        <div className="max-h-[290px] overflow-y-auto p-3"><div className="grid gap-2 sm:grid-cols-2">{eligibleReferences.map((reference) => {
          const order = selectedReferences.findIndex((item) => item.id === reference.id);
          const selected = order >= 0;
          return <button key={reference.id} type="button" aria-pressed={selected} onClick={() => onToggleReference(reference.id)} disabled={busy} className={`flex min-w-0 items-center gap-3 rounded-md border p-2 text-left transition ${selected ? "border-cyan-200/65 bg-cyan-300/[0.13]" : "border-white/12 bg-black/10 hover:border-cyan-100/35 hover:bg-white/[0.04]"}`}>
            <img src={reference.url} alt="" className="h-14 w-11 shrink-0 rounded border border-white/12 object-cover" /><span className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-100">{reference.title}</strong><span className="mt-1 block truncate text-[11px] text-slate-400">{reference.role}</span></span>{selected && <Badge className="border-cyan-200/35 bg-cyan-300/[0.15] text-cyan-50">{String(order + 1).padStart(2, "0")}</Badge>}
          </button>;
        })}</div>{eligibleReferences.length === 0 && <div className="flex min-h-32 items-center justify-center px-4 text-center text-sm leading-relaxed text-slate-400">这个类型暂时没有可用的已验收图片。</div>}</div>
      </section>
    </div>

    <section className="overflow-hidden rounded-md border border-white/12 bg-black/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3"><div><p className="text-sm font-semibold text-slate-100">面板顺序与预览</p><p className="mt-1 text-xs text-slate-400">标签会放在人物画面外侧；不会裁掉人物，也不会生成服务器 UI。</p></div><Badge variant="secondary">{selectedReferences.length ? `${selectedReferences.length} 个面板` : "尚未选择"}</Badge></div>
      {selectedReferences.length ? <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">{selectedReferences.map((reference, index) => <div key={reference.id} className="flex min-w-0 items-center gap-3 rounded-md border border-white/12 bg-black/15 p-2.5"><Badge className="border-cyan-200/30 bg-cyan-300/[0.12] text-cyan-50">{String(index + 1).padStart(2, "0")}</Badge><span className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-100">{reference.title}</strong><span className="mt-1 block truncate text-[11px] text-slate-400">{reference.group === "base" ? "白底定型" : reference.group === "camera" ? "镜头适配" : "表情口型"}</span></span><span className="flex shrink-0 flex-col gap-1"><Button size="icon-xs" variant="ghost" title="上移" onClick={() => onMoveReference(reference.id, -1)} disabled={busy || index === 0}><ChevronUp /></Button><Button size="icon-xs" variant="ghost" title="下移" onClick={() => onMoveReference(reference.id, 1)} disabled={busy || index === selectedReferences.length - 1}><ChevronDown /></Button></span></div>)}</div> : <div className="px-4 py-8 text-center text-sm text-slate-400">从上方勾选至少两张已验收图片后，在这里确认组合顺序。</div>}
    </section>

    <section className="overflow-hidden rounded-md border border-white/12 bg-black/10">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"><div><p className="text-sm font-semibold text-slate-100">辅助资产库</p><p className="mt-1 text-xs text-slate-400">导入画板后才会被模型读取，未导入或未连线不会自动发送。</p></div><Badge variant="secondary">{assets.length} 个</Badge></div>
      {assets.length ? <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">{assets.map((asset) => {
        const selected = asset.id === selectedAssetId;
        return <button key={asset.id} type="button" aria-pressed={selected} onClick={() => onSelectAsset(asset.id)} className={`overflow-hidden rounded-md border text-left transition ${selected ? "border-cyan-200/65 bg-cyan-300/[0.10] shadow-[inset_0_0_0_1px_rgba(103,232,249,0.16)]" : "border-white/12 bg-black/10 hover:border-cyan-100/35 hover:bg-white/[0.04]"}`}><img src={asset.url} alt={asset.title} className="aspect-[9/8] w-full bg-white object-contain" /><span className="block space-y-1 p-3"><span className="flex items-start justify-between gap-2"><strong className="min-w-0 truncate text-sm text-slate-100">{asset.title}</strong><Badge className="border-emerald-300/30 bg-emerald-400/12 text-emerald-100">已就绪</Badge></span><span className="block text-xs leading-relaxed text-slate-400">{asset.panels.length} 张来源图 · 本地组合</span></span></button>;
      })}</div> : <div className="px-4 py-10 text-center text-sm leading-relaxed text-slate-400">还没有辅助资产。选择已验收图片后，本地合成第一张组合参考板。</div>}
    </section>
  </>;
}

function ReferenceGrid({ references, selectedReferenceId, onSelect }: { references: IdentityReference[]; selectedReferenceId: string; onSelect: (id: string) => void }) {
  if (!references.length) return <div className="flex min-h-52 items-center justify-center rounded-md border border-dashed border-white/15 bg-black/10 px-5 text-center text-sm leading-relaxed text-slate-400">这一组尚未生成图片。先在上方选择一种目标图，再点击生成按钮；每次只会创建 1 张待验收图片。</div>;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{references.map((reference) => {
    const selected = reference.id === selectedReferenceId;
    return <button key={reference.id} type="button" aria-pressed={selected} onClick={() => onSelect(reference.id)} className={`overflow-hidden rounded-md border text-left transition ${selected ? "border-cyan-200/65 bg-cyan-200/[0.10] shadow-[inset_0_0_0_1px_rgba(103,232,249,0.22)]" : "border-white/12 bg-black/10 hover:border-cyan-100/35 hover:bg-white/[0.04]"}`}>
      <img src={reference.url} alt={reference.title} className={`w-full object-cover ${reference.aspectRatio === "9:16" ? "aspect-[9/16]" : "aspect-[3/4]"}`} />
      <span className="block space-y-1 p-3"><span className="flex items-start justify-between gap-2"><strong className="min-w-0 truncate text-sm text-slate-100">{reference.title}</strong><Badge className={statusClass(reference.status)}>{statusLabel(reference.status)}</Badge></span><span className="block line-clamp-2 min-h-9 text-xs leading-relaxed text-slate-400">{reference.role}</span></span>
    </button>;
  })}</div>;
}

function AuxiliaryAssetReviewPanel({ asset, busy, onDelete }: { asset: IdentityAuxiliaryAsset | null; busy: boolean; onDelete: (asset: IdentityAuxiliaryAsset) => void }) {
  return <aside className="self-start overflow-hidden rounded-lg border border-cyan-100/20 bg-[#071720]/[0.48] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_56px_rgba(0,0,0,0.18)] backdrop-blur-2xl lg:col-span-2 xl:sticky xl:top-[72px] xl:col-span-1">
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4 text-cyan-100" />辅助资产详情</div>{asset && <Badge className="border-emerald-300/30 bg-emerald-400/12 text-emerald-100">已就绪</Badge>}</div>
    {asset ? <div className="space-y-4 p-4"><div className="overflow-hidden rounded-md border border-white/12 bg-white"><img src={asset.url} alt={asset.title} className="mx-auto max-h-[360px] w-full object-contain" /></div><div><h2 className="break-words text-base font-semibold text-white">{asset.title}</h2><p className="mt-2 text-sm leading-relaxed text-slate-400">{asset.role}</p></div><div className="border-y border-white/10 py-3"><p className="text-[11px] font-semibold tracking-[0.12em] text-cyan-100/70">面板映射</p><div className="mt-2 space-y-2">{asset.panels.map((panel) => <div key={`${asset.id}-${panel.referenceId}`} className="flex min-w-0 items-center gap-2 text-xs"><Badge variant="secondary">{String(panel.order).padStart(2, "0")}</Badge><span className="min-w-0 truncate text-slate-200" title={panel.title}>{panel.label}</span></div>)}</div></div><p className="rounded-md border border-cyan-200/20 bg-cyan-300/[0.08] p-3 text-xs leading-relaxed text-cyan-50/85">这是独立辅助资产。它只有在你从人物身份包手动导入画板、再连到目标节点后才会发送给模型；不会自动替代任何单张人物图。</p><Button variant="destructive" className="w-full" onClick={() => onDelete(asset)} disabled={busy}><Trash2 data-icon="inline-start" />彻底删除辅助资产</Button></div> : <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center"><Layers3 className="h-9 w-9 text-cyan-100/45" /><p className="mt-3 text-sm font-semibold text-slate-200">选择一个辅助资产</p><p className="mt-1 text-xs leading-relaxed text-slate-400">本地合成后会在这里查看面板映射和管理删除。</p></div>}
  </aside>;
}

function ReviewPanel({ pack, reference, busyKey, onApprove, onArchive, onRegenerate, onDelete }: { pack: IdentityPack | null; reference: IdentityReference | null; busyKey: string; onApprove: (reference: IdentityReference) => void; onArchive: (reference: IdentityReference) => void; onRegenerate: (reference: IdentityReference) => void; onDelete: (reference: IdentityReference) => void }) {
  const isSource = reference?.group === "source" || reference?.id === pack?.sourceReferenceId;
  const isBusy = reference ? busyKey === `reference-${reference.id}` || busyKey === `delete-reference-${reference.id}` : Boolean(busyKey);
  return <aside className="self-start overflow-hidden rounded-lg border border-cyan-100/20 bg-[#071720]/[0.48] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_56px_rgba(0,0,0,0.18)] backdrop-blur-2xl lg:col-span-2 xl:sticky xl:top-[72px] xl:col-span-1">
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div className="flex items-center gap-2 text-sm font-semibold"><Check className="h-4 w-4 text-cyan-100" />验收详情</div>{reference && <Badge className={statusClass(reference.status)}>{statusLabel(reference.status)}</Badge>}</div>
    {reference ? <div className="space-y-4 p-4"><div className="overflow-hidden rounded-md border border-white/12 bg-black/15"><img src={reference.url} alt={reference.title} className={`mx-auto max-h-[360px] w-full object-contain ${reference.aspectRatio === "9:16" ? "aspect-[9/16]" : "aspect-[3/4]"}`} /></div><div><h2 className="text-base font-semibold text-white">{reference.title}</h2><p className="mt-2 text-sm leading-relaxed text-slate-400">{reference.role}</p></div><div className="border-y border-white/10 py-3 text-xs leading-relaxed text-slate-400"><span className="block text-slate-500">当前用途</span><span className="mt-1 block text-slate-200">{reference.requiredFor.join(" · ")}</span></div>{isSource ? <p className="rounded-md border border-cyan-200/20 bg-cyan-300/[0.08] p-3 text-xs leading-relaxed text-cyan-50/85">这是该人物包的参考图 1。它用于锁定人物身份，不能单独删除；需要换人物时请创建新的独立人物包。</p> : <div className="grid gap-2">{reference.status === "draft" && <Button onClick={() => onApprove(reference)} disabled={isBusy}><Check data-icon="inline-start" />通过验收</Button>}<Button variant="outline" onClick={() => onRegenerate(reference)} disabled={isBusy || !reference.sourceKind}><RefreshCw data-icon="inline-start" />{isBusy ? "处理中" : "重生成一张"}</Button><Button variant="ghost" className="text-slate-300 hover:bg-white/[0.07] hover:text-white" onClick={() => onArchive(reference)} disabled={isBusy}><Archive data-icon="inline-start" />归档，不再调用</Button><Button variant="destructive" onClick={() => onDelete(reference)} disabled={Boolean(busyKey)}><Trash2 data-icon="inline-start" />彻底删除图片</Button></div>}</div> : <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center"><ImageIcon className="h-9 w-9 text-cyan-100/45" /><p className="mt-3 text-sm font-semibold text-slate-200">选择一张图片</p><p className="mt-1 text-xs leading-relaxed text-slate-400">点击中间区域的来源图或校准图，即可在这里验收、重生成、归档或删除。</p></div>}
    {pack && <div className="space-y-4 border-t border-white/10 p-4"><div><p className="text-[11px] font-semibold tracking-[0.14em] text-cyan-100/70">IDENTITY LOCK</p><p className="mt-2 text-xs leading-relaxed text-slate-400">{pack.identityLock}</p></div><div><p className="text-[11px] font-semibold tracking-[0.14em] text-cyan-100/70">PERFORMANCE BASELINE</p><p className="mt-2 text-xs leading-relaxed text-slate-400">{pack.identityPerformanceBaseline}</p></div></div>}
  </aside>;
}

export default function IdentityPackPage() {
  const { embedded } = useWorkspaceEmbed();
  return <IdentityPackWorkspace embedded={embedded} />;
}

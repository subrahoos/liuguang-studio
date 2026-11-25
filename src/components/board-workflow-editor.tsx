"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  LuArrowLeft,
  LuCamera,
  LuCheck,
  LuChevronDown,
  LuColumns3,
  LuCopy,
  LuDownload,
  LuFile,
  LuFileText,
  LuFileVideo,
  LuFolderOpen,
  LuGitBranch,
  LuGrip,
  LuImage,
  LuLayers,
  LuLayoutDashboard,
  LuLoaderCircle,
  LuMaximize2,
  LuRefreshCw,
  LuSparkles,
  LuTrash2,
  LuUndo2,
  LuVideo,
  LuX,
} from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LumaSelect, ModelChannelSelect } from "@/components/model-channel-select";
import { Textarea } from "@/components/ui/textarea";
import {
  getActiveImageChannel,
  getReadyImageChannels,
  getReadyVideoChannels,
  useSettingsStore,
} from "@/lib/stores/settings-store";
import { imageDimensionsForPreset } from "@/lib/image-output-size";
import {
  IDENTITY_PERFORMANCE_BASELINE_VERSION,
  identityAuxiliaryPanelText,
  identityPerformanceBaselineText,
} from "@/lib/identity-performance";
import { cn } from "@/lib/utils";
import { VIDEO_DIRECTOR_SCHEMA_VERSION } from "@/lib/video-director-contract";
import {
  completedImageExecutionOutputNodes,
  shouldKeepPollingImageTaskAfterHttpError,
} from "@/lib/board-image-sync";
import {
  beginBoardClientExecution,
  boardVideoRemoteTaskId,
  boardNodeExecutionStatus,
  boardNodeVisibleExecutionStatus,
  runningBoardExecutionNodes,
} from "@/lib/board-task-state";
import { boardControlInputHealth as controlInputHealth } from "@/lib/board-control-input";
import {
  BOARD_LAYOUT_COLUMNS,
  BOARD_LAYOUT_HEADER_WIDTH,
  BOARD_LAYOUT_MIN_CANVAS_HEIGHT,
  BOARD_LAYOUT_MIN_CANVAS_WIDTH,
  boardLayoutStageLeft,
  boardNodeWidth,
  buildBoardLayoutPreview,
  estimatedBoardNodeHeight,
  type BoardLayoutMode,
  type BoardLayoutPreviewState,
} from "@/lib/board-layout-engine";
import { generatedOutputPosition } from "@/lib/board-node-placement";
import {
  isDirectVideoReplacementAudioReference,
  directVideoReplacementPackageFromNodes,
  directVideoReplacementReferenceRole,
  grokReferencePackageFromNodes,
  isVideoVisualBase,
  resolveDirectVideoReplacementReferenceIds,
  usesVideoReferenceRolePackage,
  videoReferenceRole,
} from "@/lib/video-reference-contract";
import {
  getBoardVideoProfile,
  type BoardVideoChannelCapabilities,
  type BoardVideoResolution,
} from "@/lib/board-video-protocol";
import { referenceEvidenceDurationForAnalysis, referenceTargetDurationSeconds, type BoardVideoDurationSource } from "@/lib/board-video-duration";
import { ANALYSIS_FOCUS_MAX_CHARS } from "@/lib/video-director-input";
import {
  readStoredVideoShotSegmentPlan,
  splitTargetDurationIntoVideoSegments,
  type VideoShotSegmentPlan,
} from "@/lib/video-shot-segments";
import { isBoardOutputRecoverySuppressed } from "@/lib/board-output-recovery";
import { manualDirectGeneratedVideoNodes } from "@/lib/board-manual-links";
import {
  chooseBoardVideoSaveLocation,
  clearBoardVideoSaveLocation,
  ensureBoardVideoSaveLocationPermission,
  isBoardVideoSaveCandidate,
  loadBoardVideoSaveLocation,
  saveBoardVideoToLocation,
  type BoardVideoSaveLocation,
  wasBoardVideoCreatedAfterSaveLocationSelection,
} from "@/lib/board-video-save-location";
import { createEdge, createNode } from "@/lib/board-workflow-graph";
import type { BoardVideoJob, BoardWorkflow, BoardWorkflowEdge, BoardWorkflowNode } from "@/lib/board-workflows";
import {
  currentProductGroup as resolveCurrentProductGroup,
  currentReferenceVideoNode,
  setCurrentProductGroup,
} from "@/lib/board-input-assets";
import {
  DETAIL_IMAGE_BATCH_ROLE,
  DETAIL_IMAGE_BATCH_VERSION,
  DETAIL_IMAGE_REFERENCE_ROLE,
  detailImageBatchItemOutputSize,
  detailImageBatchReplacementMode,
  detailImageBatchNodes,
  detailImageOutputSizeForSource,
  type DetailImageBatch,
  type DetailImageBatchItem,
} from "@/lib/board-detail-image-batches";

type DragState = {
  id: string;
  pointerId: number;
  element: HTMLElement;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  moved: boolean;
};

type ConnectingState = {
  from: string;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
};

type BoardConnectionPoint = {
  x: number;
  y: number;
};

type BoardConnectionAnchors = Record<string, {
  input: BoardConnectionPoint;
  output: BoardConnectionPoint;
}>;

type BoardSaveResult = {
  workflow: BoardWorkflow;
  fileDeletion?: {
    deleted?: string[];
    skipped?: Array<{ filePath: string; reason: string }>;
  };
};

type BoardNodePositionSnapshot = {
  id: string;
  x: number;
  y: number;
  zIndex: number;
};

const MANUAL_EDGE_LABEL = "手动连线";
const LEGACY_MANUAL_EDGE_LABEL = "\u93b5\u5b2a\u59e9\u677b\u70b5\u7eaa";
const CONTROL_DRAG_MIME = "application/x-board-control-template";
const MANUAL_EDGE_LABELS = new Set([MANUAL_EDGE_LABEL, LEGACY_MANUAL_EDGE_LABEL, "手动连接"]);
const NODE_BASE_Z_INDEX = 80;
const NODE_FRONT_Z_INDEX_STEP = 100;
const GPT_STORYBOARD_SEND_LIMIT = 1;
const ACTION_DETAIL_INTERVAL_SECONDS = 0.5;
const IMAGE_REFERENCE_LIMIT = 8;
const IMAGE_OUTPUT_LIMIT = 1;
const BOARD_NODE_CONNECTION_Y = 70;
const LAST_SELECTED_VIDEO_CHANNEL_META_KEY = "lastSelectedVideoChannelId";
const PERSON_REFERENCE_ROLES = new Set([
  "identity_image",
  "identity_auxiliary_asset",
  "face_front",
  "face_left",
  "face_right",
  "face_turnaround",
]);

function formatElapsed(milliseconds?: number) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return "--";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function imageTimingText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const timing = value as Record<string, unknown>;
  const read = (key: string) => typeof timing[key] === "number" ? timing[key] as number : undefined;
  const throughput = read("responseAverageBytesPerSecond");
  const chunkCount = read("responseChunkCount");
  const maxGap = read("responseMaxChunkGapMs");
  return [
    read("clickToUpstreamHeadersMs") !== undefined
      ? `点击→上游成功(HTTP 200) ${formatElapsed(read("clickToUpstreamHeadersMs"))}`
      : read("upstreamProcessingMs") !== undefined ? `上游 ${formatElapsed(read("upstreamProcessingMs"))}` : "",
    read("responseFirstByteWaitMs") !== undefined ? `HTTP 200→首字节 ${formatElapsed(read("responseFirstByteWaitMs"))}` : "",
    read("responseBodyTransferMs") !== undefined
      ? `Base64 首字节→完整 ${formatElapsed(read("responseBodyTransferMs"))}`
      : read("resultTransferMs") !== undefined ? `回传 ${formatElapsed(read("resultTransferMs"))}` : "",
    chunkCount !== undefined ? `分块 ${chunkCount}` : "",
    maxGap !== undefined ? `最大停顿 ${formatElapsed(maxGap)}` : "",
    throughput !== undefined ? `平均 ${(throughput / 1024).toFixed(1)} KB/s` : "",
    read("localSaveMs") !== undefined ? `本地保存 ${formatElapsed(read("localSaveMs"))}` : "",
    read("clickToBoardPersistedMs") !== undefined ? `点击→写入画板 ${formatElapsed(read("clickToBoardPersistedMs"))}` : "",
    read("clickToClientVisibleMs") !== undefined ? `点击→画板显示 ${formatElapsed(read("clickToClientVisibleMs"))}` : "",
  ].filter(Boolean).join(" · ");
}

type ControlRole = "input_assets" | "select_frame" | "gpt_analyze" | "gpt_director" | "image_pipeline" | "video_generate";

interface IdentityPackReference {
  id: string;
  title: string;
  role: string;
  url: string;
  requiredFor: string[];
  sourceKind?: string;
  generated?: boolean;
  status: "draft" | "approved" | "archived";
}
interface IdentityPackAuxiliaryPanel {
  referenceId: string;
  title: string;
  role: string;
  label: string;
  order: number;
}
interface IdentityPackAuxiliaryAsset {
  id: string;
  title: string;
  role: string;
  url: string;
  kind: "expression_sheet" | "base_multiview_sheet" | "camera_pose_sheet" | "custom_sheet";
  layout: "portrait" | "full_body" | "mixed";
  panels: IdentityPackAuxiliaryPanel[];
}
type IdentityPackSelectable = IdentityPackReference & {
  assetType: "reference" | "auxiliary";
  panels?: IdentityPackAuxiliaryPanel[];
};
interface IdentityPackOption {
  id: string;
  packName: string;
  references: IdentityPackReference[];
  auxiliaryAssets?: IdentityPackAuxiliaryAsset[];
}
interface BoardImagePendingSummary {
  id: string;
  executorNodeId: string;
  title: string;
  transport: "b64_json" | "url";
  createdAt: string;
  lastError?: string;
  generationTiming?: {
    upstreamProcessingMs?: number;
    resultTransferMs?: number;
    upstreamTotalMs?: number;
    responseBodyBytes?: number;
    localSaveMs?: number;
    totalMs?: number;
  };
}
type ImageTask =
  | "clean_scene"
  | "product_white_background"
  | "outfit_front"
  | "outfit_side"
  | "outfit_back"
  | "composite_image"
  | "repaired_image"
  | "detail_product_replacement";

type BuiltImageTask = {
  title: string;
  description: string;
  referenceNodeIds: string[];
  x: number;
  y: number;
  prompt: string;
  promptMetadata?: Record<string, unknown>;
};

const IMAGE_TASK_GUIDES: Record<ImageTask, { label: string; overviewLabel: string; wiring: string; purpose: string }> = {
  clean_scene: {
    label: "提取场景空镜",
    overviewLabel: "生成场景空镜",
    wiring: "参考视频场景帧 1 张（当前镜头人工选帧）",
    purpose: "去除原人物，补全被遮挡背景",
  },
  product_white_background: {
    label: "生成商品白底图",
    overviewLabel: "生成商品白底图",
    wiring: "商品图 1–3 张",
    purpose: "去除模特、手部和环境，保留无阴影纯白底商品",
  },
  outfit_front: {
    label: "穿搭正面",
    overviewLabel: "生成全身穿搭正面白底图",
    wiring: "商品图 + 人物身份参考（推荐人脸正面定型图 + 全身正面比例图）",
    purpose: "生成全身正面白底穿搭图",
  },
  outfit_side: {
    label: "穿搭侧面",
    overviewLabel: "生成全身穿搭侧面白底图",
    wiring: "商品图 + 人物身份参考（推荐人脸正面定型图 + 全身侧面比例图）",
    purpose: "生成同一商品、同一人物的侧面白底图",
  },
  outfit_back: {
    label: "穿搭背面",
    overviewLabel: "生成全身穿搭背面白底图",
    wiring: "商品图 + 人物身份参考（推荐人脸正面定型图 + 全身背面比例图）",
    purpose: "生成同一商品、同一人物的背面白底图",
  },
  composite_image: {
    label: "合成主图",
    overviewLabel: "合成场景 + 人物 + 商品主图",
    wiring: "商品图 + 人脸正面定型图 + 当前镜头穿搭图 + 场景空镜 + 参考视频场景帧",
    purpose: "按参考镜头构图合成人物商品主图",
  },
  repaired_image: {
    label: "修复细节",
    overviewLabel: "修复当前主图细节",
    wiring: "合成主图或已有修复图 1 张",
    purpose: "修复画面细节，不改变主体构图",
  },
  detail_product_replacement: {
    label: "详情图换装",
    overviewLabel: "详情图换装",
    wiring: "产品白底图 + 当前批次项",
    purpose: "保留详情图模特与构图，仅替换原商品",
  },
};

const PRIMARY_IMAGE_TASKS: ImageTask[] = ["product_white_background", "clean_scene", "outfit_front", "composite_image"];
const OPTIONAL_IMAGE_TASKS: ImageTask[] = ["outfit_side", "outfit_back", "repaired_image"];

type EvidenceSheetItem = {
  index?: number;
  total?: number;
  title?: string;
  filePath?: string;
  publicUrl?: string;
};

type VideoSegmentPlan = VideoShotSegmentPlan;

const CONTROL_TEMPLATES: Array<{
  role: ControlRole;
  title: string;
  shortTitle: string;
  description: string;
  icon: "upload" | "camera" | "bot" | "image" | "video";
}> = [
  {
    role: "input_assets",
    title: "导入创作素材",
    shortTitle: "导入素材",
    description: "上传参考视频、商品图和人物身份参考；按需抽帧或剥离完整音频。",
    icon: "upload",
  },
  {
    role: "select_frame",
    title: "大预览人工选帧",
    shortTitle: "人工选帧",
    description: "从参考视频中选择一帧画面，作为场景复刻锚点。",
    icon: "camera",
  },
  {
    role: "gpt_analyze",
    title: "LLM 拆参考视频方法",
    shortTitle: "拆参考视频",
    description: "根据故事板、真实切点和中文口播拆解；可手动加连 0.5 秒动作补证，精拆切镜两侧状态及商品相对动作。",
    icon: "bot",
  },
  {
    role: "gpt_director",
    title: "完整视频导演稿",
    shortTitle: "完整导演稿",
    description: "根据参考视频拆解和可选口播生成逐镜头英文完整导演稿。",
    icon: "bot",
  },
  {
    role: "image_pipeline",
    title: "image-2 资产流水线",
    shortTitle: "image-2 资产",
    description: "生成场景空镜、分角度人物商品资产、合成主图和修复图。",
    icon: "image",
  },
  {
    role: "video_generate",
    title: "生成视频",
    shortTitle: "生成视频",
    description: "人工选择 Grok 或即梦通道，按完整导演稿和对应参考图协议生成视频任务。",
    icon: "video",
  },
];

const GPT_ANALYZE_CAPABILITY_ITEMS = [
  `输入 1：手动直连 1 份 ${GPT_STORYBOARD_SEND_LIMIT} 张 1 秒全片总览。可选手动直连同一批次的 ${ACTION_DETAIL_INTERVAL_SECONDS} 秒动作补证（只含总览遗漏的半秒帧与切点两侧关键帧）；LLM 先按视觉构图区分切前/切后证据，再锁定动作链。`,
  "输入 2：参考视频含音频时，另手动直连中文口播转写节点；本地 faster-whisper 只做中文识别并保留时间段。",
  "输入 3：程序检测的真实切镜与源视频完整时长；硬切两侧状态不得补间或提前进入下一镜。",
  "输出：英文结构化拆解，强制包含商品具体接触部位、路径/幅度、接触/释放顺序、肢体遮挡和禁止推断。",
];

const statusLabel: Record<string, string> = {
  draft: "草稿",
  evidence: "已准备证据",
  analyzed: "已拆解",
  assets: "已生成资产",
  video: "已生成视频",
  done: "已完成",
};

const nodeStatusLabel: Record<string, string> = {
  pending: "待执行",
  running: "运行中",
  syncing: "正在同步结果",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const roleLabel: Record<string, string> = {
  product_image: "商品图",
  product_evidence_board: "商品多视图证据板",
  identity_image: "人物身份参考",
  identity_auxiliary_asset: "人物辅助参考板",
  selected_scene_frame: "视频参考帧",
  clean_scene: "场景空镜",
  product_white_background: "商品白底图",
  outfit_turnaround: "穿搭三视角",
  outfit_front: "穿搭正面",
  outfit_side: "穿搭侧面",
  outfit_back: "穿搭背面",
  face_turnaround: "人脸三视角",
  face_front: "人脸正面",
  face_left: "人脸左侧",
  face_right: "人脸右侧",
  composite_image: "合成主图",
  repaired_image: "修复图",
  detail_reference_image: "详情图批次项",
  detail_image_batch: "详情图换装批次",
  detail_product_replacement: "详情图换装结果",
  generated_video: "生成视频",
  composed_video: "合成成片",
  audio_evidence: "完整音频",
  voiceover_method: "口播转写与方法",
  product_voiceover_script: "商品口播重写稿",
  voiceover_transcript: "口播转写稿",
  action_detail_storyboard_collection: "旧版 0.5 秒动作证据",
  action_supplement_storyboard_collection: "0.5 秒动作补证",
  reference_method_analysis: "参考视频拆解报告",
  video_director_prompt: "完整视频导演稿",
};

const VIDEO_TASK_REFERENCE_ROLES = ["visual_base", "product", "face", "model", "scene"] as const;
const VIDEO_TASK_REFERENCE_ROLE_LABEL: Record<(typeof VIDEO_TASK_REFERENCE_ROLES)[number], string> = {
  visual_base: "合成 / 修复图",
  product: "商品图",
  face: "人脸正面图",
  model: "当前镜头模特图",
  scene: "场景空镜图",
};

function controlTemplate(role: string) {
  return CONTROL_TEMPLATES.find((template) => template.role === role);
}

function controlRoleOf(node: BoardWorkflowNode) {
  return String(node.meta?.controlRole || "") as ControlRole | "";
}

function nodeKindLabel(node: BoardWorkflowNode) {
  if (node.kind === "control") return "功能节点";
  const role = String(node.meta?.assetRole || "");
  if (role && roleLabel[role]) return roleLabel[role];
  const labels: Record<string, string> = {
    source_video: "参考视频",
    storyboard: "故事板",
    keyframe: "关键帧",
    audio: "音频",
    analysis: "GPT 拆解",
    prompt: "提示词",
    image_asset: "图片资产",
    video_clip: "视频片段",
    note: "说明",
  };
  return labels[node.kind] || node.kind;
}

function isImageNode(node: BoardWorkflowNode) {
  return ["storyboard", "keyframe", "image_asset"].includes(node.kind) && Boolean(node.publicUrl);
}

async function readImageFileDimensions(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width > 0 && bitmap.height > 0) return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      cleanup();
      if (width > 0 && height > 0) resolve({ width, height });
      else reject(new Error(`无法读取“${file.name}”的图片尺寸。`));
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`无法读取“${file.name}”的图片尺寸。`));
    };
    image.src = objectUrl;
  });
}

function isVideoNode(node: BoardWorkflowNode) {
  return ["source_video", "video_clip"].includes(node.kind) && Boolean(node.publicUrl);
}

function isAudioNode(node: BoardWorkflowNode) {
  return node.kind === "audio" && Boolean(node.publicUrl);
}

function currentBoardMediaUrl(node: BoardWorkflowNode) {
  const publicUrl = String(node.publicUrl || "");
  const version = String(node.meta?.evidenceSetId || node.id || "");
  if (!publicUrl || !version) return publicUrl;
  return `${publicUrl}${publicUrl.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

function roleOf(node: BoardWorkflowNode) {
  return String(node.meta?.assetRole || "");
}

function isPersonReferenceNode(node?: BoardWorkflowNode | null) {
  return Boolean(node && PERSON_REFERENCE_ROLES.has(roleOf(node)));
}

function isFrontFaceIdentityReference(node?: BoardWorkflowNode | null) {
  if (!node || !isPersonReferenceNode(node)) return false;
  const sourceKind = String(node?.meta?.identityReferenceSourceKind || "");
  const text = `${node?.title || ""} ${node?.description || ""}`.toLowerCase();
  return roleOf(node) === "face_front"
    || sourceKind === "face_front"
    || /人脸正面|face.*front/.test(text);
}

function identityReferenceTypeLabel(reference: IdentityPackSelectable) {
  if (reference.assetType === "auxiliary") return `人物辅助板 · ${reference.role || "辅助参考"}`;
  const labels: Record<string, string> = {
    face_front: "人脸正面 · 可用于换脸",
    full_body_front: "全身正面",
    full_body_left_45: "全身左侧 45°",
    full_body_right_45: "全身右侧 45°",
    full_body_side: "全身侧面",
    full_body_back: "全身背面",
    camera_eye_level: "平视半身",
    camera_high_angle: "轻俯视半身",
    camera_low_angle: "轻仰视全身",
  };
  const type = labels[String(reference.sourceKind || "")] || reference.role || "人物身份参考";
  return reference.generated ? `${type} · 补图` : type;
}

function productViewKind(node: BoardWorkflowNode) {
  const text = `${node.title || ""} ${node.description || ""} ${node.promptEnglish || ""}`.toLowerCase();
  if (/背面|后面|back|rear/.test(text)) return "back";
  if (/侧面|侧身|side|profile/.test(text)) return "side";
  if (/正面|前面|front/.test(text)) return "front";
  return "unknown";
}

function productViewRank(node: BoardWorkflowNode) {
  const kind = productViewKind(node);
  if (kind === "front") return 0;
  if (kind === "back") return 1;
  if (kind === "side") return 2;
  return 3;
}

function sortProductReferenceNodes(nodes: BoardWorkflowNode[]) {
  return [...nodes].sort((a, b) => {
    const rank = productViewRank(a) - productViewRank(b);
    if (rank !== 0) return rank;
    const timeA = Date.parse(a.createdAt || "");
    const timeB = Date.parse(b.createdAt || "");
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
    return displayTitle(a).localeCompare(displayTitle(b), "zh-Hans-CN");
  });
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function nodeFilePaths(node: BoardWorkflowNode) {
  const paths: string[] = [];
  if (node.filePath) paths.push(node.filePath);
  if (Array.isArray(node.meta?.items)) {
    for (const item of node.meta.items) {
      if (item && typeof item === "object") {
        const filePath = (item as Record<string, unknown>).filePath;
        if (typeof filePath === "string") paths.push(filePath);
      }
    }
  }
  return uniqueIds(paths);
}

function nodeZIndex(node: BoardWorkflowNode) {
  const zIndex = Number(node.meta?.zIndex);
  return Number.isFinite(zIndex) ? zIndex : NODE_BASE_Z_INDEX;
}

function withNodeZIndex(node: BoardWorkflowNode, zIndex: number): BoardWorkflowNode {
  return {
    ...node,
    meta: {
      ...(node.meta || {}),
      zIndex,
    },
  };
}

function videoReferenceCapabilityItems(profile = null as ReturnType<typeof getBoardVideoProfile>) {
  if (profile?.directVideoReplacement) {
    const productFrontFaceContract = profile.directVideoReplacementReferenceContract === "product_front_face";
    const productFrontFaceOptional = productFrontFaceContract && profile.directVideoReplacementFaceOptional;
    return [
      "此通道为“直接参考视频替换”：不需要拆解报告、完整导演稿、分段任务或再次合成。",
      productFrontFaceContract
        ? `手动直连 1 条参考视频和商品正面图${productFrontFaceOptional ? "；人脸图可选，未连接时沿用参考视频人物身份并仅做克制自然优化" : "和人脸图"}；不发送商品多视图证据板或全身穿搭图。场景图可选，未连接时使用参考视频背景并延续到片尾。`
        : profile.directVideoReplacementSceneOptional
        ? "手动直连 1 条参考视频、商品多视图故事板、人脸图和人物图；场景图可选，未连接时使用参考视频背景并延续到片尾。"
        : "手动直连 1 条参考视频，以及商品多视图故事板、人脸图、人物图、场景图各 1 张；未手动指定商品图时，默认发送最新的商品多视图故事板。",
      productFrontFaceContract
        ? productFrontFaceOptional
          ? "参考视频提供镜头、动作、身体姿态、非商品穿搭、节奏、时序、构图和未连接场景图时的背景；商品正面图重建商品。未选人脸图时，参考视频人物身份保持不变，只做克制自然优化。"
          : "参考视频只提供镜头、动作、身体姿态、非商品穿搭、节奏、时序、构图和未连接场景图时的背景；商品正面图与人脸图分别重建商品和身份。"
        : profile.directVideoReplacementSceneOptional
        ? "参考视频只提供镜头、动作、节奏、时序、构图和未连接场景图时的背景；商品多视图故事板、人脸图和人物图分别重建商品、脸和人物。"
        : "参考视频只提供镜头、动作、节奏、时序和构图；四张图分别重建商品、脸、人物与背景，不复制参考视频里的这些视觉主体。",
      `在节点内选择本次生成时长；参考片段不得长于所选时长。画板会先读取本地时长，超长不提交。`,
      profile.maxReferenceAudios > 0
        ? `可选：手动连入并选择 1 条参考音频后，声音按音频发送；未选择时不会生成字幕、台词、口型、音乐或音效。`
        : "当前通道未声明参考音频能力；画板不会发送音频，也不会生成字幕、台词、口型、音乐或音效。",
      productFrontFaceContract
        ? productFrontFaceOptional
          ? "提交时会临时托管为公网 HTTPS 素材，实际发送 1 条视频 + 商品正面图；人脸图与场景图均仅在手动选择时追加，最多 3 张图；仅在手动选择时追加音频。"
          : "提交时会临时托管为公网 HTTPS 素材，实际发送 1 条视频 + 商品正面图、人脸图 2 张必需图，并仅在手动连接场景图时追加第 3 张图；仅在手动选择时追加音频。"
        : profile.directVideoReplacementSceneOptional
        ? "提交时会临时托管为公网 HTTPS 素材，实际发送 1 条视频 + 3 张必需图，并仅在手动连接场景图时追加第 4 张图；仅在手动选择时追加音频。"
        : "提交时会临时托管为公网 HTTPS 素材，实际发送 1 条视频 + 4 张图，并且仅在手动选择时追加 1 条音频；不为凑上限传入其他素材。",
    ];
  }
  const usesRolePackage = Boolean(profile && usesVideoReferenceRolePackage(profile));
  return [
    "必连：1 份最新完整视频导演稿；可连入多份候选合成/修复图和场景空镜图。每个任务独立选择合成/修复、商品、人脸正面、当前镜头模特、场景空镜各 1 张。",
    usesRolePackage
      ? `当前模型：每个任务固定发送 5 张职责图，顺序为合成/修复 → 商品 → 人脸正面 → 当前镜头模特 → 场景空镜；上游最多支持 ${profile?.maxReferenceImages ?? "-"} 张，画板不为凑满上限混入额外图片。`
      : "当前模型：仅发送 1 张合成/修复图到 image_url；其他图片不直传上游。",
    "服装有背面、侧面或细节时，先由“商品多视图证据板”合为 1 张商品职责图；所有任务图片会压缩后临时托管为公网 HTTPS URL。当前画板不自动发送参考视频、故事板或人工截图。",
    "单任务时长由模型池的“可用时长”决定；画板自动选择最大可用档，最后一段也完整生成、完整保留，不裁尾。",
    "导演稿负责镜头、动作、表演、口播、光线和时序；参考图只校正各自职责内的可见事实。",
  ];
}

function latestByRole(nodes: BoardWorkflowNode[], role: string) {
  return [...nodes].reverse().find((node) => roleOf(node) === role);
}

function mediaBoxStyle(node: BoardWorkflowNode) {
  const aspectRatio = Number(node.meta?.aspectRatio);
  if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
    const isFrameCollection = ["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(roleOf(node));
    const width = node.kind === "storyboard" ? 300 : isFrameCollection ? (aspectRatio < 0.8 ? 260 : 300) : aspectRatio < 0.8 ? 190 : 240;
    const height = Math.max(120, Math.min(380, Math.round(width / aspectRatio)));
    return { width: `${width}px`, height: `${height}px` };
  }
  return { width: "240px", height: node.kind === "storyboard" ? "160px" : "260px" };
}

function frameCollectionItems(node: BoardWorkflowNode): EvidenceSheetItem[] {
  if (!["action_detail_storyboard_collection", "action_supplement_storyboard_collection"].includes(roleOf(node)) || !Array.isArray(node.meta?.items)) return [];
  const fallbackPrefix = roleOf(node) === "action_supplement_storyboard_collection" ? "动作补证" : "动作证据";
  return node.meta.items
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => ({
      index: typeof item.index === "number" ? item.index : index + 1,
      total: typeof item.total === "number" ? item.total : undefined,
      title: typeof item.title === "string" ? item.title : `${fallbackPrefix} ${index + 1}`,
      filePath: typeof item.filePath === "string" ? item.filePath : undefined,
      publicUrl: typeof item.publicUrl === "string" ? item.publicUrl : undefined,
    }))
    .filter((item) => item.publicUrl || item.filePath);
}

function nodePreviewText(node: BoardWorkflowNode) {
  if (node.kind === "analysis") return node.text || "";
  if (node.kind === "prompt") {
    return [
      node.promptChinese ? `# 中文预览\n${node.promptChinese}` : "",
      node.promptEnglish ? `# English Prompt\n${node.promptEnglish}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return node.text || node.promptChinese || node.promptEnglish || "";
}
function previewAspectRatio(node: BoardWorkflowNode) {
  const explicit = Number(node.meta?.aspectRatio);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const width = Number(node.meta?.width || node.meta?.naturalWidth);
  const height = Number(node.meta?.height || node.meta?.naturalHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return width / height;
  return null;
}

function boardNodeAnchor(node: BoardWorkflowNode, side: "input" | "output") {
  return {
    x: node.x + (side === "output" ? boardNodeWidth(node) : 0),
    y: node.y + BOARD_NODE_CONNECTION_Y,
  };
}

function previewDialogStyle(node: BoardWorkflowNode, isAudio: boolean): CSSProperties {
  const aspectRatio = previewAspectRatio(node);
  let maxWidth = 1120;
  if (isAudio) maxWidth = 760;
  else if (aspectRatio && aspectRatio < 0.72) maxWidth = 640;
  else if (aspectRatio && aspectRatio > 1.35) maxWidth = 1320;
  else if (aspectRatio && aspectRatio >= 0.9 && aspectRatio <= 1.1) maxWidth = 980;
  return { width: `min(92vw, ${maxWidth}px)` };
}

function displayTitle(node: BoardWorkflowNode) {
  const template = controlTemplate(controlRoleOf(node));
  if (template) return template.title;
  const role = roleOf(node);
  if (role && roleLabel[role]) return node.title || roleLabel[role];
  return node.title;
}

function displayDescription(node: BoardWorkflowNode) {
  return controlTemplate(controlRoleOf(node))?.description || node.description || "";
}

const IMAGE_BOARD_SYNC_POLL_MS = 3_000;
const IMAGE_BOARD_SYNC_TIMEOUT_MS = 35 * 60 * 1000;
const IMAGE_BOARD_IMAGE_LOAD_TIMEOUT_MS = 60_000;

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function initialVideoRecoveryDelayMs(
  job: BoardVideoJob | undefined,
  protocol: string | undefined,
) {
  if (protocol !== "lingganya") return 3_000;
  const submittedAt = Date.parse(String(job?.submittedAt || ""));
  if (!Number.isFinite(submittedAt)) return 30_000;
  // The upstream contract asks for a 30-second first status query. A task
  // restored after that window is already eligible and must be checked now.
  return Math.max(0, 30_000 - Math.max(0, Date.now() - submittedAt));
}

function preloadBoardImage(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const image = new window.Image();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("图片已经保存，但画板预览加载超时。"));
    }, IMAGE_BOARD_IMAGE_LOAD_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      image.onload = null;
      image.onerror = null;
    };
    const onAbort = () => {
      cleanup();
      image.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("图片已经保存，但画板无法加载本地预览。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = url;
  });
}

export type BoardWorkflowEditorProps = {
  workflowId: string;
  embedded?: boolean;
  onBackToList?: () => void;
};

export function BoardWorkflowEditor({ workflowId, embedded = false, onBackToList }: BoardWorkflowEditorProps) {
  const id = workflowId;
  const { llm, providers } = useSettingsStore();
  const providerSetting = providers["openai-seedance"];
  const imageChannels = getReadyImageChannels(providerSetting, { allowServerManagedCredentials: true });
  const videoChannels = getReadyVideoChannels(providerSetting, "full_video", { allowServerManagedCredentials: true })
    .filter((channel) => Boolean(getBoardVideoProfile(channel)));
  const [selectedImageChannelId, setSelectedImageChannelId] = useState("");
  const [selectedVideoChannelId, setSelectedVideoChannelId] = useState("");
  const [manualVideoPollNodeId, setManualVideoPollNodeId] = useState("");
  const selectedImageChannel = getActiveImageChannel(providerSetting, selectedImageChannelId);
  const selectedVideoChannel = videoChannels.find((channel) => channel.id === selectedVideoChannelId)
    ?? videoChannels.find((channel) => channel.id === providerSetting?.activeVideoChannelId)
    ?? videoChannels[0]
    ?? null;

  useEffect(() => {
    if (selectedVideoChannelId && videoChannels.some((channel) => channel.id === selectedVideoChannelId)) return;
    const preferred = videoChannels.find((channel) => channel.id === providerSetting?.activeVideoChannelId)
      ?? videoChannels[0];
    if (preferred) setSelectedVideoChannelId(preferred.id);
  }, [providerSetting?.activeVideoChannelId, selectedVideoChannelId, videoChannels]);

  const [workflow, setWorkflow] = useState<BoardWorkflow | null>(null);
  const [identityPacks, setIdentityPacks] = useState<IdentityPackOption[]>([]);
  const [selectedIdentityPackId, setSelectedIdentityPackId] = useState("");
  const [identityPackRefs, setIdentityPackRefs] = useState<IdentityPackSelectable[]>([]);
  const [selectedIdentityPackRefId, setSelectedIdentityPackRefId] = useState("");
  const [sourceVideoPath, setSourceVideoPath] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [productGroupCandidateId, setProductGroupCandidateId] = useState("");
  const [draftProductGroupId, setDraftProductGroupId] = useState(() => crypto.randomUUID());
  const [identitySourceMode, setIdentitySourceMode] = useState<"pack" | "upload">("pack");
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const storyboardInterval = 1;
  const [captureTime, setCaptureTime] = useState(0);
  const [analysisFocus, setAnalysisFocus] = useState("");
  const [directorPreference, setDirectorPreference] = useState("");
  const [imageRepairInstruction, setImageRepairInstruction] = useState("");
  const [detailBatchTitle, setDetailBatchTitle] = useState("");
  const [detailBatchProductNodeId, setDetailBatchProductNodeId] = useState("");
  const [detailBatchFiles, setDetailBatchFiles] = useState<File[]>([]);
  const [selectedDetailBatchId, setSelectedDetailBatchId] = useState("");
  const detailBatchFileInputRef = useRef<HTMLInputElement>(null);
  const [targetVideoDuration, setTargetVideoDuration] = useState(20);
  const [manualDurationHydrated, setManualDurationHydrated] = useState(false);
  const [directorDurationSource, setDirectorDurationSource] = useState<BoardVideoDurationSource>("manual");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [busy, setBusy] = useState("");
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [isSavingWorkflowName, setIsSavingWorkflowName] = useState(false);
  const [runningTask, setRunningTask] = useState<{ nodeId: string; busyKey: string; label: string; clientTaskId: string } | null>(null);
  const [error, setError] = useState("");
  const [boardNotice, setBoardNotice] = useState("");
  const [imageRecoveryNotice, setImageRecoveryNotice] = useState("");
  const [pendingImageResults, setPendingImageResults] = useState<BoardImagePendingSummary[]>([]);
  const [previewNode, setPreviewNode] = useState<BoardWorkflowNode | null>(null);
  const [layoutPreview, setLayoutPreview] = useState<BoardLayoutPreviewState | null>(null);
  const [layoutUndoPositions, setLayoutUndoPositions] = useState<BoardNodePositionSnapshot[] | null>(null);
  const [appliedLayoutCanvasHeight, setAppliedLayoutCanvasHeight] = useState(BOARD_LAYOUT_MIN_CANVAS_HEIGHT);
  const [expandedControlNodeIds, setExpandedControlNodeIds] = useState<string[]>([]);
  const [deleteDialogNode, setDeleteDialogNode] = useState<BoardWorkflowNode | null>(null);
  const [deleteDialogAlsoDeleteFiles, setDeleteDialogAlsoDeleteFiles] = useState(false);
  const [deleteDialogError, setDeleteDialogError] = useState("");
  const [isDeletingNode, setIsDeletingNode] = useState(false);
  const [videoSaveLocation, setVideoSaveLocation] = useState<BoardVideoSaveLocation | null>(null);
  const [isLoadingVideoSaveLocation, setIsLoadingVideoSaveLocation] = useState(true);
  const [isChoosingVideoSaveLocation, setIsChoosingVideoSaveLocation] = useState(false);
  const [isSyncingVideoSaveLocation, setIsSyncingVideoSaveLocation] = useState(false);
  const [videoSaveLocationStatus, setVideoSaveLocationStatus] = useState("");
  const [imagePipelineMode, setImagePipelineMode] = useState<"batch" | "single">("batch");
  const [expandedImageTask, setExpandedImageTask] = useState<ImageTask | null>("product_white_background");

  useEffect(() => {
    const stored = window.localStorage.getItem(`board-image-pipeline-mode:${workflowId}`);
    if (stored === "batch" || stored === "single") setImagePipelineMode(stored);
  }, [workflowId]);

  useEffect(() => {
    window.localStorage.setItem(`board-image-pipeline-mode:${workflowId}`, imagePipelineMode);
  }, [imagePipelineMode, workflowId]);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(`board-video-manual-duration:${workflowId}`));
    if (Number.isFinite(stored) && stored >= 1 && stored <= 120) setTargetVideoDuration(Math.round(stored));
    setManualDurationHydrated(true);
  }, [workflowId]);

  useEffect(() => {
    if (!manualDurationHydrated) return;
    window.localStorage.setItem(`board-video-manual-duration:${workflowId}`, String(Math.min(120, Math.max(1, Math.round(targetVideoDuration || 20)))));
  }, [manualDurationHydrated, targetVideoDuration, workflowId]);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [connectionAnchors, setConnectionAnchors] = useState<BoardConnectionAnchors>({});
  const [focusMode, setFocusMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const controlDragRoleRef = useRef<ControlRole | null>(null);
  const taskActiveRef = useRef(false);
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const boardCanvasRef = useRef<HTMLDivElement | null>(null);
  const taskAbortRef = useRef<AbortController | null>(null);
  const taskTokenRef = useRef(0);
  // The owner token prevents a cancelled Strict Mode probe from clearing a
  // newer recovery poll for the same remote task.
  const videoPollingOwnersRef = useRef(new Map<string, symbol>());
  const videoRecoveryControllersRef = useRef(new Map<string, AbortController>());
  const recoveryObserverRef = useRef<AbortController | null>(null);
  const boardMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workflowRevisionRef = useRef(0);
  const videoSaveLocationRef = useRef<BoardVideoSaveLocation | null>(null);
  const observedVideoOutputIdsRef = useRef<Set<string> | null>(null);
  const synchronizedVideoSaveSelectionRef = useRef("");
  const videoSaveInFlightNodeIdsRef = useRef(new Set<string>());

  const adoptWorkflow = useCallback((nextWorkflow?: BoardWorkflow | null) => {
    if (!nextWorkflow) return;
    workflowRevisionRef.current = Number(nextWorkflow.revision || 0);
    setWorkflow(nextWorkflow);
  }, []);

  useEffect(() => {
    let active = true;
    observedVideoOutputIdsRef.current = null;
    synchronizedVideoSaveSelectionRef.current = "";
    videoSaveLocationRef.current = null;
    setVideoSaveLocation(null);
    setVideoSaveLocationStatus("");
    setIsLoadingVideoSaveLocation(true);
    void loadBoardVideoSaveLocation(id)
      .then((location) => {
        if (!active) return;
        setVideoSaveLocation(location);
      })
      .catch((errorValue) => {
        if (!active) return;
        setVideoSaveLocationStatus(errorValue instanceof Error ? errorValue.message : "读取本地保存位置失败。");
      })
      .finally(() => {
        if (active) setIsLoadingVideoSaveLocation(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    videoSaveLocationRef.current = videoSaveLocation;
  }, [videoSaveLocation]);

  const synchronizeVideoOutputs = useCallback(async (
    outputNodes: BoardWorkflowNode[],
    requestPermission = false,
  ) => {
    const location = videoSaveLocationRef.current;
    if (!location || location.workflowId !== id) {
      throw new Error("请先选择当前画板的成片保存位置。");
    }
    await ensureBoardVideoSaveLocationPermission(location, requestPermission);
    const pendingNodes = outputNodes.filter((node) => !videoSaveInFlightNodeIdsRef.current.has(node.id));
    if (!pendingNodes.length) return [];
    pendingNodes.forEach((node) => videoSaveInFlightNodeIdsRef.current.add(node.id));
    setIsSyncingVideoSaveLocation(true);
    try {
      const saved = [] as Array<{ node: BoardWorkflowNode; fileName: string }>;
      for (const node of pendingNodes) {
        const result = await saveBoardVideoToLocation(location, node);
        saved.push({ node, fileName: result.fileName });
      }
      return saved;
    } finally {
      pendingNodes.forEach((node) => videoSaveInFlightNodeIdsRef.current.delete(node.id));
      setIsSyncingVideoSaveLocation(false);
    }
  }, [id]);

  useEffect(() => {
    if (!workflow) return;
    const outputNodes = (workflow?.nodes ?? []).filter(isBoardVideoSaveCandidate);
    const currentIds = new Set(outputNodes.map((node) => node.id));
    const observedIds = observedVideoOutputIdsRef.current;
    const newOutputs = observedIds
      ? outputNodes.filter((node) => !observedIds.has(node.id))
      : [];
    if (!observedIds) {
      observedVideoOutputIdsRef.current = currentIds;
    } else {
      observedVideoOutputIdsRef.current = currentIds;
    }
    if (!videoSaveLocation || videoSaveLocation.workflowId !== id) return;

    const selectionKey = `${id}:${videoSaveLocation.selectedAt}`;
    const isNewSaveLocationSelection = synchronizedVideoSaveSelectionRef.current !== selectionKey;
    if (isNewSaveLocationSelection) synchronizedVideoSaveSelectionRef.current = selectionKey;
    const candidates = (isNewSaveLocationSelection ? outputNodes : newOutputs)
      .filter((node) => wasBoardVideoCreatedAfterSaveLocationSelection(node, videoSaveLocation.selectedAt));
    if (!candidates.length) return;

    void synchronizeVideoOutputs(candidates)
      .then((saved) => {
        if (!saved.length) return;
        setVideoSaveLocationStatus(`已确认保存 ${saved.length} 个新视频到“${videoSaveLocation.directoryName}”。`);
      })
      .catch((errorValue) => {
        setVideoSaveLocationStatus(errorValue instanceof Error ? errorValue.message : "新视频保存到所选文件夹失败。");
      });
  }, [id, synchronizeVideoOutputs, videoSaveLocation, workflow]);

  useEffect(() => {
    if (embedded) return;
    const targets = [document.documentElement, document.body];
    targets.forEach((target) => target.classList.add("luma-board-page-scrollbar"));
    return () => targets.forEach((target) => target.classList.remove("luma-board-page-scrollbar"));
  }, [embedded]);

  const queueBoardMutation = useCallback(<T,>(operation: () => Promise<T>) => {
    const queued = boardMutationQueueRef.current.then(operation, operation);
    boardMutationQueueRef.current = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }, []);

  const patchBoardWithRevision = useCallback(async <T,>(payload: Record<string, unknown>) => {
    if (!id) throw new Error("画板不存在");
    let lastConflict = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`/api/board-workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          expectedRevision: workflowRevisionRef.current,
        }),
      });
      const data = await res.json().catch(() => ({})) as { workflow?: BoardWorkflow; error?: string };
      if (res.status === 409 && data.workflow) {
        lastConflict = data.error || "画板版本冲突";
        adoptWorkflow(data.workflow);
        continue;
      }
      if (!res.ok) throw new Error(data.error || "保存画板失败");
      adoptWorkflow(data.workflow);
      return data as T;
    }
    throw new Error(`${lastConflict || "画板版本持续冲突"}，请刷新后重试。`);
  }, [adoptWorkflow, id]);

  const clientToBoardPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = boardCanvasRef.current;
    if (!canvas) return { x: clientX, y: clientY };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.round(clientX - rect.left)),
      y: Math.max(0, Math.round(clientY - rect.top)),
    };
  }, []);

  const measureConnectionAnchors = useCallback(() => {
    const canvas = boardCanvasRef.current;
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const next: BoardConnectionAnchors = {};
    canvas.querySelectorAll<HTMLElement>("[data-luma-board-node][data-node-id]").forEach((nodeElement) => {
      const nodeId = nodeElement.dataset.nodeId;
      const input = nodeElement.querySelector<HTMLElement>('[data-luma-board-connection-handle="input"]');
      const output = nodeElement.querySelector<HTMLElement>('[data-luma-board-connection-handle="output"]');
      if (!nodeId || !input || !output) return;
      const inputRect = input.getBoundingClientRect();
      const outputRect = output.getBoundingClientRect();
      next[nodeId] = {
        input: {
          x: Math.round(inputRect.left + inputRect.width / 2 - canvasRect.left),
          y: Math.round(inputRect.top + inputRect.height / 2 - canvasRect.top),
        },
        output: {
          x: Math.round(outputRect.left + outputRect.width / 2 - canvasRect.left),
          y: Math.round(outputRect.top + outputRect.height / 2 - canvasRect.top),
        },
      };
    });
    setConnectionAnchors((current) => (
      JSON.stringify(current) === JSON.stringify(next) ? current : next
    ));
  }, []);

  const loadPendingImageResults = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/image`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取待恢复图片结果失败");
      setPendingImageResults(Array.isArray(data.pendingResults) ? data.pendingResults : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取待恢复图片结果失败");
    }
  }, [id]);

  const markImageTaskSyncing = useCallback((nodeId: string) => {
    setWorkflow((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? {
        ...node,
        status: "running",
        execution: {
          ...node.execution,
          status: "running",
          summary: "图片已保存到本地，正在同步并加载画板预览",
          error: "",
        },
      } : node),
    } : current);
  }, []);

  const prepareVisibleImageWorkflow = useCallback(async (
    candidate: BoardWorkflow,
    nodeId: string,
    clientTaskId: string,
    signal: AbortSignal
  ) => {
    const outputNodes = completedImageExecutionOutputNodes(candidate, nodeId, clientTaskId);
    if (!outputNodes) return null;
    markImageTaskSyncing(nodeId);
    await Promise.all(outputNodes.map((node) => preloadBoardImage(node.publicUrl || "", signal)));
    const res = await fetch(`/api/board-workflows/${id}/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        action: "record_client_sync",
        executorNodeId: nodeId,
        clientTaskId,
        clientVisibleAtMs: Date.now(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.workflow) {
      throw new Error(data.error || "图片已加载，但记录画板显示时间失败。");
    }
    return data.workflow as BoardWorkflow;
  }, [id, markImageTaskSyncing]);

  const waitForImageBoardSync = useCallback(async (
    nodeId: string,
    clientTaskId: string,
    signal: AbortSignal
  ) => {
    const deadline = Date.now() + IMAGE_BOARD_SYNC_TIMEOUT_MS;
    let lastSyncError = "";
    while (Date.now() < deadline) {
      await abortableDelay(IMAGE_BOARD_SYNC_POLL_MS, signal);
      let data: { workflow?: BoardWorkflow; error?: string } = {};
      try {
        const res = await fetch(`/api/board-workflows/${id}`, { cache: "no-store", signal });
        data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastSyncError = data.error || `画板同步请求失败（HTTP ${res.status}）`;
          continue;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastSyncError = error instanceof Error ? error.message : "读取最新画板状态失败";
        continue;
      }

      const candidate = data.workflow;
      if (!candidate) continue;
      const executor = candidate.nodes.find((node) => node.id === nodeId);
      const execution = executor?.execution;
      if (!execution || execution.clientTaskId !== clientTaskId) continue;
      if (execution.status === "failed" || execution.status === "cancelled") {
        throw new Error(execution.error || executor?.error || "image-2 任务未完成");
      }
      if (execution.status !== "done") continue;
      try {
        const visibleWorkflow = await prepareVisibleImageWorkflow(candidate, nodeId, clientTaskId, signal);
        if (visibleWorkflow) return visibleWorkflow;
        lastSyncError = "服务端已结束任务，但没有找到完整的本地图片输出节点";
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastSyncError = error instanceof Error ? error.message : "画板图片预览加载失败";
      }
    }
    throw new Error(lastSyncError || "图片已经生成，但等待画板自动同步超时。请刷新画板重试同步。"
    );
  }, [id, prepareVisibleImageWorkflow]);

  const load = useCallback(async () => {
    if (!id) return;
    setError("");
    try {
      const [res, pendingRes] = await Promise.all([
        fetch(`/api/board-workflows/${id}`, { cache: "no-store" }),
        fetch(`/api/board-workflows/${id}/image`, { cache: "no-store" }),
      ]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取画板失败");
      adoptWorkflow(data.workflow);
      setWorkflowNameDraft(typeof data.workflow?.name === "string" ? data.workflow.name : "");
      const pendingData = await pendingRes.json().catch(() => ({}));
      setPendingImageResults(pendingRes.ok && Array.isArray(pendingData.pendingResults) ? pendingData.pendingResults : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取画板失败");
    }
  }, [adoptWorkflow, id]);

  const syncWorkflowAfterTaskError = useCallback(async () => {
    if (!id) return null;
    try {
      const res = await fetch(`/api/board-workflows/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({})) as { workflow?: BoardWorkflow };
      if (!res.ok || !data.workflow) return null;
      adoptWorkflow(data.workflow);
      return data.workflow;
    } catch {
      return null;
    }
  }, [adoptWorkflow, id]);

  const handleTaskFailure = useCallback(async (errorValue: unknown, fallback: string) => {
    if (errorValue instanceof Error && errorValue.name === "AbortError") return null;
    const message = errorValue instanceof Error ? errorValue.message : fallback;
    setError(message);
    return syncWorkflowAfterTaskError();
  }, [syncWorkflowAfterTaskError]);

  const loadIdentityPack = useCallback(async (preferredPackId?: string) => {
    try {
      const packId = preferredPackId || "";
      const res = await fetch(packId ? `/api/identity-pack?packId=${encodeURIComponent(packId)}` : "/api/identity-pack", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读取人物包失败");
      const packs = Array.isArray(data.packs) ? data.packs as IdentityPackOption[] : [];
      const currentPack = data.pack as IdentityPackOption | null;
      const references: IdentityPackSelectable[] = Array.isArray(currentPack?.references)
        ? currentPack.references
          .filter((reference) => reference.status === "approved")
          .map((reference) => ({ ...reference, assetType: "reference" as const }))
        : [];
      const auxiliaryAssets: IdentityPackSelectable[] = Array.isArray(currentPack?.auxiliaryAssets)
        ? currentPack.auxiliaryAssets.map((asset) => ({
          id: asset.id,
          title: asset.title,
          role: asset.role,
          url: asset.url,
          requiredFor: ["手动导入画板后，按面板标注作为辅助参考"],
          generated: true,
          status: "approved" as const,
          assetType: "auxiliary" as const,
          panels: asset.panels,
        }))
        : [];
      setIdentityPacks(packs);
      if (!preferredPackId) {
        setSelectedIdentityPackId("");
        setIdentityPackRefs([]);
        setSelectedIdentityPackRefId("");
        return;
      }
      setSelectedIdentityPackId(currentPack?.id || "");
      setIdentityPackRefs([...references, ...auxiliaryAssets]);
      setSelectedIdentityPackRefId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取人物包失败");
    }
  }, []);

  const saveBoard = useCallback((
    nodes: BoardWorkflowNode[],
    edges = workflow?.edges,
    deleteFilePaths: string[] = [],
    deletedNodeIds: string[] = [],
    deletedEdgeIds: string[] = []
  ) => {
    if (!id) return Promise.resolve(null);
    return queueBoardMutation(async (): Promise<BoardSaveResult | null> => {
      try {
        return await patchBoardWithRevision<BoardSaveResult>({
          nodes,
          edges,
          deleteFilePaths,
          deletedNodeIds,
          deletedEdgeIds,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存画板失败");
        return null;
      }
    });
  }, [id, patchBoardWithRevision, queueBoardMutation, workflow?.edges]);

  const removeBoardNode = useCallback((nodeId: string, deleteFilePaths: string[] = []) => {
    if (!id) return Promise.reject(new Error("画板不存在"));
    return queueBoardMutation(async (): Promise<BoardSaveResult & { removedEdgeCount: number }> => {
      return patchBoardWithRevision<BoardSaveResult & { removedEdgeCount: number }>({
        deleteNodeId: nodeId,
        deleteFilePaths,
      });
    });
  }, [id, patchBoardWithRevision, queueBoardMutation]);

  const saveWorkflowName = useCallback(async () => {
    const cleanName = workflowNameDraft.trim();
    if (!id || !workflow || !cleanName || cleanName === workflow.name || isSavingWorkflowName) return;
    setIsSavingWorkflowName(true);
    setError("");
    try {
      const data = await queueBoardMutation(() => patchBoardWithRevision<BoardSaveResult>({ name: cleanName }));
      setWorkflowNameDraft(data.workflow?.name || cleanName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存画板名称失败");
    } finally {
      setIsSavingWorkflowName(false);
    }
  }, [id, isSavingWorkflowName, patchBoardWithRevision, queueBoardMutation, workflow, workflowNameDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!workflow || taskActiveRef.current || recoveryObserverRef.current) return;
    const recoverable = runningBoardExecutionNodes(workflow).filter((node) => !node.execution?.videoJob?.taskId);
    if (recoverable.length === 0) return;

    const controller = new AbortController();
    const trackedIds = new Set(recoverable.map((node) => node.id));
    recoveryObserverRef.current = controller;
    taskActiveRef.current = true;
    setBusy("recovery");
    setRunningTask({
      nodeId: recoverable[0].id,
      busyKey: "recovery",
      label: recoverable.length === 1 ? `恢复任务：${displayTitle(recoverable[0])}` : `恢复 ${recoverable.length} 个运行任务`,
      clientTaskId: recoverable[0].execution?.clientTaskId || "",
    });

    void (async () => {
      let networkFailures = 0;
      try {
        while (!controller.signal.aborted) {
          await abortableDelay(2_000, controller.signal);
          const res = await fetch(`/api/board-workflows/${id}`, { cache: "no-store", signal: controller.signal });
          const data = await res.json().catch(() => ({})) as { workflow?: BoardWorkflow; error?: string };
          if (!res.ok || !data.workflow) {
            networkFailures += 1;
            if (networkFailures <= 5) continue;
            throw new Error(data.error || "恢复运行任务时读取画板失败");
          }
          networkFailures = 0;
          let latest = data.workflow;
          const completedImageTask = latest.nodes.find((node) => (
            trackedIds.has(node.id)
            && controlRoleOf(node) === "image_pipeline"
            && boardNodeExecutionStatus(node) === "done"
            && Boolean(node.execution?.clientTaskId)
          ));
          if (completedImageTask?.execution?.clientTaskId) {
            latest = await prepareVisibleImageWorkflow(
              latest,
              completedImageTask.id,
              completedImageTask.execution.clientTaskId,
              controller.signal,
            ) || latest;
          }
          adoptWorkflow(latest);
          const trackedNodes = latest.nodes.filter((node) => trackedIds.has(node.id));
          if (trackedNodes.some((node) => boardNodeExecutionStatus(node) === "running")) continue;
          const failed = trackedNodes.find((node) => boardNodeExecutionStatus(node) === "failed");
          if (failed) setError(failed.execution?.error || failed.error || `${displayTitle(failed)}执行失败`);
          else setBoardNotice("已从本地画板恢复任务终态和输出节点。");
          break;
        }
      } catch (errorValue) {
        if (!(errorValue instanceof Error && errorValue.name === "AbortError")) {
          setError(errorValue instanceof Error ? errorValue.message : "恢复运行任务失败");
          await syncWorkflowAfterTaskError();
        }
      } finally {
        if (recoveryObserverRef.current === controller) recoveryObserverRef.current = null;
        taskActiveRef.current = false;
        setBusy((current) => current === "recovery" ? "" : current);
        setRunningTask((current) => current?.busyKey === "recovery" ? null : current);
      }
    })();
  }, [adoptWorkflow, id, prepareVisibleImageWorkflow, syncWorkflowAfterTaskError, workflow]);

  useEffect(() => () => {
    recoveryObserverRef.current?.abort();
    recoveryObserverRef.current = null;
    videoRecoveryControllersRef.current.forEach((controller) => controller.abort());
    videoRecoveryControllersRef.current.clear();
    videoPollingOwnersRef.current.clear();
  }, []);

  useEffect(() => {
    void loadIdentityPack();
  }, [loadIdentityPack]);

  useEffect(() => {
    if (!boardNotice) return;
    const timer = window.setTimeout(() => setBoardNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [boardNotice]);

  useEffect(() => {
    if (!selectedImageChannelId && imageChannels[0]) setSelectedImageChannelId(imageChannels[0].id);
    if (!videoChannels.some((channel) => channel.id === selectedVideoChannelId) && videoChannels[0]) {
      const preferredVideoChannel = videoChannels.find((channel) => channel.id === providerSetting?.activeVideoChannelId)
        ?? videoChannels[0];
      setSelectedVideoChannelId(preferredVideoChannel.id);
    }
  }, [imageChannels, providerSetting?.activeVideoChannelId, selectedImageChannelId, selectedVideoChannelId, videoChannels]);

  useEffect(() => {
    function onPointerMove(event: globalThis.PointerEvent) {
      setConnecting((current) => {
        if (!current) return current;
        const pointer = clientToBoardPoint(event.clientX, event.clientY);
        return { ...current, pointerX: pointer.x, pointerY: pointer.y };
      });

      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const nextX = Math.max(0, Math.round(drag.startX + dx));
      const nextY = Math.max(0, Math.round(drag.startY + dy));
      drag.latestX = nextX;
      drag.latestY = nextY;
      setWorkflow((current) => current ? {
        ...current,
        nodes: current.nodes.map((node) => node.id === drag.id ? { ...node, x: nextX, y: nextY } : node),
      } : current);
    }

    function onPointerUp() {
      const drag = dragRef.current;
      if (drag) {
        try {
          drag.element.releasePointerCapture(drag.pointerId);
        } catch {
          // The pointer may already be released when the browser dispatches the final event.
        }
        dragRef.current = null;
        if (!drag.moved) return;
        setLayoutUndoPositions(null);
        setWorkflow((current) => {
          if (!current) return current;
          const nodes = current.nodes.map((node) => node.id === drag.id ? { ...node, x: drag.latestX, y: drag.latestY } : node);
          void saveBoard(nodes, current.edges);
          return { ...current, nodes };
        });
        return;
      }
      setConnecting(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setConnecting(null);
        setFocusMode(false);
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clientToBoardPoint, saveBoard]);

  const nodes = useMemo(() => workflow?.nodes || [], [workflow?.nodes]);

  useEffect(() => {
    const availableProductWhiteBackgrounds = nodes.filter(
      (item) => roleOf(item) === "product_white_background" && Boolean(item.publicUrl),
    );
    if (detailBatchProductNodeId && availableProductWhiteBackgrounds.some((item) => item.id === detailBatchProductNodeId)) return;
    setDetailBatchProductNodeId(availableProductWhiteBackgrounds.at(-1)?.id || "");
  }, [detailBatchProductNodeId, nodes]);
  // This is a board-node preference, not the model-pool default and not the
  // immutable channel recorded on a submitted video task.
  const savedVideoChannelId = useMemo(() => {
    const videoNode = nodes.find((node) => controlRoleOf(node) === "video_generate");
    const saved = String(videoNode?.meta?.[LAST_SELECTED_VIDEO_CHANNEL_META_KEY] || "").trim();
    return saved && videoChannels.some((channel) => channel.id === saved) ? saved : "";
  }, [nodes, videoChannels]);
  useEffect(() => {
    if (savedVideoChannelId && savedVideoChannelId !== selectedVideoChannelId) {
      setSelectedVideoChannelId(savedVideoChannelId);
    }
  }, [savedVideoChannelId, selectedVideoChannelId]);
  const boardLayoutKey = useMemo(
    () => `${nodes.map((node) => `${node.id}:${node.x}:${node.y}:${boardNodeWidth(node)}:${nodeZIndex(node)}`).join("|")}::${expandedControlNodeIds.join("|")}`,
    [expandedControlNodeIds, nodes]
  );

  useLayoutEffect(() => {
    measureConnectionAnchors();
    const frame = window.requestAnimationFrame(measureConnectionAnchors);
    window.addEventListener("resize", measureConnectionAnchors);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measureConnectionAnchors);
    };
  }, [boardLayoutKey, focusMode, measureConnectionAnchors]);

  const sourceVideoNode = useMemo(() => currentReferenceVideoNode(workflow), [workflow]);
  const productNodes = useMemo(() => nodes.filter((node) => roleOf(node) === "product_image"), [nodes]);
  const productReferenceNodes = useMemo(() => sortProductReferenceNodes(productNodes), [productNodes]);
  const identityReferenceNodes = useMemo(() => nodes.filter((node) => PERSON_REFERENCE_ROLES.has(roleOf(node))), [nodes]);
  const videoDirectorPrompt = useMemo(() => latestByRole(nodes, "video_director_prompt"), [nodes]);
  useEffect(() => {
    const savedTarget = Number(videoDirectorPrompt?.meta?.targetDuration || 0);
    if (videoDirectorPrompt?.meta?.videoDurationSource === "manual" && Number.isFinite(savedTarget) && savedTarget >= 1 && savedTarget <= 120) {
      setTargetVideoDuration(savedTarget);
    }
  }, [videoDirectorPrompt?.id, videoDirectorPrompt?.meta?.targetDuration, videoDirectorPrompt?.meta?.videoDurationSource]);
  const plannedTargetVideoDuration = useMemo(() => {
    const savedTarget = Number(videoDirectorPrompt?.meta?.targetDuration || 0);
    return Number.isFinite(savedTarget) && savedTarget >= 1 && savedTarget <= 120
      ? savedTarget
      : targetVideoDuration;
  }, [targetVideoDuration, videoDirectorPrompt?.meta?.targetDuration]);
  const videoSegments = useMemo(
    () => {
      const generationSeconds = getBoardVideoProfile(selectedVideoChannel)?.generationSeconds;
      return readStoredVideoShotSegmentPlan(videoDirectorPrompt?.meta?.segmentPlan, generationSeconds || 0)
        || splitTargetDurationIntoVideoSegments(plannedTargetVideoDuration, generationSeconds);
    },
    [plannedTargetVideoDuration, selectedVideoChannel, videoDirectorPrompt?.meta?.segmentPlan]
  );
  const currentImageSize = imageDimensionsForPreset(aspectRatio, "4k");
  const currentImageSizeText = currentImageSize
    ? `${currentImageSize.width}x${currentImageSize.height}`
    : "不传 size，使用上游默认";
  const currentImagePresetLabel = "功能固定 4K";

  function createControlNode(role: ControlRole, x: number, y: number): BoardWorkflowNode {
    const template = controlTemplate(role);
    return {
      id: crypto.randomUUID(),
      kind: "control",
      title: template?.title || "功能节点",
      description: template?.description || "",
      status: "done",
      meta: { controlRole: role },
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      createdAt: new Date().toISOString(),
    };
  }

  function visibleBoardDropPoint() {
    const viewport = boardViewportRef.current;
    if (!viewport) return { x: 80, y: 80 };
    return {
      x: Math.max(24, Math.round(viewport.scrollLeft + viewport.clientWidth / 2 - 170)),
      y: Math.max(24, Math.round(viewport.scrollTop + viewport.clientHeight / 2 - 110)),
    };
  }

  function addControlNode(role: ControlRole, x?: number, y?: number) {
    if (!workflow) return;
    const point = x === undefined || y === undefined ? visibleBoardDropPoint() : { x, y };
    const node = createControlNode(role, point.x, point.y);
    const nextNodes = [...workflow.nodes, node];
    setWorkflow({ ...workflow, nodes: nextNodes });
    void saveBoard(nextNodes, workflow.edges);
  }

  function startControlTemplateDrag(role: ControlRole, event: DragEvent<HTMLElement>) {
    controlDragRoleRef.current = role;
    event.dataTransfer.setData(CONTROL_DRAG_MIME, role);
    event.dataTransfer.setData("text/plain", role);
    event.dataTransfer.effectAllowed = "copy";
  }

  function endControlTemplateDrag() {
    controlDragRoleRef.current = null;
  }

  function handleBoardDragOver(event: DragEvent<HTMLDivElement>) {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(CONTROL_DRAG_MIME) || types.includes("text/plain") || controlDragRoleRef.current) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function handleBoardDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const canvas = boardCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left);
    const y = Math.max(0, event.clientY - rect.top);
    const role = (event.dataTransfer.getData(CONTROL_DRAG_MIME) || event.dataTransfer.getData("text/plain") || controlDragRoleRef.current || "") as ControlRole;
    controlDragRoleRef.current = null;
    if (!role || !controlTemplate(role)) return;
    addControlNode(role, x, y);
  }

  const manualDirectInputIds = useCallback((targetId: string) => {
    if (!workflow) return [];
    return uniqueIds(workflow.edges
      .filter((edge) => edge.to === targetId && MANUAL_EDGE_LABELS.has(edge.label || ""))
      .map((edge) => edge.from));
  }, [workflow]);

  const directorDurationProfile = useMemo(
    () => getBoardVideoProfile(selectedVideoChannel),
    [selectedVideoChannel],
  );

  function startNodeDrag(node: BoardWorkflowNode, event: PointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    bringNodeToFront(node);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the pointer is already released; window listeners still keep the drag usable.
    }
    dragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      element: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.x,
      startY: node.y,
      latestX: node.x,
      latestY: node.y,
      moved: false,
    };
  }

  function startManualConnection(node: BoardWorkflowNode, event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const start = clientToBoardPoint(centerX, centerY);
    setConnecting({
      from: node.id,
      startX: start.x,
      startY: start.y,
      pointerX: start.x,
      pointerY: start.y,
    });
  }

  function finishManualConnection(node: BoardWorkflowNode, event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!workflow || !connecting) return;
    if (connecting.from === node.id) {
      setConnecting(null);
      return;
    }
    const exists = workflow.edges.some((edge) => edge.from === connecting.from && edge.to === node.id);
    const nextEdges: BoardWorkflowEdge[] = exists
      ? workflow.edges
      : [...workflow.edges, { id: crypto.randomUUID(), from: connecting.from, to: node.id, label: MANUAL_EDGE_LABEL }];
    const nextNodes = node.kind === "control"
      ? workflow.nodes.map((item) => item.id === node.id ? { ...item, status: "pending" as const } : item)
      : workflow.nodes;
    setConnecting(null);
    void saveBoard(nextNodes, nextEdges);
  }

  function deleteEdge(edge: BoardWorkflowEdge, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!workflow) return;
    const targetNode = workflow.nodes.find((node) => node.id === edge.to);
    const nextNodes = targetNode?.kind === "control"
      ? workflow.nodes.map((node) => node.id === targetNode.id ? { ...node, status: "pending" as const } : node)
      : workflow.nodes;
    void saveBoard(nextNodes, workflow.edges.filter((item) => item.id !== edge.id), [], [], [edge.id]);
  }

  function bringNodeToFront(node: BoardWorkflowNode) {
    if (!workflow) return;
    const maxZIndex = Math.max(NODE_BASE_Z_INDEX, ...workflow.nodes.map(nodeZIndex));
    const targetIndex = workflow.nodes.findIndex((item) => item.id === node.id);
    if (targetIndex < 0) return;
    const isAlreadyLast = targetIndex === workflow.nodes.length - 1;
    const isAlreadyFront = nodeZIndex(workflow.nodes[targetIndex]) > maxZIndex - NODE_FRONT_Z_INDEX_STEP / 2;
    if (isAlreadyLast && isAlreadyFront) return;
    const target = withNodeZIndex(workflow.nodes[targetIndex], maxZIndex + NODE_FRONT_Z_INDEX_STEP);
    const nextNodes = [...workflow.nodes.slice(0, targetIndex), ...workflow.nodes.slice(targetIndex + 1), target];
    setWorkflow({ ...workflow, nodes: nextNodes });
    void saveBoard(nextNodes, workflow.edges);
  }

  function disconnectAllEdges() {
    if (!workflow) return;
    if (workflow.edges.length === 0) {
      setError("当前画板没有连线需要断开。");
      return;
    }
    setDisconnectDialogOpen(true);
  }

  function confirmDisconnectAllEdges() {
    if (!workflow || workflow.edges.length === 0) {
      setDisconnectDialogOpen(false);
      return;
    }
    const edgeCount = workflow.edges.length;
    const nextNodes = workflow.nodes.map((node) => node.kind === "control" ? { ...node, status: "pending" as const } : node);
    setDisconnectDialogOpen(false);
    void saveBoard(nextNodes, [], [], [], workflow.edges.map((edge) => edge.id)).then((result) => {
      if (result) setBoardNotice(`已断开 ${edgeCount} 条连线；节点和本地文件均已保留。`);
    });
  }

  function measuredBoardNodeHeights() {
    const heights = new Map<string, number>();
    const canvas = boardCanvasRef.current;
    if (!canvas) return heights;
    canvas.querySelectorAll<HTMLElement>("[data-luma-board-node][data-node-id]").forEach((element) => {
      const nodeId = element.dataset.nodeId;
      if (nodeId) heights.set(nodeId, Math.ceil(element.getBoundingClientRect().height));
    });
    return heights;
  }

  function openLayoutPreview(mode: BoardLayoutMode) {
    if (!workflow) return;
    setExpandedControlNodeIds([]);
    if (workflow.nodes.length === 0) {
      setError("当前画板没有节点可整理。");
      return;
    }
    setError("");
    setLayoutPreview(buildBoardLayoutPreview(workflow.nodes, workflow.edges, mode, measuredBoardNodeHeights()));
  }

  function applyLayoutPreview() {
    if (!workflow || !layoutPreview) return;
    const previousPositions = workflow.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      zIndex: nodeZIndex(node),
    }));
    const nextNodes = layoutPreview.nodes;
    setWorkflow({ ...workflow, nodes: nextNodes });
    setLayoutUndoPositions(previousPositions);
    setAppliedLayoutCanvasHeight(layoutPreview.canvasMinHeight);
    setLayoutPreview(null);
    setBoardNotice(`已按${layoutPreview.mode === "pipeline" ? "操作就近" : "手动连线"}整理 ${layoutPreview.movedCount} 个节点；素材和连线均未改动。`);
    void saveBoard(nextNodes, workflow.edges);
  }

  function undoLastLayout() {
    if (!workflow || !layoutUndoPositions) return;
    const previous = new Map(layoutUndoPositions.map((position) => [position.id, position]));
    const nextNodes = workflow.nodes.map((node) => {
      const position = previous.get(node.id);
      if (!position) return node;
      return withNodeZIndex({ ...node, x: position.x, y: position.y }, position.zIndex);
    });
    setWorkflow({ ...workflow, nodes: nextNodes });
    setLayoutUndoPositions(null);
    setAppliedLayoutCanvasHeight(Math.max(BOARD_LAYOUT_MIN_CANVAS_HEIGHT, ...nextNodes.map((node) => node.y + estimatedBoardNodeHeight(node) + 120)));
    setBoardNotice("已恢复整理前的节点位置；素材和连线均未改动。");
    void saveBoard(nextNodes, workflow.edges);
  }

  function deleteNode(node: BoardWorkflowNode, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setDeleteDialogNode(node);
    setDeleteDialogAlsoDeleteFiles(false);
    setDeleteDialogError("");
  }

  async function confirmDeleteNode() {
    if (!workflow || !deleteDialogNode || isDeletingNode) return;
    const node = deleteDialogNode;
    const isNodeRunning = runningTask?.nodeId === node.id || node.execution?.status === "running" || node.status === "running";
    if (isNodeRunning) {
      setDeleteDialogError("该节点正在执行。请先取消当前任务，待状态变为已取消后再移除节点。");
      return;
    }
    setIsDeletingNode(true);
    setDeleteDialogError("");
    try {
      const result = await removeBoardNode(node.id, deleteDialogAlsoDeleteFiles ? nodeFilePaths(node) : []);
      setDeleteDialogNode(null);
      const removedEdges = result.removedEdgeCount || 0;
      const deleted = result.fileDeletion?.deleted?.length || 0;
      const skipped = result.fileDeletion?.skipped?.length || 0;
      const fileNotice = deleteDialogAlsoDeleteFiles
        ? `；已清理 ${deleted} 个画板托管文件${skipped > 0 ? `，跳过 ${skipped} 个外部或不可删除文件` : ""}`
        : "；原素材和本地文件已保留";
      setBoardNotice(`已从画板移除“${displayTitle(node)}”，并断开 ${removedEdges} 条连线${fileNotice}。`);
    } catch (err) {
      setDeleteDialogError(err instanceof Error ? err.message : "移除节点失败，请重试。");
    } finally {
      setIsDeletingNode(false);
    }
  }

  async function uploadBoardFile(
    file: File | null,
    role: string,
    title: string,
    description: string,
    x: number,
    y: number,
    sourceNodeId = "",
    productGroupId = "",
  ) {
    if (!file) return null;
    setBusy(`upload:${role}`);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("role", role);
      form.set("title", title);
      form.set("description", description);
      if (sourceNodeId) form.set("sourceNodeId", sourceNodeId);
      if (role === "product_image" && productGroupId && sourceNodeId) {
        form.set("productGroupId", productGroupId);
        form.set("productGroupOwnerNodeId", sourceNodeId);
      }
      form.set("x", String(x));
      form.set("y", String(y));
      const res = await fetch(`/api/board-workflows/${id}/asset`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传本地素材失败");
      adoptWorkflow(data.workflow);
      return data.node as BoardWorkflowNode;
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传本地素材失败");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function uploadImageAsset(file: File | null, role: string, title: string, x: number, y: number, sourceNodeId = "", productGroupId = "") {
    const productDescription =
      /背面|back/i.test(title) ? "商品背面结构图：用于锁定背面领口、肩线、袖长、侧缝、下摆曲线、底边区域、包边装饰和面料结构。" :
      /侧面|side/i.test(title) ? "商品侧面结构图：用于锁定侧缝路径、厚度、袖长、下摆曲线和正背面过渡关系。" :
      /正面|front/i.test(title) ? "商品正面结构图：用于锁定正面领口、肩线、袖长、袖口、下摆曲线、图案、颜色和材质。" :
      "商品结构图：用于锁定商品真实结构、颜色、材质和细节。";
    const description = role === "product_image"
      ? productDescription
      : role === "face_front"
        ? "仅本次画板使用的人脸正面参考；用于锁定脸型、五官、自然肤色和年龄感，不负责发型、表情、姿势或背景。"
        : "仅本次画板使用的人物身份参考，用于保持人物脸型、五官、发型和身份一致。";
    return uploadBoardFile(file, role, title, description, x, y, sourceNodeId, productGroupId);
  }

  async function createProductEvidenceBoard(sourceNodeId: string, sourceProductNodes: BoardWorkflowNode[], productGroupId: string) {
    if (sourceProductNodes.length < 2) {
      setError("请先至少上传商品正面图和背面或侧面图，再生成商品多视图证据板。");
      return;
    }
    setBusy("product-evidence-board");
    setError("");
    try {
      const res = await fetch(`/api/board-workflows/${id}/product-evidence-board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productNodeIds: sourceProductNodes.map((item) => item.id),
          sourceNodeId,
          productGroupId,
          x: 920,
          y: 180,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "生成商品多视图证据板失败");
      adoptWorkflow(data.workflow);
      setBoardNotice("商品多视图证据板已生成；每格已写入正面、背面或侧面标题。将它作为视频任务的“商品图”连入即可让模型按画格视角读取商品结构。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成商品多视图证据板失败");
    } finally {
      setBusy("");
    }
  }

  function saveProductGroup(ownerNodeId: string, groupId: string, productNodeIds: string[]) {
    const nextNodes = setCurrentProductGroup(nodes, ownerNodeId, groupId, productNodeIds);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  async function importIdentityPackReference(x: number, y: number, sourceNodeId = "") {
    const referenceId = selectedIdentityPackRefId;
    const selected = identityPackRefs.find((item) => item.id === referenceId);
    if (!selectedIdentityPackId || !selected) {
      setError("请先选择人物包和一张已通过验收的人物图或辅助资产。");
      return;
    }
    setBusy("import:identity_pack");
    setError("");
    try {
      const res = await fetch(`/api/board-workflows/${id}/identity-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packId: selectedIdentityPackId,
          ...(selected.assetType === "auxiliary" ? { auxiliaryAssetId: selected.id } : { referenceId: selected.id }),
          x,
          y,
          sourceNodeId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "身份包导入画板失败");
      adoptWorkflow(data.workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "身份包导入画板失败");
    } finally {
      setBusy("");
    }
  }

  async function uploadLocalMedia(file: File | null, x: number, y: number, sourceNodeId = "") {
    const isVideo = Boolean(file?.type.startsWith("video/"));
    await uploadBoardFile(
      file,
      isVideo ? "local_video_asset" : "local_image_asset",
      file?.name || (isVideo ? "本地视频素材" : "本地图片素材"),
      isVideo ? "手动上传到画板的本地视频素材，可预览、连线和作为后续参考。" : "手动上传到画板的本地图片素材，可预览、连线和作为后续参考。",
      x,
      y,
      sourceNodeId
    );
  }

  function renderIdentityPackImportControls(x: number, y: number, sourceNodeId = "") {
    const canImportIdentityReference = Boolean(selectedIdentityPackId && selectedIdentityPackRefId);

    return (
      <div data-luma-identity-pack-import className="min-w-0 rounded-xl border p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold">从人物包引用</div>
          <Badge variant="secondary" className="text-[10px]">{identityPackRefs.length} 项</Badge>
        </div>
        <div className="grid min-w-0 gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="text-[10px] font-medium text-cyan-50/65">人物包</p>
            <LumaSelect
              value={selectedIdentityPackId}
              onChange={(packId) => {
                setSelectedIdentityPackRefId("");
                void loadIdentityPack(packId);
              }}
              emptyLabel="暂无人物包"
              ariaLabel="人物包"
              options={identityPacks.map((pack) => ({ value: pack.id, label: pack.packName, detail: `${pack.references.filter((reference) => reference.status === "approved").length} 张已通过` }))}
            />
          </div>
          {selectedIdentityPackId ? (
            <div className="min-w-0 space-y-1.5">
              <p className="text-[10px] font-medium text-cyan-50/65">已验收资产</p>
              <LumaSelect
                value={selectedIdentityPackRefId}
                onChange={setSelectedIdentityPackRefId}
                emptyLabel="暂无可调用资产"
                ariaLabel="已验收资产"
                layout="asset"
                options={identityPackRefs.map((ref) => ({
                  value: ref.id,
                  label: ref.title,
                  detail: identityReferenceTypeLabel(ref),
                  imageUrl: ref.url,
                }))}
              />
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => importIdentityPackReference(x, y, sourceNodeId)}
            disabled={busy === "import:identity_pack" || !canImportIdentityReference}
            className="w-full"
          >
            {busy === "import:identity_pack" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuImage className="mr-1.5 h-4 w-4" />}
            引用到本次画板
          </Button>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            先选人物包，再选其中已验收资产；引用后需手动连到目标节点才会发送。
          </p>
        </div>
      </div>
    );
  }

  async function translateReferenceAnalysis(analysisNode: BoardWorkflowNode) {
    if (!llm.apiKey || !llm.baseUrl || !llm.model) {
      setError("请先在设置页配置 LLM。");
      return;
    }
    const clientTask = beginClientTask("", "translate-analysis", "翻译英文参考视频拆解");
    if (!clientTask) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/analyze/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({ llm, analysisNodeId: analysisNode.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "中文翻译失败");
      adoptWorkflow(data.workflow);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "中文翻译失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function translateDirectorPrompt(directorNode: BoardWorkflowNode) {
    if (!llm.apiKey || !llm.baseUrl || !llm.model) {
      setError("请先在设置页配置 LLM。");
      return;
    }
    const clientTask = beginClientTask("", "translate-director", "翻译英文完整视频导演稿");
    if (!clientTask) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/director/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({ llm, directorNodeId: directorNode.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "中文翻译失败");
      adoptWorkflow(data.workflow);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "中文翻译失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function runDirector(
    executorNodeId = "",
    durationSource: BoardVideoDurationSource = "manual",
    duration = targetVideoDuration,
  ) {
    if (!llm.apiKey || !llm.baseUrl || !llm.model) {
      setError("请先在设置页配置 LLM。");
      return;
    }
    if (!executorNodeId) {
      setError("请把右上角“完整视频导演稿”拖到画板，并手动连线参考视频拆解后再生成。口播输入可选；不要连单镜头图片。");
      return;
    }
    if (!selectedVideoChannel) {
      setError("请先在视频模型池中选择已配置的视频通道，再生成完整导演稿。");
      return;
    }
    await executeNodeAction(executorNodeId, "gpt_director", {
      llm,
      directorPreference,
      targetDuration: duration,
      durationSource,
      videoChannelId: selectedVideoChannel.id,
      videoModel: selectedVideoChannel.model,
    }, "director", "完整视频导演稿生成失败", "根据手动连线输入写完整稿");
  }


  function requireImageChannel() {
    if (!selectedImageChannel) {
      setError("请先在设置页配置并开启 image-2 生图模型。");
      return false;
    }
    return true;
  }

  function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
  }

  function beginClientTask(nodeId: string, busyKey: string, label: string, inputNodeIds: string[] = []) {
    if (busy || taskActiveRef.current) {
      setError("已有任务正在运行，请先等待完成或点击取消当前任务。");
      return null;
    }
    const controller = new AbortController();
    const token = taskTokenRef.current + 1;
    const clientTaskId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    taskTokenRef.current = token;
    taskAbortRef.current = controller;
    taskActiveRef.current = true;
    setBusy(busyKey);
    setRunningTask({ nodeId, busyKey, label, clientTaskId });
    if (nodeId) {
      setExpandedControlNodeIds((current) => current.includes(nodeId) ? current : [...current, nodeId]);
    }
    setWorkflow((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId
        ? beginBoardClientExecution(node, {
          clientTaskId,
          startedAt,
          inputNodeIds,
          summary: `正在执行：${label}`,
        })
        : node),
    } : current);
    setError("");
    return { controller, token, clientTaskId, startedAt };
  }

  function endClientTask(token: number) {
    if (taskTokenRef.current !== token) return;
    taskAbortRef.current = null;
    taskActiveRef.current = false;
    setBusy("");
    setRunningTask(null);
  }

  async function cancelCurrentTask(recoveryNodeId = "") {
    const current = runningTask;
    const nodeId = current?.nodeId || recoveryNodeId;
    const clientTaskId = current?.clientTaskId
      || workflow?.nodes.find((node) => node.id === recoveryNodeId)?.execution?.clientTaskId
      || "";
    taskAbortRef.current?.abort();
    taskAbortRef.current = null;
    taskActiveRef.current = false;
    taskTokenRef.current += 1;
    setBusy("");
    setRunningTask(null);
    setError("当前任务已取消。下一次任务会重新读取当前画板连线和节点状态，不沿用本次中断输入。");
    if (!nodeId) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, clientTaskId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.workflow) adoptWorkflow(data.workflow);
    } catch {
      // The local abort already protects the next task. A later refresh will reconcile server state.
    }
  }

  function renderCancelTask(nodeId = "") {
    const node = nodeId ? workflow?.nodes.find((item) => item.id === nodeId) : undefined;
    const recoveredVideoJob = node?.execution?.videoJob;
    const recoveredRemoteTaskId = boardVideoRemoteTaskId(recoveredVideoJob);
    const hasRecoveredVideoTask = Boolean(
      nodeId
      && node?.execution?.status === "running"
      && recoveredRemoteTaskId
      && ["submitted", "queued", "running", "completed_pending_content"].includes(String(recoveredVideoJob?.status || ""))
      && !recoveredVideoJob?.outputNodeIds?.length,
    );
    const hasCurrentTask = Boolean(runningTask && (!nodeId || runningTask.nodeId === nodeId));
    if (!hasCurrentTask && !hasRecoveredVideoTask) return null;
    return (
      <div className="rounded-xl border border-red-300/30 bg-red-950/25 p-3 text-xs text-red-100 shadow-inner shadow-red-950/20">
        <div className="mb-2 font-medium">
          {hasCurrentTask ? `正在执行：${runningTask?.label}` : "正在恢复已提交的远端视频任务"}
        </div>
        {recoveredVideoJob?.taskId && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mb-2 w-full border-cyan-200/35 bg-cyan-300/10 text-cyan-50 hover:bg-cyan-300/20"
            disabled={manualVideoPollNodeId === nodeId}
            onClick={() => void pollVideoTaskNow(nodeId)}
          >
            {manualVideoPollNodeId === nodeId ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {manualVideoPollNodeId === nodeId ? "正在查询…" : "立即查询任务"}
          </Button>
        )}
        <Button type="button" size="sm" variant="destructive" className="w-full border-red-300/40 bg-red-500/80 hover:bg-red-500" onClick={() => void cancelCurrentTask(nodeId)}>
          <LuX className="mr-1.5 h-4 w-4" />
          取消当前任务
        </Button>
        <p className="mt-2 leading-relaxed text-red-100/75">取消后会清空本次执行记录；下一次会按当前连线重新取输入，旧请求晚返回也不会写回该节点。</p>
      </div>
    );
  }

  async function pollVideoTaskNow(nodeId: string) {
    if (!nodeId || manualVideoPollNodeId) return;
    setManualVideoPollNodeId(nodeId);
    setError("");
    try {
      const res = await fetch(`/api/board-workflows/${id}/video-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ action: "poll", executorNodeId: nodeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.workflow) adoptWorkflow(data.workflow);
      if (!res.ok) throw new Error(data.error || "查询视频任务失败");
      if (!data.pending) setBoardNotice("视频已保存到本地并同步到画板。");
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "查询视频任务失败");
    } finally {
      setManualVideoPollNodeId("");
    }
  }

  function buildImageTask(task: ImageTask, executorNodeId = ""): BuiltImageTask | null {
    if (!executorNodeId) {
      setError("请把 image-2 资产流水线拖到画板，并直接手动连线本次任务所需资产后再生成。");
      return null;
    }
    const directInputNodes = manualDirectInputIds(executorNodeId)
      .map((nodeId) => nodes.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    const taskProductNodes = sortProductReferenceNodes(directInputNodes.filter((node) => roleOf(node) === "product_image"));
    const productIds = taskProductNodes.map((node) => node.id);
    const productGroupIds = taskProductNodes.map((node) => String(node.meta?.productGroupId || "").trim());
    const productsShareOneGroup = taskProductNodes.length <= 1
      || (productGroupIds.every(Boolean) && new Set(productGroupIds).size === 1);
    const manuallyLinkedPersonIds = directInputNodes
      .filter((node) => isPersonReferenceNode(node))
      .map((node) => node.id);
    const frontFaceNodes = directInputNodes.filter((node) => isFrontFaceIdentityReference(node));
    const sourceShotNodes = directInputNodes.filter((node) => roleOf(node) === "selected_scene_frame");
    const cleanSceneNodes = directInputNodes.filter((node) => roleOf(node) === "clean_scene");
    const outfitNodes = directInputNodes.filter((node) => ["outfit_front", "outfit_side", "outfit_back", "outfit_turnaround"].includes(roleOf(node)));
    const repairTargetNodes = directInputNodes.filter((node) => ["composite_image", "repaired_image"].includes(roleOf(node)));
    const linkedPerformanceBaselines = Array.from(new Set(
      directInputNodes
        .filter((node) => isPersonReferenceNode(node))
        .map((node) => String(node.meta?.identityPerformanceBaseline || "").trim())
        .filter(Boolean),
    ));
    const identityPerformanceBaseline = linkedPerformanceBaselines.length === 1
      ? linkedPerformanceBaselines[0]
      : identityPerformanceBaselineText;
    const expressionPanelMap = directInputNodes
      .filter((node) => roleOf(node) === "identity_auxiliary_asset" && String(node.meta?.identityAuxiliaryKind || "") === "expression_sheet")
      .map((node) => identityAuxiliaryPanelText(node.meta?.identityAuxiliaryPanels))
      .filter(Boolean)
      .join(" ");
    const performancePromptMetadata = {
      identityPerformanceBaselineVersion: IDENTITY_PERFORMANCE_BASELINE_VERSION,
      identityPerformanceBaseline,
      expressionPanelMap,
    };
    const exactImageInputIssue = (items: BoardWorkflowNode[], label: string) => {
      if (items.length === 0) return `缺少：${label} 1 张`;
      if (items.length > 1) return `冲突：${label}只能保留 1 张（当前 ${items.length} 张）`;
      return "";
    };
    const stopForImageInputIssues = (issues: string[]) => {
      const uniqueIssues = Array.from(new Set(issues.filter(Boolean)));
      if (uniqueIssues.length === 0) return false;
      setError(`${IMAGE_TASK_GUIDES[task].label}输入未就绪：${uniqueIssues.join("；")}`);
      return true;
    };
    const describeProductReference = (node: BoardWorkflowNode, index: number, productIndex: number) => {
      const imageNumber = index + 1;
      const view = productViewKind(node);
      const viewLabel = view === "front" ? "front view" : view === "back" ? "back view" : view === "side" ? "side view" : "product view";
      return productIndex === 0
        ? `Reference image ${imageNumber} is the primary product ${viewLabel}. Use it only to reproduce the visible product type, structure, silhouette, neckline or collar, sleeves, seams, hem, trim, pattern, color, material, and any visible product label or branding.`
        : `Reference image ${imageNumber} is an additional ${viewLabel} of the same product. Use it only to complete product details, including any visible label or branding, that are not visible in the primary product image. Do not combine the references into a new product or invent details that are not shown.`;
    };
    const describeIdentityReference = (node: BoardWorkflowNode, index: number) => {
      const imageNumber = index + 1;
      const role = roleOf(node);
      const sourceKind = String(node.meta?.identityReferenceSourceKind || "");
      const group = String(node.meta?.identityReferenceGroup || "");
      const text = `${node.title || ""} ${node.description || ""}`.toLowerCase();
      if (role === "identity_auxiliary_asset") {
        const kind = String(node.meta?.identityAuxiliaryKind || "");
        if (kind === "expression_sheet") {
          const panelMap = identityAuxiliaryPanelText(node.meta?.identityAuxiliaryPanels);
          return `Reference image ${imageNumber} is my labelled expression reference board. Use it only for my face identity, expression, gaze, and mouth-shape range; do not use it to change the product, outfit, or studio background.${panelMap ? ` Textual panel map: ${panelMap}` : ""}`;
        }
        if (kind === "base_multiview_sheet") {
          return `Reference image ${imageNumber} is my labelled full-body multi-view reference board. Use it only for my same-person body proportions and requested viewing angle; do not use it to change the product or studio background.`;
        }
        if (kind === "camera_pose_sheet") {
          return `Reference image ${imageNumber} is my labelled camera-and-pose reference board. Use it only for my same-person camera relationship and posture; do not use it to change the product or studio background.`;
        }
        return `Reference image ${imageNumber} is my labelled identity reference board. Use only its labelled identity, body, expression, or pose information; do not use it to change the product or studio background.`;
      }
      if (sourceKind === "face_front" || group === "source" || role === "face_front" || /人脸正面|face.*front/.test(text)) {
        return `Reference image ${imageNumber} is my frontal face identity reference. Use it only to preserve my face shape, facial features, hairstyle, and natural skin tone. Do not freeze its neutral expression, direct-lens gaze, or closed-mouth calibration state into this image.`;
      }
      if (sourceKind === "full_body_front") {
        return `Reference image ${imageNumber} is my approved full-body front proportion reference. Use it only to preserve the visible same-person head-to-body relationship, shoulder line, torso-to-leg relationship, limb proportions, and natural standing balance. Do not invent numeric measurements or reshape my body.`;
      }
      if (sourceKind === "full_body_left_45" || sourceKind === "full_body_right_45" || sourceKind === "full_body_side") {
        return `Reference image ${imageNumber} is my approved side-angle full-body proportion reference. Use it only to preserve the visible same-person facial profile, body thickness, shoulder line, torso-to-leg relationship, limb proportions, and natural posture from that angle. Do not invent numeric measurements.`;
      }
      if (sourceKind === "full_body_back") {
        return `Reference image ${imageNumber} is my approved back-view full-body proportion reference. Use it only to preserve the visible same-person back silhouette, shoulder line, hair length, body proportions, limb relationships, and natural posture from behind. Do not invent numeric measurements.`;
      }
      if (sourceKind === "camera_eye_level" || sourceKind === "camera_high_angle" || sourceKind === "camera_low_angle") {
        return `Reference image ${imageNumber} is my approved camera-and-pose identity reference. Use it only to preserve my same face, body proportion, camera relationship, and natural posture; do not use it to change the product or studio background.`;
      }
      if (role === "face_left" || role === "face_right" || /人脸.*(?:左|右)|face.*(?:left|right)/.test(text)) {
        return `Reference image ${imageNumber} is my side-face identity reference. Use it only to preserve my same facial profile, hairstyle, and natural skin tone from this angle.`;
      }
      if (/全身.*(?:正面|侧面|背面)|full.*body/.test(text)) {
        return `Reference image ${imageNumber} is my full-body identity reference. Use it only to preserve the visible same-person head-to-body relationship, shoulder line, torso-to-leg relationship, limb proportions, and natural standing balance. Do not invent numeric measurements.`;
      }
      return `Reference image ${imageNumber} is my identity reference. Use it only to preserve my same face, hairstyle, natural skin tone, body proportions, and natural posture. Do not copy its clothing, background, or local lighting.`;
    };
    const conditionalSupportStyling = [
      "Do not invent a coordinated look, branded garment, heel type, accessory, or extra product piece. Add only minimal plain neutral coverage where anatomy would otherwise be exposed, keep it visually subordinate, and never let it alter, tuck, cover, shorten, reshape, or replace the product.",
    ];
    if (task === "clean_scene") {
      if (stopForImageInputIssues([
        exactImageInputIssue(sourceShotNodes, "参考视频场景帧（当前镜头人工选帧）"),
      ])) return null;
      const sourceShot = sourceShotNodes[0];
      return {
        title: "场景空镜修复图",
        description: "基于视频参考帧去除原人物，并修复被遮挡的背景区域。",
        referenceNodeIds: [sourceShot.id],
        x: 740,
        y: 360,
        prompt: [
          "Using Reference image 1, generate one empty background plate for the current shot.",
          "Reference image 1 is the current-shot scene reference. Use it only to preserve the original location, camera position, crop, lighting, props, and visible environment.",
          "Remove the original person and the body, hair, arms, hands, phone, clothing, and person-contact shadow that obscure the scene.",
          "Rebuild only the obscured area from the visible surroundings. Continue the existing perspective, surface direction, object boundaries, material texture, reflection logic, depth layers, natural exposure, color temperature, and shadow direction.",
          "Preserve the original aspect ratio, crop, visible image-axis relationship, perspective appearance, scene layout, props, visible wear, minor irregularity, foreground, midground, background, and atmosphere. Do not infer physical camera height, shooting distance, device, or focal length from this still.",
          "For glass, mirrors, patterned surfaces, walls, floors, furniture, plants, architecture, fabric, or glossy materials, extend only the evidence already visible in the still.",
          "Remove subtitles, platform UI, watermarks, account text, and unrelated text.",
          "Do not change the location, time of day, camera relationship, or visible objects. Do not add a person, silhouette, human residue, new prop, repeated texture, blurred patch, warped geometry, or artificial melted detail.",
        ].join("\n"),
      };
    }
    if (task === "product_white_background") {
      if (stopForImageInputIssues([
        productIds.length === 0 ? "缺少：商品图至少 1 张" : "",
        productIds.length > 3 ? `冲突：商品图最多 3 张（当前 ${productIds.length} 张）` : "",
        directInputNodes.length !== productIds.length ? "冲突：商品白底图只接受商品图 1–3 张" : "",
        !productsShareOneGroup ? "冲突：多张商品图必须来自同一个当前商品组" : "",
      ])) return null;
      return {
        title: "商品白底图",
        description: "基于直接连入的商品图生成单张去模特、无环境、无阴影的纯白底商品图。",
        referenceNodeIds: productIds,
        x: 420,
        y: 540,
        prompt: "The server builds the canonical product-only white-background prompt from the directly linked product images.",
      };
    }
    if (["outfit_front", "outfit_side", "outfit_back"].includes(task)) {
      const references = [...productIds, ...manuallyLinkedPersonIds];
      if (stopForImageInputIssues([
        productIds.length === 0 ? "缺少：商品图至少 1 张" : "",
        productIds.length > 3 ? `冲突：商品图最多 3 张（当前 ${productIds.length} 张）` : "",
        manuallyLinkedPersonIds.length === 0 ? "缺少：人物包图片或已生成人脸图至少 1 张" : "",
        references.length > IMAGE_REFERENCE_LIMIT ? `冲突：商品图与人物参考图合计最多 ${IMAGE_REFERENCE_LIMIT} 张（当前 ${references.length} 张）` : "",
      ])) return null;
      const angleMap: Record<string, { title: string; role: string; pose: string; framing: string; productVisibility: string; x: number }> = {
        outfit_front: {
          title: "全身穿搭正面白底图",
          role: "front full-body view",
          pose: "strict true front-facing neutral standing pose at zero degrees, with head, torso, hips, legs, and feet facing the camera together; keep both shoulders level and visible",
          framing: "show my complete body from the full top of my hair to the soles of both feet without cropping hair, arms, hands, legs, or feet; keep me centered with balanced clean white space around the figure",
          productVisibility: "keep both arms relaxed at my sides with enough separation from the torso to keep the product front, sleeves, side seams, hem, and visible trim readable; do not let hands or arms cover the product",
          x: 420,
        },
        outfit_side: {
          title: "全身穿搭侧面白底图",
          role: "side full-body view",
          pose: "strict 90-degree left-side profile, with head, torso, hips, legs, and feet turned together and the left side of the body facing the camera; do not show a near-front or mirrored view",
          framing: "show my complete body from the full top of my hair to the soles of both feet without cropping hair, arms, hands, legs, or feet; keep me centered with balanced clean white space around the figure",
          productVisibility: "keep arms and hands natural and clear of the torso so the product side silhouette, sleeve, side seam, hem, and visible trim remain readable",
          x: 720,
        },
        outfit_back: {
          title: "全身穿搭背面白底图",
          role: "back full-body view",
          pose: "strict straight-back natural standing pose, with head, torso, hips, legs, and feet facing away from the camera; keep both shoulders level and do not turn the head to reveal the face",
          framing: "show my complete body from the full top of my hair to the soles of both feet without cropping hair, arms, hands, legs, or feet; keep me centered with balanced clean white space around the figure",
          productVisibility: "keep arms and hands natural and clear of the torso so the full garment back, back seams, hem, and visible trim remain readable",
          x: 1020,
        },
      };
      const angle = angleMap[task];
      const referenceRoles = [
        ...taskProductNodes.map((node, index) => describeProductReference(node, index, index)),
        ...directInputNodes.filter((node) => isPersonReferenceNode(node)).map((node, index) => describeIdentityReference(node, taskProductNodes.length + index)),
      ];
      return {
        title: angle.title,
        description: "参考身份包和商品图生成单张穿搭角度图。三视角分三次生成，避免多角度互相污染。",
        referenceNodeIds: references,
        x: angle.x,
        y: 900,
        prompt: [
          `Using the attached reference images, generate one ${angle.role} outfit image of me on a clean white seamless studio background.`,
          "The attached reference images have fixed roles and order:",
          ...referenceRoles,
          `Pose: ${angle.pose}.`,
          `Frame: ${angle.framing}. Keep elbows, wrists, fingers, and hands anatomically complete and naturally proportioned.`,
          `Product visibility: ${angle.productVisibility}.`,
          ...conditionalSupportStyling,
          "PERSON PERFORMANCE BASELINE:",
          identityPerformanceBaseline,
          task === "outfit_front"
            ? "Face performance: use an alert, relaxed, closed-mouth start state with natural lens-facing attention. Do not create a posed smile, speaking mouth, empty gaze, or theatrical expression."
            : task === "outfit_side"
              ? "Face performance: only when the face and eyes are visible, keep a relaxed attentive profile that follows the head direction. Do not force direct-lens gaze, eye catchlights, or a frontal expression into a profile view."
              : "Face performance: this is a strict back view. Do not turn the head, reveal the face, or add facial expression information not visible from behind.",
          "Do not add an extra garment, accessory, or product piece beyond what the product reference visibly requires. Do not let the white background, support styling, or identity references alter the product's color, exposure, texture, material hierarchy, or construction.",
          "Use a seamless pure-white studio background with soft, even, neutral diffused light and a subtle natural contact shadow. Do not add a wall corner, horizon line, prop, color cast, hard shadow, or blown highlight. Keep the product texture clear and the facial identity natural.",
          "Generate one person and one single full-body image only. Do not create identity drift, body-proportion drift, extra limbs, malformed hands, product redesign, missing garment details, text, watermark, platform UI, collage, contact sheet, split screen, mirrored duplicate, or multiple people.",
        ].join("\n"),
        promptMetadata: performancePromptMetadata,
      };
    }
    if (task === "composite_image") {
      const preliminaryReferenceCount = uniqueIds([
        ...productIds,
        ...frontFaceNodes.map((node) => node.id),
        ...outfitNodes.map((node) => node.id),
        ...cleanSceneNodes.map((node) => node.id),
        ...sourceShotNodes.map((node) => node.id),
      ]).length;
      if (stopForImageInputIssues([
        exactImageInputIssue(sourceShotNodes, "参考视频场景帧（当前镜头人工选帧）"),
        exactImageInputIssue(cleanSceneNodes, "场景空镜"),
        productIds.length === 0 ? "缺少：商品图至少 1 张" : "",
        exactImageInputIssue(outfitNodes, "当前镜头穿搭图"),
        exactImageInputIssue(frontFaceNodes, "人脸正面定型图"),
        preliminaryReferenceCount > IMAGE_REFERENCE_LIMIT ? `冲突：合成参考图最多 ${IMAGE_REFERENCE_LIMIT} 张（当前 ${preliminaryReferenceCount} 张）` : "",
      ])) return null;
      const sourceShot = sourceShotNodes[0];
      const cleanScene = cleanSceneNodes[0];
      const currentOutfit = outfitNodes[0];
      const frontFace = frontFaceNodes[0];
      const references = uniqueIds([...productIds, frontFace.id, currentOutfit.id, cleanScene.id, sourceShot.id]);
      const faceIndex = taskProductNodes.length;
      const outfitIndex = faceIndex + 1;
      const cleanSceneIndex = outfitIndex + 1;
      const sourceShotIndex = cleanSceneIndex + 1;
      const referenceRoles = [
        ...taskProductNodes.map((node, index) => describeProductReference(node, index, index)),
        `Reference image ${faceIndex + 1} is the frontal face identity reference. Use it only to preserve the same face shape, facial features, hairstyle, hairline, natural skin tone, and age impression. Discard its white studio background, exposure, fill light, shadow pattern, catchlights, direct-lens gaze, neutral expression, and closed-mouth calibration state. Do not use it to set pose, framing, clothing, background, local lighting, gaze, or mouth state.`,
        `Reference image ${outfitIndex + 1} is the on-body outfit reference. Use it only to preserve the supplied person's on-body fit, garment drape, folds, product visibility, non-product garment, shoe, and accessory. Do not use it to set the target camera, crop, figure scale, body direction, pose, hand position, gaze, expression, or mouth state. Product structure and details still come from the product references.`,
        `Reference image ${cleanSceneIndex + 1} is the clean scene plate for this shot. Use it as the final background geometry: preserve its real space, object positions, structures, materials, textures, perspective, depth layers, and environment scale.`,
        `Reference image ${sourceShotIndex + 1} is the target reference-video frame. It controls only observable shot execution: visible image axis, apparent upward or downward relationship, perspective outcome, shot size, crop, subject bounding box, margins, placement, body direction, pose, hands, gaze, mouth state, expression function, visible light, exposure, depth of field, foreground occlusion, atmosphere, grain, and color. Do not infer physical camera height, shooting distance, device, focal length, or real light position. Use the source person only as an anonymous pose-and-light silhouette; never copy their identity, body shape, clothing, product, skin details, or accessories.`,
      ];
      return {
        title: "场景人物商品合成主图",
        description: "逐镜头复刻参考截图，只替换人物和商品，生成该段的合成主图。",
        referenceNodeIds: references,
        x: 1080,
        y: 900,
        prompt: [
          "Using the attached reference images, generate one photorealistic main image for the current shot. Reproduce the reference-video shot while replacing its person and product with the supplied person and supplied product.",
          "The attached reference images have fixed roles and order:",
          ...referenceRoles,
          `Priority is role-specific, not a global ranking. Product references control product facts. Reference image ${faceIndex + 1} controls face identity only. Reference image ${outfitIndex + 1} controls on-body garment fit and non-product styling only. Reference image ${cleanSceneIndex + 1} controls background geometry only. Reference image ${sourceShotIndex + 1} is mandatory for the target camera, framing, figure placement, body action, gaze, mouth state, light, exposure, depth, and color. When they conflict, keep the supplied person and supplied product details, then retarget them into the exact shot geometry and lighting of Reference image ${sourceShotIndex + 1}.`,
          `Do not use fixed height, full-body ratio, or body measurements for this task. Whether the target is full-body, medium, or partial-body, match only the visible body scale and crop of Reference image ${sourceShotIndex + 1}.`,
          `Build the exact camera and subject layout of Reference image ${sourceShotIndex + 1} first. Keep the person's frame occupancy, head-top margin, foot margin, side margins, and anchor point at the same relative positions; do not recenter, enlarge, shrink, or recrop the person. Transfer the source frame's body direction, head turn, weight distribution, hand relationship, and product-proof action onto the supplied person. Keep the product fully faithful to the product references, the face fully faithful to the frontal face reference, and the on-body garment fit and non-product styling faithful to the outfit reference.`,
          "PERSON PERFORMANCE BASELINE:",
          identityPerformanceBaseline,
          `Use the observable current-shot performance from Reference image ${sourceShotIndex + 1}, not a generic neutral start state: reproduce its gaze target, eye openness, facial tension, mouth state, and the functional emotion of the moment with the supplied face identity.`,
          `Use the light and color of Reference image ${sourceShotIndex + 1} as the final authority for both person and scene. Match its key-light direction, color temperature, facial highlight-shadow ratio, nose and cheek shadows, hair edge light, environmental bounce, contrast, exposure, depth of field, grain, and grade. Do not add white-studio frontal fill light, beauty retouching, artificial catchlights, or an unsupported rim light.`,
          `Make the person physically belong in the clean scene: match the source frame's perspective, focus plane, edge sharpness, cast shadow, contact shadow, reflections, occlusion, depth, and environment scale. Preserve the clean scene's object geometry while applying the source frame's final exposure and color relationship.`,
          "Keep the source-designated product-proof area readable while preserving the source-designated hand-to-garment contact. Keep hands anatomically complete and natural; do not let them hide the exact product area that the proof action is meant to reveal. Do not invent product details not visible in the product references. Output one single realistic main image with no added caption, watermark, platform UI, or non-product logo. Preserve a real product label or branding only when it is visible in the supplied product references.",
        ].join("\n"),
        promptMetadata: performancePromptMetadata,
      };
    }
    if (stopForImageInputIssues([
      exactImageInputIssue(repairTargetNodes, "合成主图或修复图"),
    ])) return null;
    const repairTarget = repairTargetNodes[0];
    return {
      title: "细节修复图",
      description: "在不改变主体构图的前提下修复场景纹理、服装细节、光影和肢体问题。",
      referenceNodeIds: [repairTarget.id],
      x: 1400,
      y: 900,
      prompt: [
        "Using Reference image 1, create one repaired version of the provided image.",
        "Reference image 1 is the only repair target. Use it only to preserve the same person, product, scene, camera angle, crop, placement, pose, hand relationship, lighting, color, and depth. Keep every area that is already correct unchanged.",
        `Correct only this approved repair target: ${imageRepairInstruction.trim()}. Do not guess a second defect or broaden the repair region.`,
        "Do not redesign the image. Preserve the existing expression, gaze, mouth state, and shot emotion unless an explicit repair request names one of them. Do not change identity, product structure or color, clothing, pose, scene, props, camera, light direction, or visual style. Do not add people, garments, accessories, text, watermarks, platform UI, or new objects.",
      ].join("\n"),
      promptMetadata: { preserveExistingPerformance: true },
    };
  }

  async function executeUploadVideo(nodeId: string) {
    const clientTask = beginClientTask(nodeId, "uploadVideo", "导入参考视频并抽帧");
    if (!clientTask) return;
    try {
      const form = new FormData();
      form.set("nodeId", nodeId);
      form.set("action", "upload_video");
      form.set("clientTaskId", clientTask.clientTaskId);
      if (sourceFile) form.set("sourceVideoFile", sourceFile);
      if (sourceVideoPath.trim()) form.set("sourceVideoPath", sourceVideoPath.trim());
      if (!sourceFile && !sourceVideoPath.trim() && sourceVideoNode?.id) {
        form.set("sourceNodeId", sourceVideoNode.id);
      }
      form.set("storyboardInterval", String(storyboardInterval));
      const res = await fetch(`/api/board-workflows/${id}/execute`, { method: "POST", body: form, signal: clientTask.controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "参考视频导入和抽帧失败");
      adoptWorkflow(data.workflow);
      // A successful import owns the stored source. A later re-extract should reuse it instead of resending this File.
      setSourceFile(null);
      setSourceVideoPath("");
      if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
    } catch (err) {
      await handleTaskFailure(err, "参考视频导入和抽帧失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function executeExtractAudio(nodeId: string, selectedSourceNodeId = "") {
    const clientTask = beginClientTask(nodeId, "extractAudio", "剥离完整音频");
    if (!clientTask) return;
    try {
      const form = new FormData();
      form.set("executorNodeId", nodeId);
      form.set("clientTaskId", clientTask.clientTaskId);
      // A newly chosen file/path is deliberately sent first. It must never be
      // silently replaced by an older source_video node already on the board.
      if (sourceFile) form.set("sourceVideoFile", sourceFile);
      if (sourceVideoPath.trim()) form.set("sourceVideoPath", sourceVideoPath.trim());
      if (!sourceFile && !sourceVideoPath.trim() && selectedSourceNodeId) {
        form.set("sourceNodeId", selectedSourceNodeId);
      }
      const res = await fetch(`/api/board-workflows/${id}/audio`, {
        method: "POST",
        body: form,
        signal: clientTask.controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (data.workflow) adoptWorkflow(data.workflow as BoardWorkflow);
      if (!res.ok) throw new Error(data.error || "完整音频剥离失败");
      if (sourceFile || sourceVideoPath.trim()) {
        setSourceFile(null);
        setSourceVideoPath("");
        if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
      }
      setBoardNotice("完整音频已生成；这条视频已保存为当前参考视频，现在可以直接生成视频证据。");
    } catch (err) {
      await handleTaskFailure(err, "完整音频剥离失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function executeNodeAction(nodeId: string, action: string, payload: Record<string, unknown>, busyKey: string, fallbackError: string, label = busyKey) {
    const clientTask = beginClientTask(nodeId, busyKey, label);
    if (!clientTask) return null;
    try {
      if (action === "image_task") {
        let requestError: unknown;
        let pollingError: unknown;
        const requestOutcome = (async () => {
          const res = await fetch(`/api/board-workflows/${id}/image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: clientTask.controller.signal,
            body: JSON.stringify({
              ...payload,
              executorNodeId: nodeId,
              clientTaskId: clientTask.clientTaskId,
              clientStartedAt: clientTask.startedAt,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const returnedWorkflow = data.workflow as BoardWorkflow | undefined;
            if (returnedWorkflow) adoptWorkflow(returnedWorkflow);
            if (!shouldKeepPollingImageTaskAfterHttpError(
              res.status,
              returnedWorkflow,
              nodeId,
              clientTask.clientTaskId
            )) {
              clientTask.controller.abort();
            }
            throw new Error(data.error || fallbackError);
          }
          if (data.pending || data.cancelled) {
            return { data, workflow: data.workflow as BoardWorkflow | undefined, imageVisible: false };
          }
          const visibleWorkflow = data.workflow
            ? await prepareVisibleImageWorkflow(
              data.workflow as BoardWorkflow,
              nodeId,
              clientTask.clientTaskId,
              clientTask.controller.signal
            )
            : null;
          if (!visibleWorkflow) {
            throw new Error("图片请求已经返回，但本地文件或画板输出节点尚未同步完成。");
          }
          return { data, workflow: visibleWorkflow, imageVisible: true };
        })().catch((error) => {
          requestError = error;
          throw error;
        });
        const pollingOutcome = waitForImageBoardSync(
          nodeId,
          clientTask.clientTaskId,
          clientTask.controller.signal
        ).then((latestWorkflow) => ({
          data: { workflow: latestWorkflow },
          workflow: latestWorkflow,
          imageVisible: true,
        })).catch((error) => {
          pollingError = error;
          throw error;
        });

        let outcome: Awaited<typeof requestOutcome>;
        try {
          outcome = await Promise.any([requestOutcome, pollingOutcome]);
        } catch {
          const cause = pollingError instanceof Error && !isAbortError(pollingError)
            ? pollingError
            : requestError || pollingError;
          throw cause instanceof Error ? cause : new Error(fallbackError);
        }
        clientTask.controller.abort();
        if (outcome.workflow) adoptWorkflow(outcome.workflow);
        await loadPendingImageResults();
        setImageRecoveryNotice(outcome.data.pending ? String(outcome.data.error || "图片结果已保全，等待本地保存恢复。") : "");
        if (outcome.imageVisible) setBoardNotice("图片已保存到本地并同步到画板。");
        return outcome.data;
      }

      const res = await fetch(`/api/board-workflows/${id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({ nodeId, action, payload: { ...payload, clientTaskId: clientTask.clientTaskId } }),
      });
      const data = await res.json();
      if (data.workflow) adoptWorkflow(data.workflow);
      if (!res.ok) throw new Error(data.error || fallbackError);
      return data;
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err instanceof Error ? err.message : fallbackError);
        await syncWorkflowAfterTaskError();
      }
      return null;
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function retryPendingImageResult(pending: BoardImagePendingSummary) {
    const clientTask = beginClientTask(pending.executorNodeId, "image_recovery", `继续保存：${pending.title}`);
    if (!clientTask) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({
          action: "retry_pending",
          pendingResultId: pending.id,
          executorNodeId: pending.executorNodeId,
          clientTaskId: clientTask.clientTaskId,
        }),
      });
      const data = await res.json();
      if (data.workflow) adoptWorkflow(data.workflow);
      await loadPendingImageResults();
      setImageRecoveryNotice(data.pending ? String(data.error || "图片结果仍在等待本地保存恢复。") : "");
      if (!res.ok) throw new Error(data.error || "继续保存图片结果失败");
    } catch (err) {
      await handleTaskFailure(err, "继续保存图片结果失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  function videoInputsForExecutor(executorNodeId: string) {
    const linkedNodes = manualDirectInputIds(executorNodeId)
      .map((nodeId) => nodes.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    const directors = linkedNodes.filter((node) => roleOf(node) === "video_director_prompt");
    const candidates = linkedNodes.filter((node) =>
      !directors.some((director) => director.id === node.id)
      && !["generated_video", "composed_video"].includes(roleOf(node))
    );
    const profile = getBoardVideoProfile(selectedVideoChannel);
    if (profile && usesVideoReferenceRolePackage(selectedVideoChannel)) {
      return {
        director: directors.length === 1 ? directors[0] : undefined,
        referenceNodes: candidates,
        referenceError: "",
      };
    }
    return {
      director: directors.length === 1 ? directors[0] : undefined,
      referenceNodes: candidates,
      referenceError: "",
    };
  }

  function taskReferenceIdsForSegment(executorNodeId: string, segment: VideoSegmentPlan) {
    const executor = nodes.find((node) => node.id === executorNodeId);
    const inputs = videoInputsForExecutor(executorNodeId);
    const profile = getBoardVideoProfile(selectedVideoChannel);
    const candidates = inputs.referenceNodes;
    const candidateIds = new Set(candidates.map((node) => node.id));
    const stored = executor?.meta?.videoTaskReferenceIds;
    const storedIds = stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)[String(segment.index)]
      : [];
    const validStoredIds = Array.isArray(storedIds)
      ? storedIds.filter((item): item is string => typeof item === "string" && candidateIds.has(item))
      : [];
    if (validStoredIds.length > 0) return uniqueIds(validStoredIds);

    if (profile && usesVideoReferenceRolePackage(selectedVideoChannel)) {
      return VIDEO_TASK_REFERENCE_ROLES.map((role) => (
        candidates.filter((node) => videoReferenceRole(node) === role).at(-1)?.id || ""
      )).filter(Boolean);
    }
    return candidates.filter(isVideoVisualBase).slice(-1).map((node) => node.id);
  }

  function taskReferenceSelectionForSegment(executorNodeId: string, segment: VideoSegmentPlan) {
    const inputs = videoInputsForExecutor(executorNodeId);
    const selectedIds = taskReferenceIdsForSegment(executorNodeId, segment);
    const selected = selectedIds
      .map((nodeId) => inputs.referenceNodes.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    const profile = getBoardVideoProfile(selectedVideoChannel);
    if (!profile) return { selectedIds, selected, error: "当前视频模型没有画板协议配置。" };
    if (usesVideoReferenceRolePackage(selectedVideoChannel)) {
      const packageResult = grokReferencePackageFromNodes(selected);
      return {
        selectedIds,
        selected: packageResult.package?.ordered || selected,
        error: packageResult.error || "",
      };
    }
    const valid = selected.length === 1 && isVideoVisualBase(selected[0]);
    return { selectedIds, selected, error: valid ? "" : "当前模型需要选择 1 张合成主图或修复图。" };
  }

  function saveTaskReferenceIds(executorNodeId: string, segmentIndex: number, referenceNodeIds: string[]) {
    const nextNodes = nodes.map((node) => {
      if (node.id !== executorNodeId) return node;
      const current = node.meta?.videoTaskReferenceIds;
      const map = current && typeof current === "object" && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {};
      return {
        ...node,
        meta: {
          ...(node.meta || {}),
          videoTaskReferenceIds: {
            ...map,
            [String(segmentIndex)]: uniqueIds(referenceNodeIds),
          },
        },
      };
    });
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function directVideoReplacementReferenceIds(executorNodeId: string) {
    const executor = nodes.find((node) => node.id === executorNodeId);
    const candidates = videoInputsForExecutor(executorNodeId).referenceNodes;
    const profile = getBoardVideoProfile(selectedVideoChannel);
    return resolveDirectVideoReplacementReferenceIds(
      candidates,
      executor?.meta?.directVideoReplacementReferenceIds,
      { referenceContract: profile?.directVideoReplacementReferenceContract },
    );
  }

  function directVideoReplacementSelection(executorNodeId: string) {
    const candidates = videoInputsForExecutor(executorNodeId).referenceNodes;
    const selectedIds = directVideoReplacementReferenceIds(executorNodeId);
    const selected = selectedIds
      .map((nodeId) => candidates.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    const profile = getBoardVideoProfile(selectedVideoChannel);
    const packageResult = directVideoReplacementPackageFromNodes(selected, {
      sceneOptional: Boolean(profile?.directVideoReplacementSceneOptional),
      faceOptional: Boolean(profile?.directVideoReplacementFaceOptional),
      referenceContract: profile?.directVideoReplacementReferenceContract,
    });
    return {
      selectedIds,
      selected: packageResult.package?.ordered || selected,
      error: packageResult.error || "",
    };
  }

  function saveVideoChannelSelection(executorNodeId: string, channelId: string) {
    if (!videoChannels.some((channel) => channel.id === channelId)) return;
    setSelectedVideoChannelId(channelId);
    const nextNodes = nodes.map((node) => node.id === executorNodeId ? {
      ...node,
      meta: {
        ...(node.meta || {}),
        [LAST_SELECTED_VIDEO_CHANNEL_META_KEY]: channelId,
      },
    } : node);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function hasPersistedDirectVideoTask(executorNodeId: string) {
    const job = nodes.find((node) => node.id === executorNodeId)?.execution?.videoJob;
    return Boolean(
      job?.taskId
      && ["submitted", "queued", "running", "completed_pending_content"].includes(String(job.status || "")),
    );
  }

  function saveDirectVideoReplacementReferenceIds(executorNodeId: string, referenceNodeIds: string[]) {
    if (hasPersistedDirectVideoTask(executorNodeId)) {
      setError("远端视频任务已提交，等待完成或取消后才能修改本次参考素材。" );
      return;
    }
    const nextNodes = nodes.map((node) => node.id === executorNodeId ? {
      ...node,
      meta: {
        ...(node.meta || {}),
        directVideoReplacementReferenceIds: uniqueIds(referenceNodeIds),
      },
    } : node);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function directVideoReplacementAudioNodeId(executorNodeId: string) {
    const executor = nodes.find((node) => node.id === executorNodeId);
    const candidates = videoInputsForExecutor(executorNodeId).referenceNodes;
    const stored = String(executor?.meta?.directVideoReplacementAudioNodeId || "");
    if (stored && candidates.some((node) => node.id === stored && isDirectVideoReplacementAudioReference(node))) {
      return stored;
    }
    return "";
  }

  function saveDirectVideoReplacementAudioNodeId(executorNodeId: string, audioNodeId: string) {
    if (hasPersistedDirectVideoTask(executorNodeId)) {
      setError("远端视频任务已提交，等待完成或取消后才能修改本次参考音频。" );
      return;
    }
    const nextNodes = nodes.map((node) => node.id === executorNodeId ? {
      ...node,
      meta: {
        ...(node.meta || {}),
        directVideoReplacementAudioNodeId: audioNodeId,
      },
    } : node);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function directVideoReplacementGenerationSeconds(executorNodeId: string) {
    const profile = getBoardVideoProfile(selectedVideoChannel);
    if (!profile?.directVideoReplacement) return 0;
    const executor = nodes.find((node) => node.id === executorNodeId);
    const stored = Math.round(Number(executor?.meta?.directVideoReplacementGenerationSeconds || 0));
    return profile.durationOptions.includes(stored) ? stored : profile.generationSeconds;
  }

  function saveDirectVideoReplacementGenerationSeconds(executorNodeId: string, generationSeconds: number) {
    if (hasPersistedDirectVideoTask(executorNodeId)) {
      setError("远端视频任务已提交，等待完成或取消后才能修改本次生成时长。" );
      return;
    }
    const profile = getBoardVideoProfile(selectedVideoChannel);
    const normalized = Math.round(Number(generationSeconds));
    if (!profile?.directVideoReplacement || !profile.durationOptions.includes(normalized)) return;
    const nextNodes = nodes.map((node) => node.id === executorNodeId ? {
      ...node,
      meta: {
        ...(node.meta || {}),
        directVideoReplacementGenerationSeconds: normalized,
      },
    } : node);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function directVideoReplacementResolution(executorNodeId: string) {
    const profile = getBoardVideoProfile(selectedVideoChannel);
    if (!profile?.directVideoReplacement) return null;
    const executor = nodes.find((node) => node.id === executorNodeId);
    const stored = String(executor?.meta?.directVideoReplacementResolution || "").trim().toLowerCase() as BoardVideoResolution;
    return profile.resolutionOptions.includes(stored) ? stored : profile.resolution;
  }

  function saveDirectVideoReplacementResolution(executorNodeId: string, resolution: BoardVideoResolution) {
    if (hasPersistedDirectVideoTask(executorNodeId)) {
      setError("远端视频任务已提交，等待完成或取消后才能修改本次分辨率。" );
      return;
    }
    const profile = getBoardVideoProfile(selectedVideoChannel);
    if (!profile?.directVideoReplacement || !profile.resolutionOptions.includes(resolution)) return;
    const nextNodes = nodes.map((node) => node.id === executorNodeId ? {
      ...node,
      meta: {
        ...(node.meta || {}),
        directVideoReplacementResolution: resolution,
      },
    } : node);
    setWorkflow((current) => current ? { ...current, nodes: nextNodes } : current);
    void saveBoard(nextNodes, workflow?.edges);
  }

  function latestNodeForSegment(segment: VideoSegmentPlan, executorNodeId: string) {
    return manualDirectGeneratedVideoNodes({ edges: workflow?.edges || [] }, nodes, executorNodeId)
      .filter((node) => Number(node.meta?.segmentIndex || 0) === segment.index)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }

  function readySegmentNodes(executorNodeId: string) {
    return videoSegments.map((segment) => latestNodeForSegment(segment, executorNodeId)).filter(Boolean) as BoardWorkflowNode[];
  }

  function directorPromptTextForNode(promptNode?: BoardWorkflowNode, segment?: VideoSegmentPlan) {
    if (!promptNode?.promptEnglish) return "";
    const parsed = promptNode.meta?.parsed as {
      segmentPrompts?: Array<{
        segmentIndex?: number;
        promptEnglish?: string;
      }>;
      fullDirectorPromptEnglish?: string;
    } | undefined;
    const segmentPrompt = segment
      ? parsed?.segmentPrompts?.find((item) => Number(item.segmentIndex) === segment.index)?.promptEnglish
      : "";
    if (segment && !segmentPrompt) return "";
    return segmentPrompt || parsed?.fullDirectorPromptEnglish || promptNode.promptEnglish || "";
  }

  async function composeSegmentedVideos(executorNodeId = "") {
    if (videoSegments.length === 1) {
      setBoardNotice("单任务完成后会直接成为完整成片，不需要再次合成。");
      return;
    }
    const readyNodes = readySegmentNodes(executorNodeId);
    if (readyNodes.length < videoSegments.length) {
      setError(`还有 ${videoSegments.length - readyNodes.length} 个分段视频没有手动连入当前视频节点，全部连接后才能合成。`);
      return;
    }
    const executorNode = nodes.find((node) => node.id === executorNodeId);
    const outputPosition = generatedOutputPosition({
      nodes,
      anchor: executorNode,
      outputKind: "video_clip",
      outputRole: "composed_video",
      outputSlot: "video_final",
    });
    const payload = {
      videoNodeIds: readyNodes.map((node) => node.id),
      channelId: selectedVideoChannel?.id || "",
      resultTitle: "画板合成完整成片",
      resultDescription: `由 ${readyNodes.length} 个分段视频按顺序合成。`,
      x: outputPosition.x,
      y: outputPosition.y,
    };
    const clientTask = beginClientTask(executorNodeId, "videoCompose", "合成完整成片");
    if (!clientTask) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/video-compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({ ...payload, executorNodeId, clientTaskId: clientTask.clientTaskId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "视频合成失败");
      adoptWorkflow(data.workflow);
    } catch (err) {
      await handleTaskFailure(err, "视频合成失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function executeAnalyze(nodeId: string) {
    if (!llm.apiKey || !llm.baseUrl || !llm.model) {
      setError("请先在设置页配置 LLM。");
      return;
    }
    await executeNodeAction(nodeId, "gpt_analyze", { llm, analysisFocus }, "analyze", "GPT 拆解失败", "生成参考视频拆解报告");
  }

  async function executeCaptureFrame(nodeId: string) {
    const time = videoRef.current?.currentTime ?? captureTime;
    const data = await executeNodeAction(nodeId, "capture_frame", { time }, "capture", "截图失败", `截图 ${time.toFixed(1)}s`);
    if (data) setCaptureTime(time);
  }

  async function transcribeAudioNode(audioNodeId: string) {
    const clientTask = beginClientTask(audioNodeId, "audio-transcribe", "中文音频转写");
    if (!clientTask) return;
    try {
      const res = await fetch(`/api/board-workflows/${id}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({ audioNodeId, clientTaskId: clientTask.clientTaskId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "本地音频转写失败");
      if (data.workflow) adoptWorkflow(data.workflow);
    } catch (err) {
      await handleTaskFailure(err, "本地音频转写失败");
    } finally {
      endClientTask(clientTask.token);
    }
  }

  function normalizePreviewTime(value: number) {
    const duration = videoRef.current?.duration;
    const max = Number.isFinite(duration) && duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(max, value));
  }

  function seekPreviewTime(value: number) {
    const next = normalizePreviewTime(value);
    setCaptureTime(next);
    if (videoRef.current) {
      videoRef.current.currentTime = next;
      videoRef.current.pause();
    }
  }

  function nudgePreviewTime(delta: number) {
    seekPreviewTime((videoRef.current?.currentTime ?? captureTime) + delta);
  }

  function renderFrameSeekControls(onCapture: () => void, captureLabel: string, captureDisabled = false) {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <Input
            type="number"
            min={0}
            step={0.1}
            value={captureTime.toFixed(1)}
            onChange={(event) => setCaptureTime(normalizePreviewTime(Number(event.target.value || 0)))}
            onKeyDown={(event) => {
              if (event.key === "Enter") seekPreviewTime(captureTime);
            }}
          />
          <Button variant="outline" onClick={() => seekPreviewTime(captureTime)} disabled={Boolean(busy)}>
            跳到此秒
          </Button>
          <Button onClick={onCapture} disabled={Boolean(busy) || captureDisabled}>
            {busy === "capture" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuCamera className="mr-1.5 h-4 w-4" />}
            {captureLabel}
          </Button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Button variant="outline" size="sm" onClick={() => nudgePreviewTime(-1)} disabled={Boolean(busy)}>-1s</Button>
          <Button variant="outline" size="sm" onClick={() => nudgePreviewTime(-0.1)} disabled={Boolean(busy)}>-0.1s</Button>
          <Button variant="outline" size="sm" onClick={() => nudgePreviewTime(0.1)} disabled={Boolean(busy)}>+0.1s</Button>
          <Button variant="outline" size="sm" onClick={() => nudgePreviewTime(1)} disabled={Boolean(busy)}>+1s</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">可以直接输入秒数并跳转；没截准时用 ±0.1s / ±1s 微调，不需要从头拖进度条。</p>
      </div>
    );
  }

  function renderDirectVideoReplacementManager(executorNodeId: string, inputsReady = true) {
    const selection = directVideoReplacementSelection(executorNodeId);
    const taskPersisted = hasPersistedDirectVideoTask(executorNodeId);
    const candidates = videoInputsForExecutor(executorNodeId).referenceNodes;
    const profile = getBoardVideoProfile(selectedVideoChannel);
    const audioOptions = profile && profile.maxReferenceAudios > 0
      ? candidates.filter(isDirectVideoReplacementAudioReference)
      : [];
    const selectedAudioNodeId = directVideoReplacementAudioNodeId(executorNodeId);
    const productFrontFaceContract = profile?.directVideoReplacementReferenceContract === "product_front_face";
    const productFrontFaceOptional = productFrontFaceContract && profile?.directVideoReplacementFaceOptional;
    const roleOrder: Array<"reference_video" | "product" | "face" | "model" | "scene"> = productFrontFaceContract
      ? ["reference_video", "product", "face", "scene"]
      : ["reference_video", "product", "face", "model", "scene"];
    const roleLabels = {
      reference_video: "参考视频",
      product: productFrontFaceContract ? "商品正面图" : "商品多视图故事板",
      face: productFrontFaceOptional ? "人脸图（可选）" : "人脸图",
      model: "人物图",
      scene: profile?.directVideoReplacementSceneOptional ? "场景图（可选）" : "场景图",
    } as const;
    const generated = [...nodes].reverse().find((item) => (
      String(item.meta?.executorNodeId || "") === executorNodeId
      && String(item.meta?.executionMode || "") === "direct_video_replacement"
      && String(item.meta?.assetRole || "") === "composed_video"
    ));
    const disabledReason = taskPersisted
      ? "远端视频任务已提交，正在按原始通道与素材等待结果。"
      : busy
      ? "当前有任务正在执行，请等待完成。"
      : !inputsReady
        ? "请先完成当前视频节点要求的上游输入。"
        : selection.error
          ? selection.error
          : "";
    return (
      <div className="space-y-2 rounded-xl border border-cyan-100/20 bg-slate-950/55 p-3 text-xs shadow-inner shadow-cyan-950/20">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-semibold text-cyan-50">直接参考视频替换</p>
            <p className="text-[11px] text-slate-300/85">
              {productFrontFaceContract
                ? productFrontFaceOptional
                  ? "1 条参考视频 + 商品正面图 · 人脸图、场景图可选"
                  : "1 条参考视频 + 商品正面图 + 人脸图 · 场景图可选"
                : profile?.directVideoReplacementSceneOptional
                ? "1 条参考视频 + 商品多视图故事板 + 人脸图 + 人物图 · 场景图可选"
                : "1 条参考视频 + 商品多视图故事板 + 3 张职责图 · 不经过拆解、导演稿、分段或合成"}
            </p>
          </div>
          <Badge variant={generated ? "default" : "secondary"}>{generated ? "已生成" : "待生成"}</Badge>
        </div>
        <div className="space-y-1.5 rounded-lg border border-cyan-100/15 bg-black/20 p-2">
          {roleOrder.map((role) => {
            const options = candidates.filter((node) => (
              directVideoReplacementReferenceRole(node, profile?.directVideoReplacementReferenceContract) === role
            ));
            const currentId = selection.selected.find((node) => (
              directVideoReplacementReferenceRole(node, profile?.directVideoReplacementReferenceContract) === role
            ))?.id || "";
            const label = roleLabels[role];
            const optionalRole = (role === "scene" && profile?.directVideoReplacementSceneOptional)
              || (role === "face" && productFrontFaceOptional);
            return (
              <label key={role} className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-1.5 text-[10px] text-slate-100">
                <span>{label}</span>
                <select
                  className="h-7 min-w-0 rounded-md border border-cyan-100/20 bg-slate-950/75 px-1.5 text-[10px] text-slate-100 disabled:cursor-not-allowed disabled:opacity-70"
                  value={currentId}
                  disabled={Boolean(busy) || taskPersisted || options.length === 0}
                  aria-label={`直接视频替换：${label}`}
                  title={options.length === 0 ? `请将${label}手动连入当前视频节点` : `选择${label}`}
                  onChange={(event) => {
                    const nextIds = selection.selectedIds.filter((id) => {
                      const selectedNode = candidates.find((node) => node.id === id);
                      return directVideoReplacementReferenceRole(selectedNode, profile?.directVideoReplacementReferenceContract) !== role;
                    });
                    if (event.target.value) nextIds.push(event.target.value);
                    saveDirectVideoReplacementReferenceIds(executorNodeId, nextIds);
                  }}
                >
                  <option value="">
                    {options.length === 0
                      ? (optionalRole ? `未连接${label}` : `未连入${label}`)
                      : (optionalRole ? `不使用${label.replace("（可选）", "")}` : `请选择${label}`)}
                  </option>
                  {options.map((node) => <option key={node.id} value={node.id}>{displayTitle(node)}</option>)}
                </select>
              </label>
            );
          })}
          {profile && profile.maxReferenceAudios > 0 && (
            <label className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-1.5 text-[10px] text-slate-100">
              <span>参考音频</span>
              <select
                className="h-7 min-w-0 rounded-md border border-cyan-100/20 bg-slate-950/75 px-1.5 text-[10px] text-slate-100 disabled:cursor-not-allowed disabled:opacity-70"
                value={selectedAudioNodeId}
                disabled={Boolean(busy) || taskPersisted || audioOptions.length === 0}
                aria-label="直接视频替换：参考音频"
                title={audioOptions.length === 0 ? "可选：将完整音频节点手动连入当前视频节点" : "可选：选择要随视频发送的参考音频"}
                onChange={(event) => saveDirectVideoReplacementAudioNodeId(executorNodeId, event.target.value)}
              >
                <option value="">不发送音频</option>
                {audioOptions.map((node) => <option key={node.id} value={node.id}>{displayTitle(node)}</option>)}
              </select>
            </label>
          )}
        </div>
        {selection.error && (
          <div role="alert" className="rounded-md border border-amber-200/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-100">
            {selection.error}
          </div>
        )}
        <Button
          type="button"
          className="w-full bg-cyan-400 text-slate-950 hover:bg-cyan-300"
          onClick={() => void executeDirectVideoReplacementTask(executorNodeId)}
          disabled={Boolean(busy) || taskPersisted || !inputsReady || Boolean(selection.error)}
          title={disabledReason || undefined}
        >
          {busy === "video" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuVideo className="mr-1.5 h-4 w-4" />}
          {generated ? "重新生成替换成片" : "生成替换成片"}
        </Button>
      </div>
    );
  }

  function renderVideoSegmentManager(
    executorNodeId: string,
    onGenerateSegment: (segment: VideoSegmentPlan) => void,
    onCompose: () => void,
    inputsReady = true,
  ) {
    const plannedTotal = videoSegments[0]?.requestedTotal || 0;
    const plannedOutputTotal = videoSegments[0]?.plannedOutputDuration || 0;
    const selectedProfile = getBoardVideoProfile(selectedVideoChannel);
    const readyNodes = readySegmentNodes(executorNodeId);
    const connectedDirector = videoInputsForExecutor(executorNodeId).director;
    const directorIsCurrent = Boolean(
      connectedDirector
      && Number(connectedDirector.meta?.directorSchemaVersion || 0) === VIDEO_DIRECTOR_SCHEMA_VERSION
      && Number(connectedDirector.meta?.targetDuration || 0) === plannedTotal
      && String(connectedDirector.meta?.videoChannelId || "") === String(selectedVideoChannel?.id || "")
      && String(connectedDirector.meta?.videoModel || "") === String(selectedProfile?.model || "")
      && Number(connectedDirector.meta?.videoGenerationSeconds || 0) === selectedProfile?.generationSeconds
      && String(connectedDirector.meta?.videoCapabilitySignature || "") === String(selectedProfile?.capabilitySignature || "")
    );
    return (
      <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-semibold text-violet-950">分段视频任务管理</p>
            <p className="text-[11px] text-violet-800">
              {selectedProfile?.model || "未选择模型"} · 每任务 {selectedProfile?.generationSeconds ?? "-"}s（可用：{selectedProfile?.durationOptions.join(",") || "未配置"}）· {selectedProfile?.aspectRatio || "-"} · {selectedProfile?.resolution || "-"} · 参考 {plannedTotal.toFixed(1).replace(/\.0$/, "")}s → 输出 {plannedOutputTotal.toFixed(1).replace(/\.0$/, "")}s
            </p>
          </div>
          <Badge variant="secondary">{readyNodes.length}/{videoSegments.length}</Badge>
        </div>
        {!directorIsCurrent && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-[11px] text-amber-900">
            当前完整导演稿与所选模型或时长计划不一致。请在“完整视频导演稿”节点重新选择时长并生成后，再提交视频任务。
          </div>
        )}
        <div className="space-y-2">
          {videoSegments.map((segment) => {
            const generated = latestNodeForSegment(segment, executorNodeId);
            const referenceSelection = taskReferenceSelectionForSegment(executorNodeId, segment);
            const referenceCandidates = videoInputsForExecutor(executorNodeId).referenceNodes;
            const usesRolePackage = Boolean(selectedProfile && usesVideoReferenceRolePackage(selectedVideoChannel));
            const requiredReferenceCount = usesRolePackage ? VIDEO_TASK_REFERENCE_ROLES.length : 1;
            const generateDisabledReason = busy
              ? "当前有任务正在执行，请等待完成。"
              : !inputsReady
                ? "请先完成当前视频节点要求的上游输入。"
                : !directorIsCurrent
                  ? "请先按当前模型和时长重新生成完整视频导演稿。"
                  : referenceSelection.error;
            return (
              <div key={segment.index} className="rounded-xl border bg-white p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-zinc-900">任务 {segment.index}：参考 {segment.sourceTimeRange} · 输出 {segment.outputTimeRange}</p>
                    <p className="text-[11px] text-muted-foreground">
                      完整生成并保留 {segment.outputDuration}s · 覆盖 {segment.sourceDuration.toFixed(1).replace(/\.0$/, "")}s 参考证据 · 任务需 {selectedProfile?.referenceImageCount ?? "-"} 张参考图（模型最多 {selectedProfile?.maxReferenceImages ?? "-"} 张）· {generated ? `已生成：${displayTitle(generated)}` : "待生成"}
                    </p>
                  </div>
                  <Badge variant={generated ? "default" : "secondary"}>{generated ? "已生成" : "待生成"}</Badge>
                </div>
                <div className="mb-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold text-zinc-700">本任务素材</p>
                    <span className="text-[10px] text-zinc-500">
                      已识别 {referenceSelection.selected.length}/{requiredReferenceCount}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    候选素材只读取直接手动连入当前视频节点的有效资产。
                  </p>
                  {usesRolePackage ? (
                    <div className="mt-1.5 grid gap-1.5">
                      {VIDEO_TASK_REFERENCE_ROLES.map((role) => {
                        const options = referenceCandidates.filter((node) => videoReferenceRole(node) === role);
                        const currentId = referenceSelection.selected.find((node) => videoReferenceRole(node) === role)?.id || "";
                        const roleLabel = VIDEO_TASK_REFERENCE_ROLE_LABEL[role];
                        return (
                          <label key={role} className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-1.5 text-[10px] text-zinc-600">
                            <span>{roleLabel}</span>
                            <select
                              className="h-7 min-w-0 rounded-md border border-zinc-200 bg-white px-1.5 text-[10px] text-zinc-800 disabled:cursor-not-allowed disabled:opacity-70"
                              value={currentId}
                              disabled={Boolean(busy) || options.length === 0}
                              aria-label={`任务 ${segment.index}：${roleLabel}`}
                              title={options.length === 0 ? `请将${roleLabel}素材节点手动连入当前视频节点` : `为任务 ${segment.index} 选择${roleLabel}`}
                              onChange={(event) => {
                                const nextIds = referenceSelection.selectedIds.filter((id) => {
                                  const node = referenceCandidates.find((candidate) => candidate.id === id);
                                  return videoReferenceRole(node) !== role;
                                });
                                if (event.target.value) nextIds.push(event.target.value);
                                saveTaskReferenceIds(executorNodeId, segment.index, nextIds);
                              }}
                            >
                              <option value="">{options.length === 0 ? `未连入${roleLabel}` : `请选择${roleLabel}`}</option>
                              {options.map((node) => <option key={node.id} value={node.id}>{displayTitle(node)}</option>)}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <label className="mt-1.5 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-1.5 text-[10px] text-zinc-600">
                      <span>合成 / 修复图</span>
                      <select
                        className="h-7 min-w-0 rounded-md border border-zinc-200 bg-white px-1.5 text-[10px] text-zinc-800 disabled:cursor-not-allowed disabled:opacity-70"
                        value={referenceSelection.selectedIds[0] || ""}
                        disabled={Boolean(busy) || referenceCandidates.filter(isVideoVisualBase).length === 0}
                        aria-label={`任务 ${segment.index}：合成 / 修复图`}
                        title={referenceCandidates.filter(isVideoVisualBase).length === 0 ? "请将合成主图或修复图手动连入当前视频节点" : `为任务 ${segment.index} 选择合成主图或修复图`}
                        onChange={(event) => saveTaskReferenceIds(executorNodeId, segment.index, event.target.value ? [event.target.value] : [])}
                      >
                        <option value="">{referenceCandidates.filter(isVideoVisualBase).length === 0 ? "未连入合成 / 修复图" : "请选择合成 / 修复图"}</option>
                        {referenceCandidates.filter(isVideoVisualBase).map((node) => <option key={node.id} value={node.id}>{displayTitle(node)}</option>)}
                      </select>
                    </label>
                  )}
                  {referenceSelection.error && (
                    <div role="alert" className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-900">
                      {referenceSelection.error}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant={generated ? "outline" : "default"}
                  size="sm"
                  className="w-full"
                  onClick={() => onGenerateSegment(segment)}
                  disabled={Boolean(busy) || !inputsReady || !directorIsCurrent || Boolean(referenceSelection.error)}
                  title={generateDisabledReason || undefined}
                >
                  {busy === "video" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuVideo className="mr-1.5 h-4 w-4" />}
                  {generated ? `重新生成任务 ${segment.index}` : `生成任务 ${segment.index}`}
                </Button>
              </div>
            );
          })}
        </div>
        {videoSegments.length === 1 ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-[11px] text-emerald-800">
            该时长只需 1 个任务，生成完成后直接作为完整成片。
          </div>
        ) : (
          <Button
            type="button"
            className="w-full"
            variant="outline"
            onClick={onCompose}
            disabled={Boolean(busy) || !directorIsCurrent || readyNodes.length < videoSegments.length}
          >
            {busy === "videoCompose" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuLayers className="mr-1.5 h-4 w-4" />}
            合成完整成片
          </Button>
        )}
      </div>
    );
  }

  async function executeImageTask(task: ImageTask, nodeId: string) {
    if (!requireImageChannel()) return;
    if (task === "repaired_image" && !imageRepairInstruction.trim()) {
      setError("修复细节前请填写英文“区域 + 可见缺陷 + 目标状态”；服务端不会猜修复位置。");
      return;
    }
    const taskMap = buildImageTask(task, nodeId);
    if (!taskMap) return;
    const outputPosition = generatedOutputPosition({
      nodes,
      anchor: nodes.find((node) => node.id === nodeId),
      outputKind: "image_asset",
      outputRole: task,
    });
    const taskAspectRatio = task === "product_white_background" ? "1:1" : aspectRatio;
    const imageSize = imageDimensionsForPreset(taskAspectRatio, "4k");
    await executeNodeAction(nodeId, "image_task", {
      provider: "openai-seedance",
      channel: selectedImageChannel,
      endpointPath: selectedImageChannel?.endpointPath,
      repairInstruction: task === "repaired_image" ? imageRepairInstruction.trim() : undefined,
      referenceNodeIds: taskMap.referenceNodeIds,
      assetRole: task,
      x: outputPosition.x,
      y: outputPosition.y,
      aspectRatio: taskAspectRatio,
      ...(imageSize ? { width: imageSize.width, height: imageSize.height } : {}),
    }, task, "image-2 生成失败", taskMap.title);
  }

  async function createDetailImageBatch(executorNodeId: string) {
    if (!requireImageChannel()) return;
    if (!detailBatchProductNodeId) {
      setError("请先选择本批次使用的产品白底图。");
      return;
    }
    if (detailBatchFiles.length === 0) {
      setError("请先选择至少 1 张详情图。");
      return;
    }
    const productNode = nodes.find((node) => node.id === detailBatchProductNodeId);
    if (!productNode || roleOf(productNode) !== "product_white_background" || !productNode.publicUrl) {
      setError("所选产品白底图不可用，请重新选择已完成的产品白底图。");
      return;
    }
    const connectedFrontFaces = manualDirectInputIds(executorNodeId)
      .map((nodeId) => nodes.find((node) => node.id === nodeId))
      .filter((node): node is BoardWorkflowNode => isFrontFaceIdentityReference(node));
    if (connectedFrontFaces.length > 1) {
      setError(`当前连接了 ${connectedFrontFaces.length} 张人脸正面图。请只保留 1 张，再创建批次。`);
      return;
    }
    const faceNode = connectedFrontFaces[0];
    const replacementMode = faceNode ? "product_and_face" : "product_only";
    setBusy("detailBatchCreate");
    setError("");
    try {
      const fileDimensions = await Promise.all(detailBatchFiles.map(readImageFileDimensions));
      const outputSizes = fileDimensions.map(({ width, height }) => detailImageOutputSizeForSource(width, height));
      const uploaded: BoardWorkflowNode[] = [];
      for (let index = 0; index < detailBatchFiles.length; index += 1) {
        const file = detailBatchFiles[index];
        const node = await uploadBoardFile(
          file,
          DETAIL_IMAGE_REFERENCE_ROLE,
          `详情图 ${String(index + 1).padStart(2, "0")}`,
          faceNode
            ? "详情图换装批次输入：保留该图发型、身材、动作、表情、构图、背景和画幅，仅替换原商品与人物面部身份。"
            : "详情图换装批次输入：保留该图模特、构图、背景和画幅，仅替换原商品。",
          420 + (index % 3) * 300,
          1120 + Math.floor(index / 3) * 120,
        );
        // uploadBoardFile owns the generic busy state; restore the batch lock before the next file.
        setBusy("detailBatchCreate");
        if (!node) throw new Error(`详情图 ${index + 1} 上传失败。`);
        uploaded.push(node);
      }
      const now = new Date().toISOString();
      const batchId = crypto.randomUUID();
      const batchNode = createNode({
        kind: "note",
        title: detailBatchTitle.trim() || `详情图换装批次 · ${new Date().toLocaleDateString("zh-CN")}`,
        description: `共 ${uploaded.length} 张详情图，按上传顺序逐张${faceNode ? "换装并替换人脸" : "换装"}。`,
        text: "详情图换装批次",
        meta: {
          assetRole: DETAIL_IMAGE_BATCH_ROLE,
          detailImageBatch: {
            id: batchId,
            title: detailBatchTitle.trim() || `详情图换装批次 · ${new Date().toLocaleDateString("zh-CN")}`,
            version: DETAIL_IMAGE_BATCH_VERSION,
            productNodeId: productNode.id,
            replacementMode,
            ...(faceNode ? { faceNodeId: faceNode.id } : {}),
            executorNodeId,
            itemNodeIds: uploaded.map((node) => node.id),
            items: uploaded.map((node, index) => ({
              id: crypto.randomUUID(),
              index,
              nodeId: node.id,
              originalName: detailBatchFiles[index]?.name || `详情图 ${index + 1}`,
              sourceWidth: fileDimensions[index].width,
              sourceHeight: fileDimensions[index].height,
              outputAspectRatio: outputSizes[index].aspectRatio,
              outputWidth: outputSizes[index].width,
              outputHeight: outputSizes[index].height,
              status: "queued",
            } satisfies DetailImageBatchItem)),
            status: "draft",
            stopOnError: true,
            createdAt: now,
            updatedAt: now,
          } satisfies DetailImageBatch,
        },
        x: Math.max(80, (nodes.find((node) => node.id === executorNodeId)?.x || 900) - 20),
        y: Math.max(80, (nodes.find((node) => node.id === executorNodeId)?.y || 360) + 360),
      });
      const baseWorkflow = workflow;
      if (!baseWorkflow) throw new Error("画板状态已失效，请刷新后重试。");
      const existingEdges = baseWorkflow.edges;
      const edgeExists = (from: string, to: string) => existingEdges.some((edge) => edge.from === from && edge.to === to && MANUAL_EDGE_LABELS.has(edge.label || ""));
      const nextEdges = [
        ...existingEdges,
        ...(edgeExists(productNode.id, executorNodeId) ? [] : [createEdge(productNode.id, executorNodeId, MANUAL_EDGE_LABEL)]),
        createEdge(batchNode.id, executorNodeId, MANUAL_EDGE_LABEL),
      ];
      const nextNodes = [...baseWorkflow.nodes.filter((node) => !uploaded.some((item) => item.id === node.id)), ...uploaded, batchNode];
      const saved = await saveBoard(nextNodes, nextEdges);
      if (!saved) throw new Error("批次已创建，但画板保存失败。");
      setDetailBatchTitle("");
      setDetailBatchFiles([]);
      setDetailBatchProductNodeId(productNode.id);
      setSelectedDetailBatchId(batchId);
      setImagePipelineMode("batch");
      if (detailBatchFileInputRef.current) detailBatchFileInputRef.current.value = "";
      setBoardNotice(`已创建并连接批次“${batchNode.title}”，共 ${uploaded.length} 张详情图；已锁定为${faceNode ? `“换衣＋换脸”（${displayTitle(faceNode)}）` : "“仅换衣”"}。`);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "创建详情图批次失败");
    } finally {
      setBusy("");
    }
  }

  async function executeDetailImageBatch(executorNodeId: string, batchId: string) {
    if (!requireImageChannel()) return;
    const batchEntry = detailImageBatchNodes(nodes).find(({ batch }) => batch.id === batchId);
    if (!batchEntry) {
      setError("详情图批次不存在，请刷新画板后重试。");
      return;
    }
    const { node: batchNode, batch } = batchEntry;
    const productNode = nodes.find((item) => item.id === batch.productNodeId);
    if (!productNode?.publicUrl) {
      setError("该批次绑定的产品白底图不可用。");
      return;
    }
    const replacementMode = detailImageBatchReplacementMode(batch);
    const faceNode = replacementMode === "product_and_face"
      ? nodes.find((item) => item.id === batch.faceNodeId)
      : undefined;
    if (replacementMode === "product_and_face" && (!faceNode?.publicUrl || !isFrontFaceIdentityReference(faceNode))) {
      setError("该批次锁定的人脸正面图不可用或类型已失效，批次已暂停。");
      return;
    }
    for (const item of batch.items) {
      if (item.status === "done") continue;
      const detailNode = nodes.find((node) => node.id === item.nodeId);
      if (!detailNode?.publicUrl) {
        setError(`详情图 ${item.index + 1} 不可用，批次已暂停。`);
        break;
      }
      const outputSize = detailImageBatchItemOutputSize(item);
      const outputPosition = generatedOutputPosition({
        nodes,
        anchor: nodes.find((node) => node.id === executorNodeId),
        outputKind: "image_asset",
        outputRole: "detail_product_replacement",
      });
      const result = await executeNodeAction(executorNodeId, "image_task", {
        provider: "openai-seedance",
        channel: selectedImageChannel,
        endpointPath: selectedImageChannel?.endpointPath,
        referenceNodeIds: [productNode.id, ...(faceNode ? [faceNode.id] : []), detailNode.id],
        detailBatchNodeId: batchNode.id,
        detailBatchItemIndex: item.index,
        assetRole: "detail_product_replacement",
        x: outputPosition.x,
        y: outputPosition.y,
        aspectRatio: outputSize.aspectRatio,
        width: outputSize.width,
        height: outputSize.height,
      }, `detailBatch:${batch.id}:${item.index}`, "详情图换装失败", `详情图换装 ${item.index + 1}`);
      if (!result) break;
    }
  }

  async function chooseVideoSaveLocation() {
    setIsChoosingVideoSaveLocation(true);
    setVideoSaveLocationStatus("");
    try {
      const location = await chooseBoardVideoSaveLocation(id);
      setVideoSaveLocation(location);
      setVideoSaveLocationStatus(`已选择“${location.directoryName}”。之后完成的视频会自动保存到此文件夹。`);
    } catch (errorValue) {
      if (errorValue instanceof DOMException && errorValue.name === "AbortError") return;
      setVideoSaveLocationStatus(errorValue instanceof Error ? errorValue.message : "选择文件夹失败。");
    } finally {
      setIsChoosingVideoSaveLocation(false);
    }
  }

  async function resetVideoSaveLocation() {
    setVideoSaveLocationStatus("");
    try {
      await clearBoardVideoSaveLocation(id);
      setVideoSaveLocation(null);
      setVideoSaveLocationStatus("已恢复画板默认归档目录。后续视频不再复制到自选文件夹。");
    } catch (errorValue) {
      setVideoSaveLocationStatus(errorValue instanceof Error ? errorValue.message : "恢复默认目录失败。");
    }
  }

  async function syncExistingVideoOutputs() {
    const candidates = (workflow?.nodes ?? []).filter(isBoardVideoSaveCandidate);
    if (!candidates.length) {
      setVideoSaveLocationStatus("当前画板没有可同步的已完成视频。");
      return;
    }
    setVideoSaveLocationStatus("");
    try {
      const saved = await synchronizeVideoOutputs(candidates, true);
      if (!saved.length) {
        setVideoSaveLocationStatus("这些视频正在同步中，请稍后再试。");
        return;
      }
      setVideoSaveLocationStatus(`已确认保存 ${saved.length} 个视频到“${videoSaveLocation?.directoryName || "所选文件夹"}”。`);
    } catch (errorValue) {
      setVideoSaveLocationStatus(errorValue instanceof Error ? errorValue.message : "同步视频失败。");
    }
  }

  async function executeDirectVideoReplacementTask(nodeId: string) {
    if (!selectedVideoChannel) {
      setError("请先在视频模型池中选择已配置的视频通道。");
      return;
    }
    const resolution = directVideoReplacementResolution(nodeId);
    const profile = getBoardVideoProfile({ ...selectedVideoChannel, resolution });
    if (!profile?.directVideoReplacement) {
      setError("当前通道没有配置直接参考视频替换能力。");
      return;
    }
    const selection = directVideoReplacementSelection(nodeId);
    const audioNodeId = directVideoReplacementAudioNodeId(nodeId);
    const generationSeconds = directVideoReplacementGenerationSeconds(nodeId);
    if (!profile.durationOptions.includes(generationSeconds)) {
      setError("请先选择当前视频通道已声明支持的生成时长。");
      return;
    }
    if (selection.error) {
      setError(selection.error);
      return;
    }
    const clientTask = beginClientTask(
      nodeId,
      "video",
      "生成参考视频替换成片",
      [...selection.selectedIds, ...(audioNodeId ? [audioNodeId] : [])],
    );
    if (!clientTask) return;
    const outputPosition = generatedOutputPosition({
      nodes,
      anchor: nodes.find((node) => node.id === nodeId),
      outputKind: "video_clip",
      outputRole: "composed_video",
      outputSlot: "video_final",
    });
    try {
      const res = await fetch(`/api/board-workflows/${id}/video-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({
          mode: "direct_video_replacement",
          executorNodeId: nodeId,
          clientTaskId: clientTask.clientTaskId,
          channel: { id: selectedVideoChannel.id },
          referenceNodeIds: selection.selectedIds,
          audioNodeId,
          generationSeconds,
          resolution,
          resultTitle: "参考视频替换成片",
          resultDescription: "按参考视频的动作、镜头与时序生成，并替换商品、人脸、人物和场景。",
          x: outputPosition.x,
          y: outputPosition.y,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.workflow) adoptWorkflow(data.workflow);
      if (!res.ok && !(data.pending && data.taskId)) {
        throw new Error(data.error || "视频替换任务提交失败");
      }
      if (!data.pending || !data.taskId) {
        throw new Error("视频接口没有返回可轮询的远端任务 ID。");
      }
      await pollVideoTaskUntilTerminal(
        nodeId,
        String(data.taskId),
        clientTask.controller.signal,
        profile.protocol === "lingganya" ? 30_000 : 3_000,
      );
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err instanceof Error ? err.message : "视频替换生成失败");
        await syncWorkflowAfterTaskError();
      }
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function executeVideoTask(nodeId: string, segment?: VideoSegmentPlan) {
    if (!selectedVideoChannel) {
      setError("请先在视频模型池中选择已配置的视频通道。");
      return;
    }
    const selectedProfile = getBoardVideoProfile(selectedVideoChannel);
    if (!selectedProfile) {
      setError("当前视频通道没有画板协议配置。");
      return;
    }
    if (!segment) {
      setError("请选择一个按成片总时长自动规划的视频任务。");
      return;
    }
    const inputs = videoInputsForExecutor(nodeId);
    if (!inputs.director) {
      setError("请手动连线且仅连线 1 个完整视频导演稿到当前视频节点。");
      return;
    }
    if (
      Number(inputs.director.meta?.directorSchemaVersion || 0) !== VIDEO_DIRECTOR_SCHEMA_VERSION
      || Number(inputs.director.meta?.targetDuration || 0) !== segment.requestedTotal
      || String(inputs.director.meta?.videoChannelId || "") !== selectedVideoChannel.id
      || String(inputs.director.meta?.videoModel || "") !== selectedProfile.model
      || Number(inputs.director.meta?.videoGenerationSeconds || 0) !== selectedProfile.generationSeconds
      || String(inputs.director.meta?.videoCapabilitySignature || "") !== selectedProfile.capabilitySignature
    ) {
      setError("当前完整视频导演稿不是按所选模型和成片时长生成的，请先重新生成完整导演稿。");
      return;
    }
    const referenceSelection = taskReferenceSelectionForSegment(nodeId, segment);
    if (referenceSelection.error || referenceSelection.selected.length !== selectedProfile.referenceImageCount) {
      setError(referenceSelection.error || `当前模型需要 ${selectedProfile.referenceImageCount} 张上传参考图。`);
      return;
    }
    const directorPrompt = directorPromptTextForNode(inputs.director, segment);
    if (!directorPrompt) {
      setError("当前导演稿没有覆盖该视频任务，请重新生成完整稿。");
      return;
    }
    const clientTask = beginClientTask(nodeId, "video", `生成视频任务 ${segment.index}`, referenceSelection.selectedIds);
    if (!clientTask) return;
    const outputPosition = generatedOutputPosition({
      nodes,
      anchor: nodes.find((node) => node.id === nodeId),
      outputKind: "video_clip",
      outputRole: videoSegments.length === 1 ? "composed_video" : "generated_video",
      outputSlot: videoSegments.length === 1 ? "video_final" : "video_segment",
      segmentIndex: segment.index,
    });
    try {
      const res = await fetch(`/api/board-workflows/${id}/video-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: clientTask.controller.signal,
        body: JSON.stringify({
          executorNodeId: nodeId,
          clientTaskId: clientTask.clientTaskId,
          channel: { id: selectedVideoChannel.id },
          referenceNodeIds: referenceSelection.selectedIds,
          segmentIndex: segment.index,
          resultTitle: `节点分段视频 ${segment.index}/${videoSegments.length}`,
          resultDescription: `任务 ${segment.index}/${videoSegments.length}，参考 ${segment.sourceTimeRange}，输出 ${segment.outputTimeRange}，完整保留 ${segment.outputDuration} 秒。`,
          x: outputPosition.x,
          y: outputPosition.y,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.workflow) adoptWorkflow(data.workflow);
      if (!res.ok && !(data.pending && data.taskId)) {
        throw new Error(data.error || "视频任务提交失败");
      }
      if (!data.pending || !data.taskId) {
        throw new Error("视频接口没有返回可轮询的远端任务 ID。");
      }
      await pollVideoTaskUntilTerminal(
        nodeId,
        String(data.taskId),
        clientTask.controller.signal,
        selectedProfile.protocol === "lingganya" ? 30_000 : 3_000,
      );
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err instanceof Error ? err.message : "视频生成失败");
        await syncWorkflowAfterTaskError();
      }
    } finally {
      endClientTask(clientTask.token);
    }
  }

  async function pollVideoTaskUntilTerminal(
    nodeId: string,
    taskId: string,
    signal: AbortSignal,
    initialDelayMs = 3_000,
  ) {
    const pollingKey = taskId || `${id}:${nodeId}`;
    if (!nodeId || videoPollingOwnersRef.current.has(pollingKey)) return;
    const pollOwner = Symbol(pollingKey);
    videoPollingOwnersRef.current.set(pollingKey, pollOwner);
    let delayMs = initialDelayMs;
    const fixedThirtySecondPolling = initialDelayMs >= 30_000;
    let networkFailures = 0;
    try {
      while (!signal.aborted) {
        await abortableDelay(delayMs, signal);
        let res: Response;
        try {
          res = await fetch(`/api/board-workflows/${id}/video-generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal,
            body: JSON.stringify({ action: "poll", executorNodeId: nodeId }),
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          networkFailures += 1;
          if (networkFailures <= 5) {
            delayMs = fixedThirtySecondPolling ? 30_000 : Math.min(5_000, delayMs + 500);
            continue;
          }
          throw error;
        }
        const data = await res.json().catch(() => ({}));
        if (data.workflow) adoptWorkflow(data.workflow);
        if (!res.ok) throw new Error(data.error || "查询视频任务失败");
        networkFailures = 0;
        if (data.cancelled) return;
        if (data.outputMismatch) {
          setBoardNotice("回传视频已保存到本地并写入画板，规格不符，不能参与合成。");
          return;
        }
        if (!data.pending) {
          setBoardNotice("视频已保存到本地并同步到画板。");
          return;
        }
        delayMs = fixedThirtySecondPolling ? 30_000 : Math.min(5_000, delayMs + 500);
      }
    } finally {
      if (videoPollingOwnersRef.current.get(pollingKey) === pollOwner) {
        videoPollingOwnersRef.current.delete(pollingKey);
      }
    }
  }

  useEffect(() => {
    const activeNode = workflow?.nodes.find((node) => {
      const job = node.execution?.videoJob;
      const remoteTaskId = boardVideoRemoteTaskId(job);
      const jobChannel = videoChannels.find((channel) => channel.id === job?.channelId);
      const recoverableTransientPollFailure = job?.status === "failed"
        && /^(?:terminated|request aborted|socket closed|client disconnected)$/i.test(String(job.lastError || node.execution?.error || "").trim());
      const recoverableLingganyaStatusError = getBoardVideoProfile(jobChannel)?.protocol === "lingganya"
        && job?.status === "failed"
        && /HTTP\s*403[\s\S]*This token has no access to model/i.test(String(job.lastError || node.execution?.error || ""));
      const recoverableOutputMismatch = job?.status === "failed"
        && job.outputValidation?.valid === false
        && Boolean(job.outputValidation?.diagnosticFilePath)
        && !isBoardOutputRecoverySuppressed(
          workflow,
          "video_output_mismatch",
          job.taskId,
          node.id,
        )
        && !workflow?.nodes.some((item) =>
          String(item.meta?.taskId || "") === job.taskId
            && String(item.meta?.assetRole || "") === "video_output_mismatch"
            && Boolean(item.filePath),
        );
      return controlRoleOf(node) === "video_generate"
        && Boolean(remoteTaskId)
        && (
          node.execution?.status === "running"
          || node.status === "running"
          || recoverableTransientPollFailure
          || recoverableLingganyaStatusError
          || recoverableOutputMismatch
        ) && (
          ["submitted", "queued", "running", "completed_pending_content", "failed"].includes(String(job?.status || ""))
        );
    });
    const taskId = boardVideoRemoteTaskId(activeNode?.execution?.videoJob);
    const activeJob = activeNode?.execution?.videoJob;
    const activeJobChannel = videoChannels.find((channel) => channel.id === activeJob?.channelId);
    const activeJobProfile = getBoardVideoProfile(activeJobChannel);
    // The saved channel owns the task protocol. Do not guess from a model name
    // while the channel list is still loading or if the channel was removed.
    if (
      !activeNode
      || !taskId
      || videoPollingOwnersRef.current.has(taskId)
      || videoRecoveryControllersRef.current.has(taskId)
    ) return;
    // Recovery polling is read-only coordination and must not be blocked by a
    // different visual task currently occupying the page's busy indicator.
    const controller = new AbortController();
    videoRecoveryControllersRef.current.set(taskId, controller);
    void pollVideoTaskUntilTerminal(
      activeNode.id,
      taskId,
      controller.signal,
      activeJobProfile ? initialVideoRecoveryDelayMs(activeJob, activeJobProfile.protocol) : 30_000,
    )
      .catch((err) => {
        if (!isAbortError(err)) setError(err instanceof Error ? err.message : "恢复视频任务失败");
      })
      .finally(() => {
        if (videoRecoveryControllersRef.current.get(taskId) === controller) {
          videoRecoveryControllersRef.current.delete(taskId);
        }
      });
    // Workflow state is the recovery trigger; these local helpers intentionally use this render's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow, id, videoChannels]);


  function renderControlNodeContent(node: BoardWorkflowNode) {
    if (node.kind !== "control") return null;
    const role = controlRoleOf(node);
    const cancelTask = renderCancelTask(node.id);
    const directInputNodes = manualDirectInputIds(node.id)
      .map((nodeId) => nodes.find((item) => item.id === nodeId))
      .filter((item): item is BoardWorkflowNode => Boolean(item));
    const inputHealth = controlInputHealth(
      node,
      directInputNodes,
      selectedVideoChannel,
      sourceVideoNode ? Boolean(sourceVideoNode.meta?.hasAudio) : undefined,
    );
    const inputsReady = inputHealth.missing.length === 0 && inputHealth.invalid.length === 0;
    if (role === "input_assets") {
      const usesNewVideo = Boolean(sourceFile || sourceVideoPath.trim());
      const sourceAudioKnownMissing = !usesNewVideo && sourceVideoNode?.meta?.hasAudio === false;
      const canUseVideo = usesNewVideo || Boolean(sourceVideoNode);
      const currentVideoDuration = Number(sourceVideoNode?.meta?.durationSeconds || 0);
      const currentVideoDimensions = sourceVideoNode
        ? `${sourceVideoNode.meta?.width || "-"}×${sourceVideoNode.meta?.height || "-"}`
        : "";
      const hasAutomaticAudio = nodes.some((item) => item.kind === "audio" && roleOf(item) === "audio_evidence");
      const productGroup = resolveCurrentProductGroup(node, nodes);
      const activeProductGroupId = productGroup.groupId || draftProductGroupId;
      const availableProductNodes = productReferenceNodes.filter((item) => !productGroup.nodeIds.includes(item.id));
      return (
        <div data-luma-input-assets className="space-y-3.5">
          {cancelTask}
          <section className="space-y-2.5 rounded-xl border border-cyan-100/18 bg-slate-950/45 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-cyan-50">① 当前参考视频</p>
                <p className="text-[10px] text-slate-300/75">后续抽帧、预览和剥离音频都使用这里显示的视频</p>
              </div>
              <Badge variant="secondary" className="text-[10px]">{canUseVideo ? "已选择" : "未选择"}</Badge>
            </div>
            {sourceFile || sourceVideoPath.trim() ? (
              <div className="rounded-lg border border-cyan-200/20 bg-cyan-300/[0.06] p-2 text-[11px] text-slate-100">
                <p className="font-medium">已选待处理视频：{sourceFile?.name || sourceVideoPath.trim()}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-slate-300">点击“生成视频证据”或“剥离完整音频”时，都会处理这条视频；处理完成后自动保存为当前参考视频。</p>
              </div>
            ) : sourceVideoNode ? (
              <div className="rounded-lg border border-white/10 bg-black/20 p-2 text-[11px] text-slate-100">
                <p className="font-medium">当前视频：{workflow?.sourceVideoName || sourceVideoNode.title || "参考视频"}</p>
                <p className="mt-0.5 text-[10px] text-slate-300">
                  {currentVideoDuration > 0 ? `${currentVideoDuration.toFixed(2)} 秒 · ` : ""}{currentVideoDimensions} · {sourceVideoNode.meta?.hasAudio === false ? "无音轨" : "有音轨"}
                </p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-white/12 bg-black/15 p-2 text-[10px] text-slate-400">请选择一条参考视频。</p>
            )}
            <Input
              ref={sourceFileInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setSourceFile(event.target.files?.[0] || null);
                if (event.target.files?.[0]) setSourceVideoPath("");
              }}
            />
            <details className="rounded-lg border border-white/[0.08] bg-black/15 px-2.5 py-2 text-[10px] text-slate-300">
              <summary className="cursor-pointer select-none font-medium">高级方式：填写本地视频路径</summary>
              <Input className="mt-2" placeholder="D:\\素材\\参考视频.mp4" value={sourceVideoPath} onChange={(event) => {
                setSourceVideoPath(event.target.value);
                if (event.target.value.trim()) {
                  setSourceFile(null);
                  if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
                }
              }} />
            </details>
            {usesNewVideo ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full text-[10px]" onClick={() => {
                setSourceFile(null);
                setSourceVideoPath("");
                if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
              }}>
                清除待处理文件
              </Button>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button className="h-auto min-h-10 whitespace-normal text-xs" onClick={() => executeUploadVideo(node.id)} disabled={Boolean(busy) || !canUseVideo}>
                {busy === "uploadVideo" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuFileVideo className="mr-1.5 h-4 w-4" />}
                生成视频证据
              </Button>
              <Button
                className="h-auto min-h-10 whitespace-normal text-xs"
                variant="outline"
                onClick={() => void executeExtractAudio(node.id, sourceVideoNode?.id || "")}
                disabled={Boolean(busy) || !canUseVideo || sourceAudioKnownMissing}
              >
                {busy === "extractAudio" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuFile className="mr-1.5 h-4 w-4" />}
                {hasAutomaticAudio ? "重新剥离音频" : "剥离完整音频"}
              </Button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-300/75">
              {sourceAudioKnownMissing
                ? "当前参考视频不含音轨；仍可生成故事板和动作补证。"
                : `视频证据包含每 ${storyboardInterval} 秒总览与 ${ACTION_DETAIL_INTERVAL_SECONDS} 秒动作补证；音频处理不重复抽帧。`}
            </p>
          </section>

          <section className="space-y-2.5 rounded-xl border border-cyan-100/18 bg-slate-950/45 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-cyan-50">② 当前商品组</p>
                <p className="text-[10px] text-slate-300/75">证据板只使用下方明确列出的图片，不扫描全画板</p>
              </div>
              <Badge variant="secondary" className="text-[10px]">{productGroup.products.length}/4</Badge>
            </div>
            {productGroup.products.length ? (
              <div className="space-y-1.5">
                {productGroup.products.map((product, index) => (
                  <div key={product.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-2 text-[10px]">
                    <span className="min-w-0 truncate text-slate-100">{index + 1}. {product.title || "商品图"}</span>
                    <button type="button" className="shrink-0 rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" aria-label={`从当前商品组移除${product.title || "商品图"}`} onClick={() => saveProductGroup(node.id, activeProductGroupId, productGroup.nodeIds.filter((id) => id !== product.id))}>
                      <LuX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-white/12 bg-black/15 p-2 text-[10px] text-slate-400">当前组为空。上传新商品图，或从画板现有商品图中添加。</p>
            )}
            <div data-luma-asset-upload-grid className="grid grid-cols-2 gap-2">
            <AssetUploadButton
              label="上传正面图"
              busy={busy === "upload:product_image"}
              onFile={(file) => uploadImageAsset(file, "product_image", "商品正面图", node.x + 360, node.y, node.id, activeProductGroupId)}
            />
            <AssetUploadButton
              label="上传背面图"
              busy={busy === "upload:product_image"}
              onFile={(file) => uploadImageAsset(file, "product_image", "商品背面图", node.x + 660, node.y, node.id, activeProductGroupId)}
            />
            <AssetUploadButton
              label="上传侧面图"
              busy={busy === "upload:product_image"}
              onFile={(file) => uploadImageAsset(file, "product_image", "商品侧面图", node.x + 660, node.y + 120, node.id, activeProductGroupId)}
            />
            <AssetUploadButton
              label="上传细节图"
              busy={busy === "upload:product_image"}
              onFile={(file) => uploadImageAsset(file, "product_image", "商品细节图", node.x + 660, node.y + 240, node.id, activeProductGroupId)}
            />
            </div>
            {availableProductNodes.length ? (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <select value={productGroupCandidateId} onChange={(event) => setProductGroupCandidateId(event.target.value)} className="h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-[10px] outline-none" aria-label="从画板现有商品图添加">
                  <option value="">从画板现有商品图添加…</option>
                  {availableProductNodes.map((item) => <option key={item.id} value={item.id}>{item.title || "商品图"}</option>)}
                </select>
                <Button type="button" variant="outline" size="sm" disabled={!productGroupCandidateId || productGroup.nodeIds.length >= 4} onClick={() => {
                  saveProductGroup(node.id, activeProductGroupId, [...productGroup.nodeIds, productGroupCandidateId]);
                  setProductGroupCandidateId("");
                }}>添加</Button>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void createProductEvidenceBoard(node.id, productGroup.products, productGroup.groupId)}
              disabled={Boolean(busy) || productGroup.products.length < 2 || !productGroup.groupId}
            >
              {busy === "product-evidence-board" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuLayers className="mr-1.5 h-4 w-4" />}
              生成多视图证据板
            </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => {
                const nextGroupId = crypto.randomUUID();
                setDraftProductGroupId(nextGroupId);
                setProductGroupCandidateId("");
                saveProductGroup(node.id, nextGroupId, []);
              }}>开始新商品组</Button>
            </div>
            <p className="text-[10px] text-slate-300/75">商品组调整只改变本次选择，不删除画板里的原商品图片。</p>
          </section>

          <section className="space-y-2.5 rounded-xl border border-cyan-100/18 bg-slate-950/45 p-3" data-luma-person-identity-reference>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-cyan-50">③ 人物身份（可选）</p>
                <p className="text-[10px] text-slate-300/75">选择一种来源；上传后仍需手动连线才会发送</p>
              </div>
              <Badge variant="secondary" className="text-[10px]">{identityReferenceNodes.length} 项</Badge>
            </div>
            <div className="grid grid-cols-2 rounded-lg border border-white/[0.08] bg-black/20 p-1">
              <button type="button" className={cn("rounded-md px-2 py-1.5 text-[10px]", identitySourceMode === "pack" ? "bg-cyan-300/15 text-cyan-50" : "text-slate-400")} onClick={() => setIdentitySourceMode("pack")}>从人物包选择</button>
              <button type="button" className={cn("rounded-md px-2 py-1.5 text-[10px]", identitySourceMode === "upload" ? "bg-cyan-300/15 text-cyan-50" : "text-slate-400")} onClick={() => setIdentitySourceMode("upload")}>本次上传</button>
            </div>
            {identitySourceMode === "pack" ? renderIdentityPackImportControls(node.x + 360, node.y + 360, node.id) : (
              <div className="space-y-2">
                <AssetUploadButton
                  label="上传人脸正面图（可用于换脸）"
                  busy={busy === "upload:face_front"}
                  onFile={(file) => uploadImageAsset(file, "face_front", "人脸正面 · 本次上传", node.x + 360, node.y + 180, node.id)}
                />
                <AssetUploadButton
                  label="上传其他人物身份参考"
                  busy={busy === "upload:identity_image"}
                  onFile={(file) => uploadImageAsset(file, "identity_image", "人物身份参考 · 本次上传", node.x + 360, node.y + 300, node.id)}
                />
                <p className="text-[10px] leading-4 text-slate-400">只有“人脸正面图”连到 image-2 时，详情图批次才会启用换脸。</p>
              </div>
            )}
          </section>

          <details className="rounded-xl border border-white/[0.08] bg-slate-950/35 px-3 py-2.5 text-[10px] text-slate-300">
            <summary className="cursor-pointer select-none font-semibold text-slate-100">④ 其他素材（可选）</summary>
            <p className="my-2 leading-relaxed text-slate-400">仅存入画板，不自动抽帧、不自动归类，也不会自动发送给模型。</p>
            <AssetUploadButton
              label="上传其他图片或视频"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
              icon="file"
              busy={busy === "upload:local_image_asset" || busy === "upload:local_video_asset"}
              onFile={(file) => uploadLocalMedia(file, node.x + 760, node.y + 90, node.id)}
            />
          </details>
        </div>
      );
    }
    if (role === "select_frame") {
      return sourceVideoNode?.publicUrl ? (
        <div className="space-y-2">
          {cancelTask}
          <video
            ref={videoRef}
            src={sourceVideoNode.publicUrl}
            className="max-h-64 w-full rounded-2xl bg-black object-contain"
            controls
            onTimeUpdate={(event) => setCaptureTime(event.currentTarget.currentTime)}
          />
          {renderFrameSeekControls(() => executeCaptureFrame(node.id), "截图", !inputsReady)}
        </div>
      ) : (
        <p className="rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">请先选择并处理一条参考视频。</p>
      );
    }
    if (role === "gpt_analyze") {
      return (
        <div className="space-y-2">
          {cancelTask}
          <p className="text-xs font-medium text-muted-foreground">本次补充拆解要求（可选）</p>
          <Textarea
            className="min-h-24"
            value={analysisFocus}
            onChange={(event) => setAnalysisFocus(event.target.value)}
            maxLength={ANALYSIS_FOCUS_MAX_CHARS}
            placeholder="可选：补充本次参考视频的关注点，例如“重点分析前 5 秒钩子”。留空则按固定拆解规则执行。"
          />
          <div className="rounded-xl bg-muted/40 p-2 text-[11px] text-muted-foreground">
            LLM：{llm.model || "未配置"}
          </div>
          <CapabilityNote
            title="LLM 输入/输出"
            items={GPT_ANALYZE_CAPABILITY_ITEMS}
          />
          <Button
            className="w-full brand-gradient text-white"
            onClick={() => executeAnalyze(node.id)}
            disabled={Boolean(busy) || !inputsReady}
            aria-busy={busy === "analyze"}
          >
            {busy === "analyze" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuSparkles className="mr-1.5 h-4 w-4" />}
            {busy === "analyze" ? "正在拆解参考视频…" : "1. 重新拆解参考视频"}
          </Button>
        </div>
      );
    }
    if (role === "gpt_director") {
      const analysisNode = manualDirectInputIds(node.id)
        .map((nodeId) => nodes.find((item) => item.id === nodeId))
        .filter((item): item is BoardWorkflowNode => Boolean(item))
        .find((item) => roleOf(item) === "reference_method_analysis") ?? null;
      const referenceEvidenceDuration = referenceEvidenceDurationForAnalysis(nodes, analysisNode);
      const effectiveDurationSource = directorDurationSource === "reference_video" && referenceEvidenceDuration === null
        ? "manual"
        : directorDurationSource;
      const plannedDuration = effectiveDurationSource === "reference_video" && referenceEvidenceDuration !== null
        ? Math.min(120, Math.max(1, referenceTargetDurationSeconds(referenceEvidenceDuration)))
        : Math.min(120, Math.max(1, Math.round(targetVideoDuration || 20)));
      const sceneCuts = Array.isArray(analysisNode?.meta?.sceneCutTimes)
        ? analysisNode.meta.sceneCutTimes.map(Number).filter((time) => Number.isFinite(time) && time > 0)
        : [];
      const plannedSegments = splitTargetDurationIntoVideoSegments(
        plannedDuration,
        directorDurationProfile?.generationSeconds,
        sceneCuts,
        effectiveDurationSource === "reference_video" ? referenceEvidenceDuration || undefined : undefined,
      );
      return (
        <div className="space-y-2">
          {cancelTask}
          <ModelSelect
            label="本次生成视频模型"
            value={selectedVideoChannelId}
            onChange={setSelectedVideoChannelId}
            empty="未配置可用视频模型"
            items={videoChannels.map((channel) => ({ id: channel.id, label: `${channel.name} · ${channel.model}` }))}
          />
          <section className="overflow-hidden rounded-xl border border-cyan-100/22 bg-[linear-gradient(135deg,rgba(8,52,68,0.78),rgba(7,24,40,0.78))] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_26px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <div className="flex items-center justify-between gap-2 border-b border-cyan-100/16 px-3 py-2">
              <div>
                <p className="text-xs font-semibold">本次成片时长</p>
                <p className="mt-0.5 text-[10px] text-slate-300/75">先定总时长，再按模型能力自动拆段</p>
              </div>
              <span className="rounded-full border border-cyan-100/25 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-50">自动规划</span>
            </div>
            <div className="space-y-2.5 p-3">
              <div className="grid grid-cols-2 rounded-lg border border-white/[0.06] bg-black/20 p-1">
                <button
                  type="button"
                  className={cn(
                    "min-w-0 rounded-md px-2 py-1.5 text-left transition",
                    effectiveDurationSource === "reference_video"
                      ? "bg-cyan-300/14 text-cyan-50 shadow-sm ring-1 ring-cyan-200/45"
                      : "text-slate-300/80 hover:bg-white/[0.05] hover:text-slate-100",
                  )}
                  disabled={referenceEvidenceDuration === null}
                  onClick={() => setDirectorDurationSource("reference_video")}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                    {effectiveDurationSource === "reference_video" && <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-cyan-500 text-[9px] text-white">✓</span>}
                    跟随参考视频
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-300/65">
                    {referenceEvidenceDuration === null ? "暂无有效时长证据" : `${referenceEvidenceDuration.toFixed(1)}s → ${referenceTargetDurationSeconds(referenceEvidenceDuration)}s`}
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "min-w-0 rounded-md px-2 py-1.5 text-left transition",
                    effectiveDurationSource === "manual"
                      ? "bg-cyan-300/14 text-cyan-50 shadow-sm ring-1 ring-cyan-200/45"
                      : "text-slate-300/80 hover:bg-white/[0.05] hover:text-slate-100",
                  )}
                  onClick={() => setDirectorDurationSource("manual")}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                    {effectiveDurationSource === "manual" && <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-cyan-500 text-[9px] text-white">✓</span>}
                    人工输入
                  </span>
                  <span className="mt-0.5 block text-[10px] text-slate-300/65">输入 1–120 秒</span>
                </button>
              </div>

              {effectiveDurationSource === "manual" && (
                <label className="flex items-center justify-between gap-3 rounded-lg border border-cyan-100/16 bg-black/15 px-2.5 py-2 text-[11px] font-medium text-slate-200">
                  成片总时长
                  <span className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={120}
                      className="h-7 w-16 border-cyan-100/20 bg-black/25 px-2 text-center text-xs font-semibold text-cyan-50"
                      value={targetVideoDuration}
                      onChange={(event) => setTargetVideoDuration(Number(event.target.value || 20))}
                    />
                    <span className="text-slate-300/65">秒</span>
                  </span>
                </label>
              )}

              <div className="rounded-lg border border-cyan-100/20 bg-cyan-300/[0.08] p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold text-cyan-50">执行计划</p>
                    <p className="mt-0.5 text-[10px] text-cyan-100/70">参考证据 {plannedDuration}s · 输出 {plannedSegments[0]?.plannedOutputDuration || 0}s · 共 {plannedSegments.length} 个任务</p>
                  </div>
                  <span className="rounded-md border border-cyan-100/20 bg-cyan-300/18 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-50">{directorDurationProfile?.generationSeconds || "-"}s / 任务</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-0.5 text-[10px] text-cyan-50/90">{selectedVideoChannel?.name || "未选择通道"}</span>
                  <span className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-0.5 text-[10px] text-cyan-50/90">{directorDurationProfile?.model || "未配置模型"}</span>
                  <span className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-0.5 text-[10px] text-cyan-50/90">最多 {directorDurationProfile?.maxReferenceImages || "-"} 张参考图</span>
                  <span className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-0.5 text-[10px] text-cyan-50/90">{directorDurationProfile?.aspectRatio || "-"}</span>
                  <span className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-0.5 text-[10px] text-cyan-50/90">{directorDurationProfile?.resolution || "-"}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {plannedSegments.map((segment, index) => (
                    <span key={`${segment.duration}-${index}`} className="rounded-md border border-cyan-100/18 bg-black/15 px-1.5 py-1 text-[10px] font-medium text-slate-100">
                      任务 {index + 1}：参考 {segment.sourceDuration}s，完整输出 {segment.outputDuration}s
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">本次导演偏好（可选）</p>
            <Textarea
              className="min-h-20"
              value={directorPreference}
              onChange={(event) => setDirectorPreference(event.target.value)}
              placeholder="只写证据未决定的取舍，例如“结尾呼吸更从容”；不能改写拆解事实、商品边界、口播原文或模型时长。"
            />
          </div>
          <DirectorPromptButton
            isRunning={busy === "director"}
            hasPrompt={Boolean(videoDirectorPrompt)}
            onClick={() => {
              if (!directorDurationProfile) {
                setError("当前视频模型没有有效的单任务可用时长，请先在模型池填写该模型支持的秒数。");
                return;
              }
              if (effectiveDurationSource === "manual") setTargetVideoDuration(plannedDuration);
              void runDirector(node.id, effectiveDurationSource, plannedDuration);
            }}
            disabled={Boolean(busy) || !inputsReady || !directorDurationProfile}
            className="mt-1"
          />
        </div>
      );
    }
    if (role === "image_pipeline") {
      const linkedReferenceNodes = manualDirectInputIds(node.id)
        .map((nodeId) => nodes.find((item) => item.id === nodeId))
        .filter((item): item is BoardWorkflowNode => Boolean(item?.publicUrl));
      const linkedProductNodes = linkedReferenceNodes.filter((item) => roleOf(item) === "product_image");
      const linkedProductGroupIds = linkedProductNodes.map((item) => String(item.meta?.productGroupId || "").trim());
      const linkedProductsShareOneGroup = linkedProductNodes.length <= 1
        || (linkedProductGroupIds.every(Boolean) && new Set(linkedProductGroupIds).size === 1);
      const linkedFrontFaceNodes = linkedReferenceNodes.filter(isFrontFaceIdentityReference);
      const productWhiteBackgroundNodes = nodes.filter((item) => roleOf(item) === "product_white_background" && Boolean(item.publicUrl));
      const productWhiteBackgroundInputsReady = linkedProductNodes.length >= 1
        && linkedProductNodes.length <= 3
        && linkedReferenceNodes.length === linkedProductNodes.length
        && linkedProductsShareOneGroup;
      const detailBatches = detailImageBatchNodes(nodes);
      const selectedBatchEntry = detailBatches.find(({ batch }) => batch.id === selectedDetailBatchId) || detailBatches[0];
      const activeImagePipelineMode = imagePipelineMode;
      const selectedBatch = selectedBatchEntry?.batch;
      const selectedBatchReplacementMode = selectedBatch ? detailImageBatchReplacementMode(selectedBatch) : "product_only";
      const selectedBatchFaceNode = selectedBatchReplacementMode === "product_and_face"
        ? nodes.find((item) => item.id === selectedBatch?.faceNodeId)
        : undefined;
      const selectedBatchDone = selectedBatch?.items.filter((item) => item.status === "done").length || 0;
      const selectedBatchRunning = selectedBatch?.items.find((item) => item.status === "running");
      const batchStatusLabel = selectedBatch?.status === "done"
        ? "已完成"
        : selectedBatch?.status === "paused"
          ? "已暂停"
          : selectedBatch?.status === "running"
            ? "生成中"
            : "待执行";
      return (
        <div className="space-y-2">
          {cancelTask}
          <ModelSelect
            label="生图模型"
            value={selectedImageChannelId}
            onChange={setSelectedImageChannelId}
            empty="未配置 image-2"
            items={imageChannels.map((channel) => ({ id: channel.id, label: channel.name || channel.model || channel.id }))}
          />
          <div role="tablist" aria-label="image-2 资产模式" className="grid grid-cols-2 rounded-xl border border-cyan-100/15 bg-black/20 p-1">
            <button
              type="button"
              role="tab"
              aria-selected={activeImagePipelineMode === "batch"}
              className={cn("flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition", activeImagePipelineMode === "batch" ? "bg-cyan-300/15 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(165,243,252,0.22)]" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}
              onClick={() => setImagePipelineMode("batch")}
            >
              <LuLayers className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">批量详情图换装</span>
              {detailBatches.length > 0 ? <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px]">{detailBatches.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeImagePipelineMode === "single"}
              className={cn("flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition", activeImagePipelineMode === "single" ? "bg-cyan-300/15 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(165,243,252,0.22)]" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}
              onClick={() => setImagePipelineMode("single")}
            >
              <LuImage className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">单图资产生成</span>
            </button>
          </div>

          {activeImagePipelineMode === "batch" ? (
            <section className="space-y-4 rounded-xl border border-cyan-100/18 bg-slate-950/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <LuLayers className="h-4 w-4 shrink-0 text-cyan-200" />
                    <p className="truncate text-sm font-semibold text-slate-100">详情图换装</p>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-slate-400">选择一张白底图，再批量处理详情图。</p>
                  <p className="mt-1 text-[10px] leading-4 text-cyan-100/65">尺寸自动判断：方图或横图输出 1:1；竖图输出 9:16。每张图单独判断，无需手动选择。</p>
                </div>
                <Badge variant="secondary" className="shrink-0 text-[10px]">{detailBatches.length} 批次</Badge>
              </div>
              <div className="rounded-lg border border-cyan-200/20 bg-cyan-300/[0.06] px-3 py-2.5">
                <p className="text-xs font-semibold text-cyan-50">输出尺寸：逐张自动判断</p>
                <p className="mt-1 text-[10px] leading-4 text-cyan-100/65">竖图输出 9:16（2160×3840）；方图或横图输出 1:1（2160×2160）。同一批次可以混合。</p>
              </div>
              <div className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-medium text-slate-300">批次名称 <span className="text-slate-500">可选</span></span>
                  <Input value={detailBatchTitle} onChange={(event) => setDetailBatchTitle(event.target.value)} placeholder="例如：春季详情图" className="h-10 bg-black/20 text-sm" />
                </label>
                <div className="space-y-1.5">
                  <span className="block text-[11px] font-medium text-slate-300">产品白底图</span>
                  {productWhiteBackgroundNodes.length > 0 ? (
                    <>
                      <LumaSelect
                        value={detailBatchProductNodeId}
                        onChange={setDetailBatchProductNodeId}
                        emptyLabel="暂无可用产品白底图"
                        ariaLabel="选择产品白底图"
                        options={productWhiteBackgroundNodes.map((item) => ({ value: item.id, label: item.title || "产品白底图" }))}
                      />
                      <p className="text-[10px] leading-4 text-slate-500">已生成 {productWhiteBackgroundNodes.length} 张，可在不同批次复用。</p>
                    </>
                  ) : (
                    <div className="space-y-2.5 rounded-lg border border-dashed border-cyan-100/20 bg-black/15 px-3 py-3">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cyan-200/20 bg-cyan-200/[0.08]">
                          <LuImage className="h-4 w-4 text-cyan-200" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <p className="text-xs font-semibold text-slate-100">还没有产品白底图</p>
                            <span className="rounded-full border border-amber-200/20 px-1.5 py-0.5 text-[10px] text-amber-100/75">待生成</span>
                          </div>
                          {linkedProductNodes.length > 0 ? (
                            <p className="mt-1 text-[11px] leading-5 text-slate-400">已连接商品图 <span className="font-semibold text-cyan-100">{linkedProductNodes.length} 张</span>，生成后即可创建批次。</p>
                          ) : (
                            <p className="mt-1 text-[11px] leading-5 text-slate-400">先在“导入素材”上传商品图，再手动连到 image-2。</p>
                          )}
                        </div>
                      </div>
                      {linkedProductNodes.length > 0 && linkedReferenceNodes.length !== linkedProductNodes.length ? (
                        <p className="rounded-md border border-amber-200/15 bg-amber-200/[0.04] px-2.5 py-2 text-[10px] leading-4 text-amber-100/80">生成白底图时只能保留商品图连线，请先移除其他参考素材。</p>
                      ) : null}
                    </div>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={productWhiteBackgroundInputsReady ? "default" : "outline"}
                    className="h-10 w-full text-xs font-semibold"
                    onClick={() => void executeImageTask("product_white_background", node.id)}
                    disabled={Boolean(busy)}
                    title={productWhiteBackgroundInputsReady
                      ? "使用当前直接连入的商品图生成产品白底图"
                      : "请先在导入素材节点上传 1–3 张商品图，并手动连到当前 image-2 节点"}
                  >
                    {busy === "product_white_background" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuSparkles className="mr-1.5 h-4 w-4" />}
                    {busy === "product_white_background"
                      ? "正在生成产品白底图"
                      : productWhiteBackgroundNodes.length > 0
                        ? "生成新的产品白底图"
                        : "生成产品白底图"}
                  </Button>
                  {!productWhiteBackgroundInputsReady ? (
                    <p className="text-[10px] leading-4 text-amber-100/75">
                      {linkedProductNodes.length === 0
                        ? "点击按钮会提示缺少的输入；先上传并连入 1–3 张商品图后即可生成。"
                        : linkedProductNodes.length > 3
                          ? `当前连入 ${linkedProductNodes.length} 张商品图，最多只保留 3 张。`
                          : !linkedProductsShareOneGroup
                            ? "当前商品图不属于同一个商品组，请只连接同一商品的正面、背面或侧面图。"
                          : "当前还连有非商品素材；移除这些连线后即可生成。"}
                    </p>
                  ) : (
                    <p className="text-[10px] leading-4 text-cyan-100/65">已就绪：将使用当前连入的 {linkedProductNodes.length} 张商品图生成。</p>
                  )}
                </div>
                <div className={cn(
                  "rounded-lg border px-3 py-2.5",
                  linkedFrontFaceNodes.length > 1
                    ? "border-amber-200/25 bg-amber-200/[0.06]"
                    : linkedFrontFaceNodes.length === 1
                      ? "border-cyan-200/25 bg-cyan-300/[0.07]"
                      : "border-white/[0.08] bg-black/15",
                )}>
                  <div className="flex items-start gap-2.5">
                    <LuGitBranch className={cn("mt-0.5 h-4 w-4 shrink-0", linkedFrontFaceNodes.length > 1 ? "text-amber-200" : "text-cyan-200")} />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-100">
                        {linkedFrontFaceNodes.length > 1
                          ? `人脸图冲突 · 已连接 ${linkedFrontFaceNodes.length} 张`
                          : linkedFrontFaceNodes.length === 1
                            ? "当前分支：换衣＋换脸"
                            : "当前分支：仅换衣"}
                      </p>
                      <p className="mt-1 break-words text-[10px] leading-4 text-slate-400">
                        {linkedFrontFaceNodes.length > 1
                          ? "请断开多余的人脸正面图，只保留本批次需要的 1 张。"
                          : linkedFrontFaceNodes.length === 1
                            ? `已连接并将在创建时锁定：${displayTitle(linkedFrontFaceNodes[0])}`
                            : "未连接人脸正面图；本批次只替换衣服或产品，保留详情图原人物。"}
                      </p>
                    </div>
                  </div>
                </div>
                <label className="flex min-h-12 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-dashed border-cyan-100/20 bg-black/20 px-3 transition hover:border-cyan-100/35 hover:bg-cyan-100/[0.05]">
                  <LuImage className="h-4 w-4 shrink-0 text-cyan-200" />
                  <span className="min-w-0 flex-1 text-sm font-medium text-slate-100">{detailBatchFiles.length > 0 ? `已选 ${detailBatchFiles.length} 张详情图` : "选择详情图"}</span>
                  <span className="shrink-0 text-[11px] text-slate-500">可多选</span>
                  <Input
                    ref={detailBatchFileInputRef}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setDetailBatchFiles(Array.from(event.target.files || []))}
                  />
                </label>
                <Button type="button" size="sm" variant="outline" className="h-10 w-full text-sm" onClick={() => void createDetailImageBatch(node.id)} disabled={Boolean(busy) || detailBatchFiles.length === 0 || !detailBatchProductNodeId || linkedFrontFaceNodes.length > 1}>
                  {busy === "detailBatchCreate" ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuLayers className="mr-1.5 h-4 w-4" />}
                  创建批次
                </Button>
              </div>
              {detailBatchFiles.length > 0 ? <p className="text-[11px] text-cyan-100/65">按选择顺序处理，已完成的图片不会重复生成。</p> : null}
              {selectedBatch ? (
                <div className="space-y-3 border-t border-cyan-100/10 pt-4">
                  <div className="flex items-center gap-2">
                    <LumaSelect
                      value={selectedBatch.id}
                      onChange={setSelectedDetailBatchId}
                      emptyLabel="暂无批次"
                      ariaLabel="选择详情图批次"
                      className="flex-1"
                      options={detailBatches.map(({ batch }) => {
                        const done = batch.items.filter((item) => item.status === "done").length;
                        return { value: batch.id, label: `${batch.title} · ${done}/${batch.items.length}` };
                      })}
                    />
                    <span className="shrink-0 rounded-full border border-cyan-100/15 px-2 py-1 text-[10px] text-cyan-100/75">{batchStatusLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                    <span>{selectedBatchDone}/{selectedBatch.items.length} 张完成{selectedBatchRunning ? ` · 正在处理第 ${selectedBatchRunning.index + 1} 张` : ""}</span>
                    <Button type="button" size="sm" className="h-7 shrink-0 px-2 text-[10px]" onClick={() => void executeDetailImageBatch(node.id, selectedBatch.id)} disabled={Boolean(busy) || selectedBatch.items.every((item) => item.status === "done")}>
                      {busy?.startsWith("detailBatch:") ? <LuLoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LuSparkles className="mr-1 h-3.5 w-3.5" />}
                      {selectedBatch.status === "paused" ? "继续生成" : "开始生成"}
                    </Button>
                  </div>
                  <p className="break-words rounded-md border border-white/[0.07] bg-black/15 px-2.5 py-2 text-[10px] leading-4 text-slate-400">
                    {selectedBatchReplacementMode === "product_and_face"
                      ? `已锁定：换衣＋换脸 · ${selectedBatchFaceNode ? displayTitle(selectedBatchFaceNode) : "人脸图不可用"}`
                      : `${selectedBatch?.version === 1 ? "旧批次" : "已锁定"}：仅换衣`}
                  </p>
                  <details className="rounded-lg border border-white/[0.07] bg-black/15 px-2 py-1.5">
                    <summary className="cursor-pointer select-none text-[10px] font-semibold text-slate-300">查看批次明细</summary>
                    <ol className="mt-1.5 space-y-1 text-[10px] text-slate-400">
                      {selectedBatch.items.map((item) => {
                        const outputSize = detailImageBatchItemOutputSize(item);
                        return <li key={item.id} className="flex items-start gap-2"><span className="w-5 shrink-0 pt-0.5 text-right text-slate-500">{String(item.index + 1).padStart(2, "0")}</span><span className="min-w-0 flex-1"><span className="block break-words text-slate-300">{item.originalName}</span><span className="block text-[9px] text-slate-500">{item.sourceWidth && item.sourceHeight ? `${item.sourceWidth}×${item.sourceHeight} → ` : "旧批次 → "}{outputSize.aspectRatio} · {outputSize.width}×{outputSize.height}</span></span><span className={cn("shrink-0 pt-0.5", item.status === "done" ? "text-emerald-200" : item.status === "failed" ? "text-rose-200" : item.status === "running" ? "text-cyan-200" : "text-slate-500")}>{item.status === "done" ? "完成" : item.status === "failed" ? "失败" : item.status === "running" ? "生成中" : "排队"}</span></li>;
                      })}
                    </ol>
                  </details>
                </div>
              ) : <p className="border-t border-cyan-100/10 pt-2.5 text-[10px] text-slate-500">创建后，批次会显示在这里并可逐项继续生成。</p>}
            </section>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <LumaSelect value={aspectRatio} onChange={setAspectRatio} emptyLabel="选择画幅" ariaLabel="生图画幅" options={[{ value: "9:16", label: "9:16 竖图" }, { value: "16:9", label: "16:9 横图" }, { value: "1:1", label: "1:1 方图" }]} />
                <div className="rounded-lg border bg-background px-2 py-2 text-sm text-muted-foreground">
                  {currentImagePresetLabel}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">当前 image-2 请求尺寸：{currentImageSizeText}</p>
              <CurrentReferencePackage nodes={linkedReferenceNodes} />
              <PendingImageRecoveryPanel
                notice={imageRecoveryNotice}
                pendingResults={pendingImageResults}
                busy={busy}
                onRetry={(pending) => void retryPendingImageResult(pending)}
              />
              <details className="rounded-xl border border-cyan-100/15 bg-black/10 px-2.5 py-2" open>
                <summary className="cursor-pointer select-none text-xs font-semibold text-slate-100">常用资产 · 4 项</summary>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">每次只读取直接连入 image-2 的图片；点击卡片展开详情，再提交生成。</p>
                <div className="mt-3 grid gap-2.5">
                  {PRIMARY_IMAGE_TASKS.map((task) => (
                    <TaskButton
                      key={task}
                      busy={busy === task}
                      expanded={expandedImageTask === task}
                      onToggle={() => setExpandedImageTask((current) => current === task ? null : task)}
                      onClick={() => executeImageTask(task, node.id)}
                      label={IMAGE_TASK_GUIDES[task].label}
                      hint={`${IMAGE_TASK_GUIDES[task].wiring} · ${IMAGE_TASK_GUIDES[task].purpose}`}
                      disabled={!inputsReady}
                    />
                  ))}
                </div>
              </details>
              <details className="rounded-xl border border-cyan-100/15 bg-black/10 px-2.5 py-2">
                <summary className="cursor-pointer select-none text-xs font-semibold text-slate-100">进阶资产 · 3 项</summary>
                <div className="mt-2 space-y-1.5">
                  <div className="grid gap-2.5">
                    {OPTIONAL_IMAGE_TASKS.filter((task) => task !== "repaired_image").map((task) => (
                      <TaskButton
                        key={task}
                        busy={busy === task}
                        expanded={expandedImageTask === task}
                        onToggle={() => setExpandedImageTask((current) => current === task ? null : task)}
                        onClick={() => executeImageTask(task, node.id)}
                        label={IMAGE_TASK_GUIDES[task].label}
                        hint={`${IMAGE_TASK_GUIDES[task].wiring} · ${IMAGE_TASK_GUIDES[task].purpose}`}
                        disabled={!inputsReady}
                      />
                    ))}
                  </div>
                  <div className="space-y-1 rounded-lg border border-white/[0.08] bg-black/15 p-2">
                    <p className="text-[10px] font-medium text-slate-300">修复细节目标</p>
                    <Textarea
                      className="min-h-16 bg-black/20 text-xs"
                      value={imageRepairInstruction}
                      onChange={(event) => setImageRepairInstruction(event.target.value)}
                      placeholder="英文填写区域 + 可见缺陷 + 目标状态"
                    />
                    <p className="text-[10px] leading-relaxed text-slate-500">未填写时服务端会拒绝修复任务，不自动猜测。</p>
                  </div>
                  {OPTIONAL_IMAGE_TASKS.filter((task) => task === "repaired_image").map((task) => (
                    <TaskButton
                      key={task}
                      busy={busy === task}
                      expanded={expandedImageTask === task}
                      onToggle={() => setExpandedImageTask((current) => current === task ? null : task)}
                      onClick={() => executeImageTask(task, node.id)}
                      label={IMAGE_TASK_GUIDES[task].label}
                      hint={`${IMAGE_TASK_GUIDES[task].wiring} · ${IMAGE_TASK_GUIDES[task].purpose}`}
                      disabled={!inputsReady}
                    />
                  ))}
                </div>
              </details>
              <details className="rounded-lg border border-white/[0.08] bg-transparent px-2.5 py-1.5">
                <summary className="cursor-pointer select-none text-[10px] font-semibold text-slate-400">查看 image-2 规则</summary>
                <ul className="mt-1.5 space-y-1 text-[10px] leading-4 text-slate-500">
                  <li>每次生成 {IMAGE_OUTPUT_LIMIT} 张新图，不覆盖旧图。</li>
                  <li>最多发送 {IMAGE_REFERENCE_LIMIT} 张直接连线参考图。</li>
                  <li>输出尺寸：{currentImagePresetLabel} · {currentImageSizeText}。</li>
                </ul>
              </details>
            </>
          )}
        </div>
      );
    }
    if (role === "video_generate") {
      const selectedProfile = getBoardVideoProfile(selectedVideoChannel);
      const isDirectVideoReplacement = Boolean(selectedProfile?.directVideoReplacement);
      const directTaskPersisted = isDirectVideoReplacement && hasPersistedDirectVideoTask(node.id);
      const directGenerationSeconds = isDirectVideoReplacement
        ? directVideoReplacementGenerationSeconds(node.id)
        : 0;
      const directDurationOptions = isDirectVideoReplacement ? (selectedProfile?.durationOptions || []) : [];
      const directDurationSummary = directDurationOptions.length > 2
        ? `${directDurationOptions[0]}–${directDurationOptions[directDurationOptions.length - 1]}`
        : directDurationOptions.join(" / ");
      const directResolution = isDirectVideoReplacement
        ? directVideoReplacementResolution(node.id)
        : null;
      return (
        <div className="space-y-2">
          {cancelTask}
          <ModelSelect
            label="视频模型"
            value={selectedVideoChannelId}
            onChange={(channelId) => saveVideoChannelSelection(node.id, channelId)}
            empty="未配置视频模型"
            items={videoChannels.map((channel) => ({ id: channel.id, label: `${channel.name} · ${channel.model}` }))}
          />
          <div className="grid grid-cols-3 gap-2">
            <div className={cn(
              "rounded-lg border px-2 py-2 text-center text-sm",
              isDirectVideoReplacement
                ? "border-cyan-100/20 bg-slate-950/65 text-cyan-50"
                : "bg-background text-muted-foreground",
              )}>
              {isDirectVideoReplacement ? (
                <label className="flex flex-col items-center gap-0.5">
                  <select
                    className="h-6 w-full cursor-pointer appearance-auto bg-transparent text-center text-sm font-medium text-cyan-50 outline-none disabled:cursor-not-allowed disabled:opacity-70"
                    value={directGenerationSeconds || ""}
                    disabled={Boolean(busy) || directTaskPersisted || !selectedProfile}
                    aria-label="直接视频替换：生成时长"
                    title="选择本次成片时长；仅显示当前视频通道已声明支持的时长"
                    style={{ colorScheme: "dark" }}
                    onChange={(event) => saveDirectVideoReplacementGenerationSeconds(node.id, Number(event.target.value))}
                  >
                    {selectedProfile?.durationOptions.map((seconds) => (
                      <option key={seconds} value={seconds} className="bg-slate-950 text-slate-100">{seconds} 秒</option>
                    ))}
                  </select>
                  <span className="text-[9px] leading-none text-cyan-100/60">可选 {directDurationSummary} 秒</span>
                </label>
              ) : videoDirectorPrompt ? `导演稿 ${Number(videoDirectorPrompt.meta?.targetDuration || 0) || "-"}s` : "生成导演稿时选择时长"}
            </div>
            <div className={cn(
              "rounded-lg border px-2 py-2 text-center text-sm",
              isDirectVideoReplacement
                ? "border-cyan-100/20 bg-slate-950/65 text-cyan-50"
                : "bg-background text-muted-foreground",
            )}>{selectedProfile?.aspectRatio || "画幅"}</div>
            <div className={cn(
              "rounded-lg border px-2 py-2 text-center text-sm",
              isDirectVideoReplacement
                ? "border-cyan-100/20 bg-slate-950/65 text-cyan-50"
                : "bg-background text-muted-foreground",
            )}>
              {isDirectVideoReplacement ? (
                <select
                  className="h-5 w-full cursor-pointer appearance-none bg-transparent text-center text-sm font-medium text-cyan-50 outline-none"
                  value={directResolution || ""}
                  disabled={Boolean(busy) || directTaskPersisted || !selectedProfile || selectedProfile.resolutionOptions.length < 2}
                  aria-label="直接视频替换：输出分辨率"
                  title="选择本次视频任务的输出分辨率；默认 720P"
                  onChange={(event) => saveDirectVideoReplacementResolution(node.id, event.target.value as BoardVideoResolution)}
                >
                  {selectedProfile?.resolutionOptions.map((resolution) => (
                    <option key={resolution} value={resolution}>{resolution.toUpperCase()}</option>
                  ))}
                </select>
              ) : selectedProfile?.resolution || "分辨率"}
            </div>
          </div>
          <CapabilityNote
            title="视频模型画板执行规则"
            items={videoReferenceCapabilityItems(selectedProfile)}
          />
          {isDirectVideoReplacement ? renderDirectVideoReplacementManager(node.id, inputsReady) : (
            <>
              {renderVideoSegmentManager(
                node.id,
                (segment) => executeVideoTask(node.id, segment),
                () => composeSegmentedVideos(node.id),
                inputsReady,
              )}
              <p className="text-[11px] text-muted-foreground">每个视频节点只接一组当前镜头素材。换镜、换机位或换构图时，换接对应的合成/修复底稿、当前镜头模特图与场景空镜。人工截图不直接进入视频节点。</p>
            </>
          )}
        </div>
      );
    }
    return null;
  }

  if (!workflow) {
    return (
      <div className={embedded ? "flex h-full items-center justify-center p-6 text-slate-100" : "luma-workspace-shell luma-board-embedded min-h-screen bg-transparent p-10 text-slate-100"}>
        <Card className="glass-card mx-auto max-w-xl">
          <CardContent className="p-10 text-center text-muted-foreground">{error || "正在加载画板..."}</CardContent>
        </Card>
      </div>
    );
  }

  const deleteDialogEdgeCount = deleteDialogNode
    ? workflow.edges.filter((edge) => edge.from === deleteDialogNode.id || edge.to === deleteDialogNode.id).length
    : 0;
  const deleteDialogFileCount = deleteDialogNode ? nodeFilePaths(deleteDialogNode).length : 0;
  const deleteDialogNodeIsRunning = Boolean(
    deleteDialogNode && (
      runningTask?.nodeId === deleteDialogNode.id
      || deleteDialogNode.execution?.status === "running"
      || deleteDialogNode.status === "running"
    )
  );
  const runningTaskNode = runningTask ? workflow.nodes.find((node) => node.id === runningTask.nodeId) : undefined;
  const showGlobalTaskPanel = Boolean(runningTask && (!runningTaskNode || runningTaskNode.kind !== "control"));
  const boardCanvasMinHeight = Math.max(
    appliedLayoutCanvasHeight,
    BOARD_LAYOUT_MIN_CANVAS_HEIGHT,
    ...workflow.nodes.map((node) => node.y + estimatedBoardNodeHeight(node) + 120)
  );
  const boardCanvasMinWidth = Math.max(
    BOARD_LAYOUT_MIN_CANVAS_WIDTH,
    ...workflow.nodes.map((node) => node.x + boardNodeWidth(node) + 120)
  );

  return (
    <div className={embedded ? "luma-board-embedded h-full min-h-0 overflow-hidden text-slate-100" : "luma-workspace-shell luma-board-embedded min-h-screen bg-transparent text-slate-100"}>
      {boardNotice && (
        <div className="fixed bottom-5 left-5 z-[1000001] flex w-[min(440px,calc(100vw-2.5rem))] items-start gap-3 rounded-2xl border border-emerald-300/35 bg-[#0a2221]/95 p-4 text-sm text-emerald-50 shadow-2xl backdrop-blur-xl">
          <LuCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
          <p className="min-w-0 flex-1 leading-6">{boardNotice}</p>
          {layoutUndoPositions && (
            <button
              type="button"
              className="shrink-0 rounded-lg border border-emerald-200/30 bg-emerald-200/10 px-2 py-1 text-xs font-medium text-emerald-50 transition hover:bg-emerald-200/20"
              onClick={undoLastLayout}
            >
              <LuUndo2 className="mr-1 inline h-3.5 w-3.5" />
              撤销
            </button>
          )}
          <button
            type="button"
            className="rounded-lg p-1 text-emerald-100/70 transition hover:bg-white/10 hover:text-white"
            onClick={() => setBoardNotice("")}
            aria-label="关闭提示"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>
      )}
      {showGlobalTaskPanel && runningTask && (
        <div className="fixed bottom-5 right-5 z-[9999] w-[min(320px,calc(100vw-2.5rem))] rounded-2xl border border-red-300/30 bg-[#160d12]/95 p-4 text-sm text-red-50 shadow-2xl backdrop-blur-xl">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-red-100">当前任务运行中</p>
              <p className="mt-1 text-xs text-red-100/70">{runningTask.label}</p>
            </div>
            <LuLoaderCircle className="h-5 w-5 animate-spin text-red-500" />
          </div>
          <Button type="button" variant="destructive" className="w-full border-red-300/40 bg-red-500/80 hover:bg-red-500" onClick={() => void cancelCurrentTask()}>
            <LuX className="mr-1.5 h-4 w-4" />
            取消当前任务
          </Button>
          <p className="mt-2 text-[11px] leading-relaxed text-red-100/70">
            取消后会按本次任务 ID 拦截晚返回结果；下一次任务重新读取当前画板连线。
          </p>
        </div>
      )}
      <header className={focusMode ? "hidden" : "sticky top-0 z-50 border-b border-cyan-100/10 bg-[#061019]/58 backdrop-blur-2xl"}>
        <div className={embedded ? "flex h-14 items-center justify-between px-4" : "mx-auto flex h-14 max-w-[1680px] items-center justify-between px-6"}>
          <div className="flex items-center gap-3">
            {embedded ? (
              <Button variant="ghost" size="sm" className="hidden" onClick={onBackToList}>
                <LuArrowLeft className="mr-1.5 h-4 w-4" />
                画板列表
              </Button>
            ) : (
              <Link href="/workspace?module=board" className="hidden">
              <Button variant="ghost" size="sm">
                <LuArrowLeft className="mr-1.5 h-4 w-4" />
                画板列表
              </Button>
              </Link>
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                  aria-label="画板名称"
                  value={workflowNameDraft}
                  onChange={(event) => setWorkflowNameDraft(event.target.value)}
                  onBlur={saveWorkflowName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  className={embedded ? "h-8 w-[220px] border-cyan-100/16 bg-white/[0.045] text-sm font-semibold text-slate-50" : "h-8 w-[280px] text-base font-semibold"}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={saveWorkflowName}
                  disabled={isSavingWorkflowName || !workflowNameDraft.trim() || workflowNameDraft.trim() === workflow.name}
                >
                  {isSavingWorkflowName ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuCheck className="mr-1.5 h-4 w-4" />}
                  保存名称
                </Button>
                <Badge variant="secondary">{statusLabel[workflow.status] || workflow.status}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{workflow.localDir}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <BoardLayoutControls
              onPreview={openLayoutPreview}
              canUndo={Boolean(layoutUndoPositions)}
              onUndo={undoLastLayout}
            />
            <Button variant="outline" size="sm" onClick={() => setFocusMode(true)}>
              <LuMaximize2 className="mr-1.5 h-4 w-4" />
              专注画板
            </Button>
            <Button variant="outline" size="sm" onClick={disconnectAllEdges} disabled={workflow.edges.length === 0}>
              一键断开连线
            </Button>
            <Button variant="outline" size="sm" onClick={load}>
              <LuRefreshCw className="mr-1.5 h-4 w-4" />
              刷新
            </Button>
            {embedded ? (
              <Button variant="outline" size="sm" onClick={onBackToList}>
                <LuArrowLeft className="mr-1.5 h-4 w-4" />
                画板列表
              </Button>
            ) : (
              <Link href="/workspace?module=board">
                <Button variant="outline" size="sm">
                  <LuArrowLeft className="mr-1.5 h-4 w-4" />
                  画板列表
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className={focusMode ? "fixed inset-0 z-[90] bg-white" : embedded ? "grid h-[calc(100%-3.5rem)] min-h-0 gap-3 overflow-hidden p-3 xl:grid-cols-[232px_minmax(0,1fr)]" : "grid w-full gap-3 px-4 py-4 xl:grid-cols-[232px_minmax(0,1fr)]"}>
        <aside className={focusMode ? "hidden" : embedded ? "space-y-3 overflow-y-auto pr-1" : "space-y-4"}>
          {error && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

          <Card className="glass-card overflow-hidden">
            <CardContent className="space-y-3 p-3">
              <div>
                <SectionTitle icon={<LuLayoutDashboard className="h-4 w-4" />} title="画板工具箱" />
                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                  这里只添加功能节点。素材导入、输入检查和真实执行均在画板节点内完成。
                </p>
              </div>
              <div className="grid gap-2">
                {CONTROL_TEMPLATES.map((template) => {
                  const TemplateIcon = template.icon === "camera"
                    ? LuCamera
                    : template.icon === "bot"
                      ? LuSparkles
                      : template.icon === "image"
                        ? LuImage
                        : template.icon === "video"
                          ? LuVideo
                          : LuFile;
                  return (
                    <div
                      key={template.role}
                      className="grid min-h-[74px] grid-cols-[24px_minmax(0,1fr)_68px] items-center gap-x-1.5 gap-y-1 rounded-lg border border-cyan-100/14 bg-transparent px-2 py-2"
                      title={`${template.title}：${template.description}`}
                    >
                      <div className="flex h-6 w-6 items-center justify-center rounded-md border border-cyan-100/12 bg-cyan-200/[0.06] text-cyan-100">
                        <TemplateIcon className="h-3.5 w-3.5" />
                      </div>
                      <p className="min-w-0 truncate text-[11px] font-semibold">{template.shortTitle}</p>
                      <TemplateDragButton
                        role={template.role}
                        onDragStart={startControlTemplateDrag}
                        onDragEnd={endControlTemplateDrag}
                        onAdd={addControlNode}
                      />
                      <p className="col-span-3 min-h-8 text-[10px] leading-4 text-muted-foreground">
                        {template.description}
                      </p>
                    </div>
                  );
                })}
              </div>
              <div className="grid gap-1 rounded-lg border border-cyan-100/14 bg-transparent p-2 text-[10px] text-muted-foreground">
                <ToolboxConfigRow label="LLM" value={llm.model || "未配置"} />
                <ToolboxConfigRow label="生图" value={selectedImageChannel?.model || "未配置"} />
                <ToolboxConfigRow label="视频" value={selectedVideoChannel?.model || "未配置"} />
                <ToolboxConfigRow label="成片" value={`${plannedTargetVideoDuration}s · ${getBoardVideoProfile(selectedVideoChannel)?.aspectRatio || "-"} · ${getBoardVideoProfile(selectedVideoChannel)?.resolution || "-"}`} />
              </div>
              <section className="border-t border-cyan-100/14 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-cyan-50">成片保存位置</p>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={videoSaveLocation?.directoryName}>
                      {isLoadingVideoSaveLocation
                        ? "正在读取..."
                        : videoSaveLocation
                          ? videoSaveLocation.directoryName
                          : "画板默认目录"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 border-cyan-100/20 bg-transparent px-2 text-[10px] text-cyan-50 hover:bg-cyan-100/10"
                      onClick={() => void chooseVideoSaveLocation()}
                      disabled={isChoosingVideoSaveLocation || isSyncingVideoSaveLocation}
                    >
                      {isChoosingVideoSaveLocation
                        ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        : <LuFolderOpen className="h-3.5 w-3.5" />}
                      <span className="ml-1">选择</span>
                    </Button>
                    {videoSaveLocation && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-cyan-50 hover:bg-cyan-100/10"
                          title="同步当前画板已有视频"
                          aria-label="同步当前画板已有视频"
                          onClick={() => void syncExistingVideoOutputs()}
                          disabled={isSyncingVideoSaveLocation || isChoosingVideoSaveLocation}
                        >
                          {isSyncingVideoSaveLocation
                            ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            : <LuDownload className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-cyan-50 hover:bg-cyan-100/10"
                          title="恢复画板默认目录"
                          aria-label="恢复画板默认目录"
                          onClick={() => void resetVideoSaveLocation()}
                          disabled={isSyncingVideoSaveLocation || isChoosingVideoSaveLocation}
                        >
                          <LuUndo2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {videoSaveLocation ? "新视频自动同步" : "画板默认归档"}
                </p>
                {videoSaveLocationStatus && (
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-100/85">{videoSaveLocationStatus}</p>
                )}
              </section>
            </CardContent>
          </Card>

        </aside>

        <section className={focusMode ? "flex h-screen w-screen flex-col overflow-hidden bg-white" : embedded ? "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-100/12 bg-white/[0.055] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-[15px]" : "flex min-h-[calc(100vh-88px)] min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-inner"}>
          <div className={focusMode ? "border-b border-border/70 bg-white/95 px-4 py-2 text-foreground shadow-sm" : "border-b border-border/70 bg-white/95 px-5 py-3 text-foreground"}>
            {focusMode ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">专注画板 · {workflow.name}</h2>
                    <Badge variant="secondary">{workflow.nodes.filter((node) => node.kind !== "note").length} 个节点</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Esc 退出；当前只隐藏左侧功能区，不影响节点、连线和生成状态。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <BoardLayoutControls
                    onPreview={openLayoutPreview}
                    canUndo={Boolean(layoutUndoPositions)}
                    onUndo={undoLastLayout}
                  />
                  <Button variant="outline" size="sm" onClick={disconnectAllEdges} disabled={workflow.edges.length === 0}>
                    一键断开连线
                  </Button>
                  <Button variant="outline" size="sm" onClick={load}>
                    <LuRefreshCw className="mr-1.5 h-4 w-4" />
                    刷新
                  </Button>
                  <Button size="sm" onClick={() => setFocusMode(false)}>
                    <LuX className="mr-1.5 h-4 w-4" />
                    退出专注
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3 rounded-2xl border border-primary/15 bg-primary/5 p-3">
                  <h3 className="text-sm font-semibold text-zinc-950">画板工作流说明</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    人为准备参考视频、商品图、人物身份参考；LLM 拆解参考视频方法；人工选帧截图；image-2 提取场景、逐张生成分角度人物商品资产、合成主图和修复细节；最后由人工选择 Grok 或即梦，按完整导演稿和对应参考图协议生成视频。执行节点只读取直接手动连入的有效素材；生成后的输出连线只用于追溯，不会自动成为下一步输入。
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">可视化生产流水线画板</h2>
                    <p className="text-xs text-muted-foreground">根素材、拆解报告、视频参考帧、场景、人物商品资产、合成图、修复图和视频都在这里串起来。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{workflow.nodes.filter((node) => node.kind !== "note").length} 个节点</Badge>
                    <Button variant="outline" size="sm" onClick={() => setFocusMode(true)}>
                      <LuMaximize2 className="mr-1.5 h-4 w-4" />
                      专注画板
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div
            ref={boardViewportRef}
            className="min-h-0 flex-1 overflow-auto bg-white"
            onDragOver={handleBoardDragOver}
            onDrop={handleBoardDrop}
          >
            <div
              ref={boardCanvasRef}
              className="relative min-h-[1800px] min-w-[2600px] bg-[radial-gradient(circle_at_1px_1px,rgba(15,23,42,0.12)_1px,transparent_0)] [background-size:24px_24px]"
              style={{ minHeight: boardCanvasMinHeight, minWidth: boardCanvasMinWidth }}
              onDragOver={handleBoardDragOver}
              onDrop={handleBoardDrop}
            >
              {BOARD_LAYOUT_COLUMNS.map((column) => (
                <div
                  key={column.index}
                  className="pointer-events-none absolute top-5 z-0 rounded-lg border border-slate-300/45 bg-white/75 px-3 py-2 shadow-sm backdrop-blur-sm"
                  style={{ left: boardLayoutStageLeft(column.index), width: BOARD_LAYOUT_HEADER_WIDTH }}
                >
                  <p className="text-xs font-semibold text-slate-700">{column.label}</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{column.description}</p>
                </div>
              ))}
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                {workflow.edges.map((edge) => {
                const from = workflow.nodes.find((node) => node.id === edge.from);
                const to = workflow.nodes.find((node) => node.id === edge.to);
                if (!from || !to || from.kind === "note" || to.kind === "note") return null;
                  const fromAnchor = dragRef.current?.id === from.id ? boardNodeAnchor(from, "output") : connectionAnchors[from.id]?.output ?? boardNodeAnchor(from, "output");
                  const toAnchor = dragRef.current?.id === to.id ? boardNodeAnchor(to, "input") : connectionAnchors[to.id]?.input ?? boardNodeAnchor(to, "input");
                  const x1 = fromAnchor.x;
                  const y1 = fromAnchor.y;
                  const x2 = toAnchor.x;
                  const y2 = toAnchor.y;
                  const mid = (x1 + x2) / 2;
                  return (
                    <path
                      key={edge.id}
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      stroke="rgba(99, 102, 241, 0.42)"
                      strokeWidth="2"
                      fill="none"
                    />
                  );
                })}
              </svg>
              {workflow.edges.map((edge) => {
                const from = workflow.nodes.find((node) => node.id === edge.from);
                const to = workflow.nodes.find((node) => node.id === edge.to);
                if (!from || !to || from.kind === "note" || to.kind === "note") return null;
                const fromAnchor = dragRef.current?.id === from.id ? boardNodeAnchor(from, "output") : connectionAnchors[from.id]?.output ?? boardNodeAnchor(from, "output");
                const toAnchor = dragRef.current?.id === to.id ? boardNodeAnchor(to, "input") : connectionAnchors[to.id]?.input ?? boardNodeAnchor(to, "input");
                const x1 = fromAnchor.x;
                const y1 = fromAnchor.y;
                const x2 = toAnchor.x;
                const y2 = toAnchor.y;
                return (
                  <button
                    key={`delete-${edge.id}`}
                    type="button"
                    className="absolute z-10 flex h-6 w-6 items-center justify-center rounded-full border border-white bg-white text-xs text-zinc-500 shadow hover:bg-red-50 hover:text-red-500"
                    style={{ left: (x1 + x2) / 2 - 12, top: (y1 + y2) / 2 - 12 }}
                    title={edge.label ? `删除连线：${edge.label}` : "删除连线"}
                    onClick={(event) => deleteEdge(edge, event)}
                  >
                    ×
                  </button>
                );
              })}
              {workflow.nodes.filter((node) => node.kind !== "note").map((node) => (
                <BoardNodeCard
                  key={node.id}
                  node={node}
                  controlExpanded={expandedControlNodeIds.includes(node.id)}
                  onToggleControl={() => {
                    bringNodeToFront(node);
                    setExpandedControlNodeIds((current) => (
                      current.includes(node.id) ? current.filter((item) => item !== node.id) : [...current, node.id]
                    ));
                  }}
                  directInputNodes={manualDirectInputIds(node.id)
                    .map((nodeId) => workflow.nodes.find((item) => item.id === nodeId))
                    .filter((item): item is BoardWorkflowNode => Boolean(item))}
                  onDragStart={startNodeDrag}
                  onDelete={deleteNode}
                  onConnectionStart={startManualConnection}
                  onConnectionEnd={finishManualConnection}
                  controlContent={renderControlNodeContent(node)}
                   nodes={workflow.nodes}
                  videoChannel={selectedVideoChannel}
                  sourceHasAudio={sourceVideoNode ? Boolean(sourceVideoNode.meta?.hasAudio) : undefined}
                  onPreview={setPreviewNode}
                  onBringToFront={bringNodeToFront}
                  onTranscribeAudio={transcribeAudioNode}
                  isTranscribingAudio={busy === "audio-transcribe"}
                  onTranslateAnalysis={translateReferenceAnalysis}
                  isTranslatingAnalysis={busy === "translate-analysis"}
                  onTranslateDirector={translateDirectorPrompt}
                  isTranslatingDirector={busy === "translate-director"}
                />
              ))}
              {connecting && (
                <svg className="pointer-events-none absolute inset-0 z-[70] h-full w-full">
                  <line
                    x1={connecting.startX}
                    y1={connecting.startY}
                    x2={connecting.pointerX}
                    y2={connecting.pointerY}
                    stroke="rgba(99,102,241,0.8)"
                    strokeWidth="3"
                    strokeDasharray="6 6"
                  />
                </svg>
              )}
            </div>
          </div>
        </section>
      </main>
      {previewNode && (
        <MediaPreviewDialog node={previewNode} onClose={() => setPreviewNode(null)} />
      )}
      <DeleteNodeDialog
        node={deleteDialogNode}
        connectedEdgeCount={deleteDialogEdgeCount}
        managedFileCount={deleteDialogFileCount}
        alsoDeleteFiles={deleteDialogAlsoDeleteFiles}
        isNodeRunning={deleteDialogNodeIsRunning}
        canCancelRunningTask={runningTask?.nodeId === deleteDialogNode?.id}
        isDeleting={isDeletingNode}
        error={deleteDialogError}
        onAlsoDeleteFilesChange={setDeleteDialogAlsoDeleteFiles}
        onCancel={() => {
          if (isDeletingNode) return;
          setDeleteDialogNode(null);
          setDeleteDialogError("");
        }}
        onCancelRunningTask={cancelCurrentTask}
        onConfirm={confirmDeleteNode}
      />
      <DisconnectEdgesDialog
        open={disconnectDialogOpen}
        edgeCount={workflow.edges.length}
        onCancel={() => setDisconnectDialogOpen(false)}
        onConfirm={confirmDisconnectAllEdges}
      />
      <BoardLayoutPreviewDialog
        preview={layoutPreview}
        onCancel={() => setLayoutPreview(null)}
        onConfirm={applyLayoutPreview}
      />
    </div>
  );
}

function BoardLayoutControls({
  onPreview,
  canUndo,
  onUndo,
}: {
  onPreview: (mode: BoardLayoutMode) => void;
  canUndo: boolean;
  onUndo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      if (rootRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function updateMenuPosition() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const menuWidth = 330;
      const viewportPadding = 12;
      const left = Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding));
      const availableBelow = window.innerHeight - rect.bottom;
      const availableAbove = rect.top;
      const openUpward = availableBelow < 300 && availableAbove > availableBelow;
      setMenuPosition(
        openUpward
          ? { left, bottom: window.innerHeight - rect.top + 8 }
          : { left, top: rect.bottom + 8 }
      );
    }

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  function choose(mode: BoardLayoutMode) {
    setOpen(false);
    onPreview(mode);
  }

  return (
    <div ref={rootRef} className="relative z-[70] flex items-center gap-1.5">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <LuLayoutDashboard className="mr-1.5 h-4 w-4" />
        整理画板
        <LuChevronDown className={`ml-1 h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>
      {canUndo && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-cyan-100/20 bg-white/[0.04] px-2 text-slate-100 hover:bg-white/[0.1] hover:text-white"
          onClick={onUndo}
          title="恢复整理前的位置"
        >
          <LuUndo2 className="h-4 w-4" />
          <span className="sr-only">撤销整理</span>
        </Button>
      )}
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={menuPosition}
          className="fixed z-[999999] w-[330px] overflow-hidden rounded-2xl border border-cyan-100/18 bg-[#0c202b]/[0.98] p-2 shadow-2xl backdrop-blur-xl"
        >
          <p className="px-2 py-1.5 text-[11px] leading-5 text-slate-300/75">仅调整节点位置，不改素材、不改连线、不触发生成。</p>
          <button
            type="button"
            role="menuitem"
            className="group flex w-full items-start gap-3 rounded-xl border border-cyan-200/20 bg-cyan-200/[0.07] px-3 py-3 text-left transition hover:bg-cyan-200/[0.13]"
            onClick={() => choose("pipeline")}
          >
            <LuColumns3 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-50">按操作就近整理 <span className="rounded-full bg-cyan-300/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-100">推荐</span></span>
              <span className="mt-1 block text-xs leading-5 text-slate-300/80">把证据靠近拆解、商品人物靠近 image-2、导演稿和镜头资产靠近视频节点，减少长距离拖线。</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="mt-2 flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white/[0.08]"
            onClick={() => choose("connections")}
          >
            <LuGitBranch className="mt-0.5 h-4 w-4 shrink-0 text-violet-200" />
            <span className="min-w-0">
              <span className="text-sm font-semibold text-slate-50">按手动连线整理</span>
              <span className="mt-1 block text-xs leading-5 text-slate-300/80">保留分区，但优先按同一手动连线分支排序，适合已经完成大量人工连线的画板。</span>
            </span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function BoardLayoutPreviewDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: BoardLayoutPreviewState | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!preview) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, preview]);

  if (!preview) return null;
  const isPipeline = preview.mode === "pipeline";

  return (
    <div
      className="fixed inset-0 z-[1000003] flex items-center justify-center bg-[#02070c]/78 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="board-layout-preview-title"
      onClick={onCancel}
    >
      <section
        className="w-full max-w-[860px] overflow-hidden rounded-[26px] border border-cyan-100/20 bg-[linear-gradient(145deg,rgba(25,55,68,0.98),rgba(8,23,33,0.98))] text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.52)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-200/25 bg-cyan-300/10 text-cyan-100">
              {isPipeline ? <LuColumns3 className="h-5 w-5" /> : <LuGitBranch className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <h2 id="board-layout-preview-title" className="text-base font-semibold">整理布局预览</h2>
            <p className="mt-1 text-xs text-slate-300/75">{isPipeline ? "按操作关系整理为就近双泳道，完整音频靠近导入素材" : "按手动连线优先排列分支"}</p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-xl p-2 text-slate-300/70 transition hover:bg-white/10 hover:text-white"
            onClick={onCancel}
            aria-label="关闭整理预览"
          >
            <LuX className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5 sm:px-6">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-2xl border border-cyan-100/14 bg-black/15 px-4 py-3">
              <p className="text-[11px] text-slate-300/70">将调整位置</p>
              <p className="mt-1 text-lg font-semibold text-white">{preview.movedCount} <span className="text-xs font-normal text-slate-300/70">个节点</span></p>
            </div>
            <div className="rounded-2xl border border-cyan-100/14 bg-black/15 px-4 py-3">
              <p className="text-[11px] text-slate-300/70">{isPipeline ? "已有手动连线" : "手动连线节点"}</p>
              <p className="mt-1 text-lg font-semibold text-white">{isPipeline ? preview.manualEdgeCount : preview.connectedNodeCount} <span className="text-xs font-normal text-slate-300/70">{isPipeline ? "条" : "个"}</span></p>
            </div>
            <div className="rounded-2xl border border-cyan-100/14 bg-black/15 px-4 py-3">
              <p className="text-[11px] text-slate-300/70">{isPipeline ? "按职责就近归位" : "待手工连接"}</p>
              <p className="mt-1 text-lg font-semibold text-white">{preview.unlinkedNodeCount} <span className="text-xs font-normal text-slate-300/70">个节点</span></p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {BOARD_LAYOUT_COLUMNS.map((column) => {
              const nodes = preview.columnNodes[column.index] || [];
              return (
                <div key={column.index} className="min-h-[128px] rounded-2xl border border-cyan-100/14 bg-white/[0.035] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-100">{column.label}</p>
                    <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] text-slate-200">{nodes.length}</span>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-slate-300/65">{column.description}</p>
                  <div className="mt-2 space-y-1">
                    {nodes.slice(0, 3).map((node) => (
                      <p key={node.id} className="truncate rounded-lg bg-black/15 px-2 py-1 text-[11px] text-slate-200">{displayTitle(node)}</p>
                    ))}
                    {nodes.length > 3 && <p className="px-1 text-[10px] text-slate-300/55">另有 {nodes.length - 3} 个节点</p>}
                    {nodes.length === 0 && <p className="px-1 text-[11px] text-slate-300/45">暂无节点</p>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="rounded-xl border border-cyan-100/12 bg-cyan-300/[0.06] px-3 py-2 text-xs leading-5 text-cyan-50/85">
            应用后只保存节点坐标；素材、文件、提示词、执行状态和手动连线都不会变化。应用后可立即撤销。
          </p>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-cyan-100/12 bg-black/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          <Button type="button" variant="outline" onClick={onCancel} className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white">
            返回画板
          </Button>
          <Button type="button" onClick={onConfirm} className="bg-cyan-500 text-slate-950 hover:bg-cyan-300">
            <LuCheck className="mr-1.5 h-4 w-4" />
            应用布局
          </Button>
        </footer>
      </section>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-primary">{icon}</span>
      <h2 className="font-semibold">{title}</h2>
    </div>
  );
}

function AssetUploadButton({
  label,
  busy,
  onFile,
  accept = "image/png,image/jpeg,image/webp",
  icon = "image",
  className,
}: {
  label: string;
  busy: boolean;
  onFile: (file: File | null) => void;
  accept?: string;
  icon?: "image" | "file";
  className?: string;
}) {
  const Icon = icon === "file" ? LuFile : LuImage;
  return (
    <label data-luma-asset-upload className={cn("flex min-h-12 cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-center text-sm font-medium leading-5", className)}>
      {busy ? <LuLoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : <Icon className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 break-words">{label}</span>
      <input className="hidden" type="file" accept={accept} onChange={(event) => onFile(event.target.files?.[0] || null)} />
    </label>
  );
}

function LocalFilePath({ filePath, publicUrl, compact = false }: { filePath?: string; publicUrl?: string; compact?: boolean }) {
  const [copyState, setCopyState] = useState<"" | "full" | "folder" | "failed">("");
  const folderPath = filePath ? filePath.slice(0, Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"))) : "";
  const fileName = filePath ? filePath.slice(Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/")) + 1) : "";
  const fullPath = filePath || publicUrl || "";
  if (!fullPath) return null;

  async function writeClipboard(value: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard is unavailable");
  }

  async function copyPath(event: MouseEvent<HTMLButtonElement>, value: string, kind: "full" | "folder") {
    event.stopPropagation();
    try {
      await writeClipboard(value);
      setCopyState(kind);
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <details className={`rounded-xl border border-zinc-200 bg-zinc-50 ${compact ? "px-2 py-1.5 text-[11px]" : "px-3 py-2 text-xs"}`}>
      <summary className="cursor-pointer select-none font-medium text-zinc-700">{filePath ? "本地文件" : "预览位置"}</summary>
      <div className="mt-2 space-y-2">
        {fileName && <p className="break-all font-medium text-zinc-800">文件名：{fileName}</p>}
        <code className="block break-all rounded-lg bg-white px-2 py-1 text-zinc-600">{fullPath}</code>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-zinc-600 hover:border-primary hover:text-primary"
            onClick={(event) => void copyPath(event, fullPath, "full")}
            title="复制完整文件路径"
            aria-label="复制完整文件路径"
          >
            {copyState === "full" ? <LuCheck className="h-3.5 w-3.5" /> : <LuCopy className="h-3.5 w-3.5" />}
            复制完整路径
          </button>
          {folderPath && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-zinc-600 hover:border-primary hover:text-primary"
              onClick={(event) => void copyPath(event, folderPath, "folder")}
              title="复制所在文件夹路径"
              aria-label="复制所在文件夹路径"
            >
              {copyState === "folder" ? <LuCheck className="h-3.5 w-3.5" /> : <LuCopy className="h-3.5 w-3.5" />}
              复制文件夹
            </button>
          )}
          {copyState === "failed" && <span className="text-rose-600">复制失败，请手动选中路径</span>}
          {copyState === "full" && <span className="text-emerald-700">已复制完整路径</span>}
          {copyState === "folder" && <span className="text-emerald-700">已复制文件夹路径</span>}
        </div>
      </div>
    </details>
  );
}

function ModelSelect({
  label,
  value,
  onChange,
  empty,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  empty: string;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <ModelChannelSelect value={value} onChange={onChange} emptyLabel={empty} ariaLabel={label} options={items} />
    </div>
  );
}

function TaskButton({
  label,
  busy,
  hint,
  expanded,
  onToggle,
  onClick,
  disabled = false,
}: {
  label: string;
  busy: boolean;
  hint: string;
  expanded: boolean;
  onToggle: () => void;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [requirement, purpose] = hint.split(" · ");
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-transparent transition", expanded ? "border-cyan-100/24" : "border-white/[0.09] hover:border-cyan-100/18")}>
      <Button
        type="button"
        variant="outline"
        className={cn("group relative min-h-[56px] w-full justify-between rounded-none border-0 px-3 pl-11 text-left text-sm font-semibold text-slate-100 shadow-none transition focus-visible:ring-2 focus-visible:ring-cyan-100/70", expanded ? "bg-cyan-300/[0.10]" : "bg-white/[0.025] hover:bg-white/[0.07]")}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="absolute left-2.5 flex h-6 w-6 items-center justify-center rounded-md border border-cyan-100/18 bg-[#061923]/38 text-cyan-50 transition group-hover:border-cyan-50/40 group-hover:bg-cyan-50/12">
          {busy ? <LuLoaderCircle className="h-4 w-4 animate-spin" /> : <LuLayers className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1 break-words pr-2 leading-5">{label}</span>
        <span className="ml-2 flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-slate-500">
          {busy ? "生成中" : disabled ? "待连线" : expanded ? "收起" : "展开"}
          <LuChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
        </span>
      </Button>
      {!expanded ? (
        <div className="border-t border-white/[0.06] bg-black/10 px-3 py-2.5 text-[11px] leading-5 text-slate-400">
          <p><span className="font-semibold text-cyan-100/80">需要连接：</span>{requirement || hint}</p>
          {purpose ? <p className="mt-0.5"><span className="font-semibold text-slate-300">作用：</span>{purpose}</p> : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="border-t border-white/[0.06] bg-black/10 px-3 py-3 text-[11px] leading-5 text-slate-400">
          <span className="mb-1 inline-flex rounded-md border border-cyan-100/14 px-1.5 py-0.5 font-semibold text-cyan-100/85">任务说明</span>
          <p><span className="font-semibold text-cyan-100/80">需要连接：</span>{requirement || hint}</p>
          {purpose ? <p className="mt-0.5"><span className="font-semibold text-slate-300">作用：</span>{purpose}</p> : null}
          <Button type="button" size="sm" className="mt-2 h-7 w-full px-2 text-[10px]" onClick={onClick} disabled={busy || disabled}>
            {busy ? <LuLoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LuSparkles className="mr-1 h-3.5 w-3.5" />}
            {busy ? "生成中" : "开始生成"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DirectorPromptButton({
  isRunning,
  hasPrompt,
  onClick,
  disabled,
  className,
}: {
  isRunning: boolean;
  hasPrompt: boolean;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const statusText = isRunning ? "生成中" : hasPrompt ? "已生成" : "待生成";
  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        "h-10 w-full justify-between gap-3 px-3 font-semibold shadow-sm transition-all",
        "focus-visible:ring-amber-400/40",
        isRunning
          ? "border-amber-500 bg-amber-500 text-white shadow-amber-200 hover:bg-amber-500 disabled:opacity-100"
          : hasPrompt
            ? "border-emerald-300 bg-emerald-50 text-emerald-950 hover:border-emerald-400 hover:bg-emerald-100"
            : "border-amber-300 bg-amber-50 text-amber-950 hover:border-amber-400 hover:bg-amber-100",
        className
      )}
      onClick={onClick}
      disabled={disabled}
      aria-live="polite"
    >
      <span className="flex min-w-0 items-center">
        {isRunning ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : hasPrompt ? <LuCheck className="mr-1.5 h-4 w-4" /> : <LuVideo className="mr-1.5 h-4 w-4" />}
        <span className="truncate">完整视频导演稿</span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
          isRunning
            ? "bg-white/20 text-white"
            : hasPrompt
              ? "bg-emerald-600 text-white"
              : "bg-amber-500 text-white"
        )}
      >
        {statusText}
      </span>
    </Button>
  );
}

function CapabilityNote({ title = "节点规则", items }: { title?: string; items: string[] }) {
  return (
    <details className="rounded-lg border border-primary/15 bg-transparent px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer select-none text-xs font-semibold text-zinc-800">{title}</summary>
      <ul className="mt-2 space-y-1">
        {items.map((item) => {
          const [label, ...rest] = item.split("：");
          const body = rest.join("：");
          return (
            <li key={item} className="flex gap-1.5">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
              <span>
                {body ? (
                  <>
                    <span className="font-semibold text-zinc-700">{label}：</span>
                    <span>{body}</span>
                  </>
                ) : item}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function ControlInputStatus({ node, inputs, videoChannel, sourceHasAudio }: {
  node: BoardWorkflowNode;
  inputs: BoardWorkflowNode[];
  videoChannel?: BoardVideoChannelCapabilities | null;
  sourceHasAudio?: boolean;
}) {
  const health = controlInputHealth(node, inputs, videoChannel, sourceHasAudio);
  const isDirectVideoReplacement = Boolean(getBoardVideoProfile(videoChannel)?.directVideoReplacement)
    && String(node.meta?.controlRole || "") === "video_generate";
  const isReady = health.missing.length === 0 && health.invalid.length === 0;
  return (
    <div className={cn(
      "mb-2 rounded-lg border px-2.5 py-2 text-[11px]",
      isDirectVideoReplacement
        ? "border-cyan-100/20 bg-slate-950/55 text-cyan-50"
        : isReady ? "border-emerald-200 bg-emerald-50/70 text-emerald-800" : "border-amber-200 bg-amber-50/70 text-amber-900",
    )}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{health.readyText}</span>
        <span className="shrink-0">直连 {inputs.length}</span>
      </div>
      {inputs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {inputs.map((input) => (
            <span key={input.id} className={cn(
              "max-w-full truncate rounded border border-current/15 px-1.5 py-0.5",
              isDirectVideoReplacement ? "bg-black/20" : "bg-white/70",
            )}>
              {displayTitle(input)}
            </span>
          ))}
        </div>
      )}
      {health.missing.map((item) => (
        <p key={`missing-${item}`} className="mt-1 leading-relaxed">缺少：{item}</p>
      ))}
      {health.invalid.map((item) => (
        <p key={`invalid-${item}`} className="mt-1 leading-relaxed">冲突：{item}</p>
      ))}
      {health.notices?.map((item) => (
        <p key={`notice-${item}`} className="mt-1 leading-relaxed text-sky-800">提示：{item}</p>
      ))}
    </div>
  );
}

function CurrentReferencePackage({ nodes }: { nodes: BoardWorkflowNode[] }) {
  if (nodes.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-200/20 bg-amber-100/[0.05] px-2.5 py-2 text-[10px] leading-relaxed text-amber-100/80">
        <LuGitBranch className="h-3.5 w-3.5 shrink-0" />
        <span><strong className="font-semibold text-amber-50">当前未连接素材</strong> · 请先按任务要求手动连线，系统不会自动补图。</span>
      </div>
    );
  }

  return (
    <details className="rounded-lg border border-cyan-100/14 bg-black/10 px-2.5 py-1.5 text-[10px] text-slate-300">
      <summary className="cursor-pointer select-none font-semibold">
        当前直接连入 image-2：{nodes.length} 个图片节点
      </summary>
      <ul className="mt-1.5 space-y-1 text-slate-400">
        {nodes.map((node) => (
          <li key={node.id} className="truncate">
            {nodeKindLabel(node)} · {displayTitle(node)}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 border-t border-white/[0.07] pt-1.5 text-slate-500">
        点击任务时只发送符合该任务规则的直接连线图片；其它图片不会发送，也不会自动补图。
      </p>
    </details>
  );
}

function PendingImageRecoveryPanel({
  notice,
  pendingResults,
  busy,
  onRetry,
}: {
  notice: string;
  pendingResults: BoardImagePendingSummary[];
  busy: string;
  onRetry: (pending: BoardImagePendingSummary) => void;
}) {
  if (!notice && pendingResults.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-amber-300/40 bg-amber-50/70 p-2.5 text-[11px] text-amber-900">
      {notice && <p className="leading-relaxed">{notice}</p>}
      {pendingResults.map((pending) => (
        <div key={pending.id} className="flex items-start justify-between gap-2 border-t border-amber-300/30 pt-2 first:border-t-0 first:pt-0">
          <div className="min-w-0">
            <p className="truncate font-semibold">{pending.title}</p>
            <p className="mt-0.5 text-amber-800/80">
              {pending.transport === "b64_json" ? "Base64 已保全" : "URL 已保全"}
              {imageTimingText(pending.generationTiming) ? ` · ${imageTimingText(pending.generationTiming)}` : ""}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => onRetry(pending)}>
            {busy === "image_recovery" ? <LuLoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LuRefreshCw className="mr-1 h-3.5 w-3.5" />}
            继续保存
          </Button>
        </div>
      ))}
    </div>
  );
}

function TemplateDragButton({
  role,
  onDragStart,
  onDragEnd,
  onAdd,
}: {
  role: ControlRole;
  onDragStart: (role: ControlRole, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onAdd: (role: ControlRole) => void;
}) {
  return (
    <button
      type="button"
      draggable
      className="h-8 w-[68px] shrink-0 whitespace-nowrap rounded-md border border-primary/20 bg-primary/5 px-1.5 text-[11px] font-medium text-primary transition hover:bg-primary/10"
      title="拖到右侧画板创建真实功能节点，也可以点击快速添加"
      onDragStart={(event) => onDragStart(role, event)}
      onDragEnd={onDragEnd}
      onClick={() => onAdd(role)}
    >
      拖到画板
    </button>
  );
}

function ToolboxConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-2">
      <span className="font-semibold text-foreground">{label}</span>
      <span className="truncate text-right" title={value}>{value}</span>
    </div>
  );
}

function BoardNodeCard({
  node,
  controlExpanded,
  onToggleControl,
  directInputNodes,
  onDragStart,
  onDelete,
  onConnectionStart,
  onConnectionEnd,
  controlContent,
  nodes,
  videoChannel,
  sourceHasAudio = false,
  onPreview,
  onBringToFront,
  onTranscribeAudio,
  isTranscribingAudio = false,
  onTranslateAnalysis,
  isTranslatingAnalysis = false,
  onTranslateDirector,
  isTranslatingDirector = false,
}: {
  node: BoardWorkflowNode;
  controlExpanded: boolean;
  onToggleControl: () => void;
  directInputNodes: BoardWorkflowNode[];
  onDragStart: (node: BoardWorkflowNode, event: PointerEvent<HTMLElement>) => void;
  onDelete: (node: BoardWorkflowNode, event: MouseEvent<HTMLButtonElement>) => void;
  onConnectionStart: (node: BoardWorkflowNode, event: PointerEvent<HTMLButtonElement>) => void;
  onConnectionEnd: (node: BoardWorkflowNode, event: PointerEvent<HTMLButtonElement>) => void;
  controlContent?: React.ReactNode;
  nodes: BoardWorkflowNode[];
  videoChannel?: BoardVideoChannelCapabilities | null;
  sourceHasAudio?: boolean;
  onPreview: (node: BoardWorkflowNode) => void;
  onBringToFront: (node: BoardWorkflowNode) => void;
  onTranscribeAudio?: (nodeId: string) => void;
  isTranscribingAudio?: boolean;
  onTranslateAnalysis?: (node: BoardWorkflowNode) => void;
  isTranslatingAnalysis?: boolean;
  onTranslateDirector?: (node: BoardWorkflowNode) => void;
  isTranslatingDirector?: boolean;
}) {
  const isControl = node.kind === "control";
  const frameItems = frameCollectionItems(node);
  const frameLabel = roleOf(node) === "action_supplement_storyboard_collection"
    ? "动作补证"
    : roleOf(node) === "action_detail_storyboard_collection"
      ? "动作证据"
      : "帧";
  const [frameIndex, setFrameIndex] = useState(0);
  const activeFrameIndex = Math.min(frameIndex, Math.max(0, frameItems.length - 1));
  const activeFrame = frameItems[activeFrameIndex];
  const inputNodes = (node.execution?.inputNodeIds || []).map((nodeId) => nodes.find((item) => item.id === nodeId)).filter(Boolean) as BoardWorkflowNode[];
  const outputNodes = (node.execution?.outputNodeIds || []).map((nodeId) => nodes.find((item) => item.id === nodeId)).filter(Boolean) as BoardWorkflowNode[];
  const [analysisLanguage, setAnalysisLanguage] = useState<"english" | "chinese">("english");
  const translatedChinese = node.meta?.translatedChinese;
  const translatedChineseText = translatedChinese && typeof translatedChinese === "object" && !Array.isArray(translatedChinese)
    ? String((translatedChinese as Record<string, unknown>).text || "").trim()
    : "";
  const isReferenceMethodAnalysis = roleOf(node) === "reference_method_analysis";
  const isVideoDirectorPrompt = roleOf(node) === "video_director_prompt";
  const visibleAnalysisText = analysisLanguage === "chinese" && translatedChineseText ? translatedChineseText : node.text || "";
  const executionStatus = boardNodeVisibleExecutionStatus({ nodes }, node);
  const isCurrentExecution = executionStatus === "running" || executionStatus === "syncing";
  const executionLogScope = isCurrentExecution ? "本次" : "上次";
  const executionTone =
    executionStatus === "running" || executionStatus === "syncing" ? "border-blue-200 bg-blue-50 text-blue-700" :
    executionStatus === "failed" ? "border-red-200 bg-red-50 text-red-700" :
    executionStatus === "cancelled" ? "border-amber-200 bg-amber-50 text-amber-700" :
    executionStatus === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
    "border-zinc-200 bg-zinc-50 text-zinc-500";
  const videoJob = node.execution?.videoJob;
  const videoJobMatchesExecution = Boolean(videoJob && (
    ((executionStatus === "running" || executionStatus === "syncing")
      && ["submitted", "queued", "running", "completed_pending_content"].includes(videoJob.status))
    || (executionStatus === "done" && videoJob.status === "completed")
    || (executionStatus === "failed" && videoJob.status === "failed")
    || (executionStatus === "cancelled" && videoJob.status === "cancelled")
  ));
  // Keep historical task data in the board payload, but never render a prior
  // job's hosting audit as though it belonged to the current execution.
  const referenceCleanup = node.execution?.referenceCleanup || (videoJobMatchesExecution ? videoJob?.referenceCleanup : undefined);
  const referenceCleanupLabel = referenceCleanup?.status === "confirmed"
    ? `已确认不存在 ${referenceCleanup.total}/${referenceCleanup.total}`
    : referenceCleanup?.status === "partial_failure"
      ? `清理未完成：失败 ${referenceCleanup.failed}/${referenceCleanup.total}`
      : referenceCleanup
        ? `未能核实 ${referenceCleanup.total} 个文件`
        : "";
  const referenceCleanupTone = referenceCleanup?.status === "confirmed"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : referenceCleanup?.status === "partial_failure"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-red-200 bg-red-50 text-red-800";
  const hostedReferences = videoJobMatchesExecution ? videoJob?.hostedReferences || [] : [];
  const verifiedHostedReferenceCount = hostedReferences.filter((asset) => (
    Boolean(asset.sourceBytes) && Boolean(asset.sourceSha256) && Boolean(asset.verifiedAt)
  )).length;
  const lingganyaReferenceCount = videoJobMatchesExecution && videoJob?.referenceTransport === "lingganya_file_id"
    ? videoJob.referenceUploadCount || 0
    : 0;
  const lingganyaReferenceExpiry = videoJobMatchesExecution
    && videoJob?.referenceTransport === "lingganya_file_id"
    && videoJob.referenceExpiresAt
    && Number.isFinite(Date.parse(videoJob.referenceExpiresAt))
    ? new Date(videoJob.referenceExpiresAt).toLocaleString("zh-CN", { hour12: false })
    : "";
  const isFrontNode = nodeZIndex(node) >= Math.max(NODE_BASE_Z_INDEX, ...nodes.map(nodeZIndex));

  return (
    <div
      data-luma-board-node
      data-node-id={node.id}
      data-node-status={String(executionStatus || "pending")}
      data-node-selected={isFrontNode ? "true" : undefined}
      className={`absolute rounded-2xl border border-zinc-200 bg-transparent p-3 shadow-xl transition ${
        isFrontNode ? "ring-2 ring-primary/20 shadow-2xl" : ""
      }`}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: boardNodeWidth(node),
        zIndex: nodeZIndex(node),
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button,input,textarea,select,video,audio,[contenteditable='true'],[data-luma-board-drag-handle]")) return;
        onBringToFront(node);
      }}
    >
      <button
        type="button"
        data-luma-board-connection-handle="input"
        className="absolute -left-3.5 top-14 z-20 h-7 w-7 rounded-full bg-transparent after:absolute after:left-1/2 after:top-1/2 after:h-4 after:w-4 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border-2 after:border-white after:bg-sky-500 after:shadow after:transition hover:after:scale-125"
        title="输入点：拖到这里松开可建立手动连线"
        onPointerUp={(event) => onConnectionEnd(node, event)}
        onClick={(event) => event.stopPropagation()}
      />
      <button
        type="button"
        data-luma-board-connection-handle="output"
        className="absolute -right-3.5 top-14 z-20 h-7 w-7 rounded-full bg-transparent after:absolute after:left-1/2 after:top-1/2 after:h-4 after:w-4 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border-2 after:border-white after:bg-violet-500 after:shadow after:transition hover:after:scale-125"
        title="输出点：从这里拖到其他节点输入点"
        onPointerDown={(event) => onConnectionStart(node, event)}
        onClick={(event) => event.stopPropagation()}
      />
      <div
        data-luma-board-drag-handle
        className="mb-2 flex cursor-grab touch-none select-none items-start justify-between gap-2 active:cursor-grabbing"
        title="按住标题区域拖动画板节点"
        onPointerDown={(event) => onDragStart(node, event)}
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-950">{displayTitle(node)}</div>
          <div className="mt-1 text-[11px] text-zinc-500">{nodeKindLabel(node)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isControl && (
            <button
              type="button"
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              title={controlExpanded ? "收起节点操作" : "展开节点操作"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onToggleControl();
              }}
            >
              <LuChevronDown className={cn("h-4 w-4 transition-transform", controlExpanded && "rotate-180")} />
            </button>
          )}
          <button
            type="button"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 cursor-grab active:cursor-grabbing"
            title="拖动节点"
            data-luma-board-drag-handle
            onPointerDown={(event) => onDragStart(node, event)}
            onClick={(event) => event.stopPropagation()}
          >
            <LuGrip className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500"
            title="删除节点"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onDelete(node, event)}
          >
            <LuTrash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isControl && (
        <div data-luma-node-status-strip className={`mb-2 rounded-xl border px-2 py-1.5 text-[11px] ${executionTone}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {(executionStatus === "running" || executionStatus === "syncing") && <LuLoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" />}
              {nodeStatusLabel[String(executionStatus || "pending")] || "待执行"}
            </span>
            <span>
              {executionLogScope}输入 {node.execution?.inputNodeIds?.length || 0} / {executionLogScope}输出 {node.execution?.outputNodeIds?.length || 0}
            </span>
          </div>
          {node.execution?.summary && <p className="mt-1 line-clamp-2">{node.execution.summary}</p>}
          {(node.execution?.error || node.error) && <p className="mt-1 line-clamp-3 text-red-600">{node.execution?.error || node.error}</p>}
          {hostedReferences.length > 0 && (
            <p className={`mt-1 ${verifiedHostedReferenceCount === hostedReferences.length ? "text-emerald-700" : "text-amber-700"}`}>
              Cloudinary 原始字节校验：{verifiedHostedReferenceCount}/{hostedReferences.length} 个参考素材已一致。
            </p>
          )}
          {lingganyaReferenceCount > 0 && (
            <p className="mt-1 text-emerald-700">
              灵感鸭临时参考：{lingganyaReferenceCount} 个，24 小时自动失效
              {lingganyaReferenceExpiry ? `（最早 ${lingganyaReferenceExpiry}）` : ""}。
            </p>
          )}
          {referenceCleanup && (
            <details className={`mt-1 rounded-lg border px-2 py-1 text-[10px] leading-relaxed ${referenceCleanupTone}`}>
              <summary className="cursor-pointer select-none font-medium">Cloudinary 临时参考：{referenceCleanupLabel}</summary>
              <div className="mt-1.5 space-y-1.5">
                <p>
                  实际回执：删除 {referenceCleanup.deleted} 个；已确认原本不存在 {referenceCleanup.alreadyAbsent} 个；失败 {referenceCleanup.failed} 个。
                </p>
                <ul className="space-y-1 border-t border-current/15 pt-1.5">
                  {referenceCleanup.assets.map((asset, index) => {
                    const status = asset.status === "deleted"
                      ? "已删除"
                      : asset.status === "already_absent"
                        ? "已确认不存在"
                        : asset.status === "failed"
                          ? "清理失败"
                          : "未能核实";
                    return (
                      <li key={`${asset.publicId}-${index}`}>
                        素材 {index + 1}（{asset.resourceType === "video" ? "视频/音频" : "图片"}）：{status}
                        {asset.error ? <p className="mt-0.5 break-all opacity-85">原因：{asset.error}</p> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          )}
          {(inputNodes.length > 0 || outputNodes.length > 0) && (
            <details className="mt-1 rounded-lg bg-white/60 px-2 py-1 text-zinc-600">
              <summary className="cursor-pointer select-none">查看{executionLogScope}执行输入/输出</summary>
              {inputNodes.length > 0 && (
                <div className="mt-1">
                  <p className="font-medium text-zinc-700">输入</p>
                  <ul className="list-inside list-disc">
                    {inputNodes.map((item) => <li key={item.id} className="truncate">{displayTitle(item)}</li>)}
                  </ul>
                </div>
              )}
              {outputNodes.length > 0 && (
                <div className="mt-1">
                  <p className="font-medium text-zinc-700">输出</p>
                  <ul className="list-inside list-disc">
                    {outputNodes.map((item) => <li key={item.id} className="truncate">{displayTitle(item)}</li>)}
                  </ul>
                </div>
              )}
            </details>
          )}
        </div>
      )}

      {isControl && <ControlInputStatus node={node} inputs={directInputNodes} videoChannel={videoChannel} sourceHasAudio={sourceHasAudio} />}

      {isControl && controlContent && controlExpanded && (
        <div data-luma-node-control-content data-luma-control-role={controlRoleOf(node)} className="mb-2 rounded-xl border border-cyan-100/15 bg-transparent p-2" onClick={(event) => event.stopPropagation()}>
          {controlContent}
        </div>
      )}
      {frameItems.length > 0 && activeFrame && (
        <div className="mb-2 rounded-xl border border-zinc-100 bg-zinc-50 p-2" onClick={(event) => event.stopPropagation()}>
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
            <span>{frameLabel} {activeFrameIndex + 1}/{frameItems.length}</span>
            <span>{activeFrame.title || `${frameLabel} ${activeFrameIndex + 1}`}</span>
          </div>
          <div className="group relative flex items-center justify-center rounded-xl bg-white p-1" style={mediaBoxStyle(node)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeFrame.publicUrl || node.publicUrl}
              alt={activeFrame.title || displayTitle(node)}
              className="h-full w-full rounded-lg object-contain"
            />
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 shadow transition group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onPreview({
                  ...node,
                  title: activeFrame.title || node.title,
                  description: `${node.description || ""}\n当前查看：${activeFrame.title || `${frameLabel} ${activeFrameIndex + 1}`}`,
                  filePath: activeFrame.filePath || node.filePath,
                  publicUrl: activeFrame.publicUrl || node.publicUrl,
                });
              }}
            >
              <LuMaximize2 className="h-3.5 w-3.5" />
              放大预览
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFrameIndex((current) => Math.max(0, current - 1))}
              disabled={activeFrameIndex <= 0}
            >
              上一张
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFrameIndex((current) => Math.min(frameItems.length - 1, Math.max(0, current + 1)))}
              disabled={activeFrameIndex >= frameItems.length - 1}
            >
              下一张
            </Button>
          </div>
        </div>
      )}
      {isImageNode(node) && frameItems.length === 0 && (
        <div className="group relative mb-2 flex items-center justify-center rounded-xl bg-zinc-50 p-1" style={mediaBoxStyle(node)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={node.publicUrl} alt={displayTitle(node)} className="h-full w-full rounded-lg object-contain" />
          <button
            type="button"
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 shadow transition group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onPreview(node);
            }}
          >
            <LuMaximize2 className="h-3.5 w-3.5" />
            放大预览
          </button>
        </div>
      )}
      {isImageNode(node) && (String(node.meta?.resultTransport || "") || imageTimingText(node.meta?.generationTiming)) && (
        <div
          className={cn(
            "mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 text-[10px] leading-4",
            String(node.meta?.resultTransport || "") === "b64_json"
              ? "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-50"
              : "border-amber-300/25 bg-amber-300/[0.08] text-amber-50"
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium">
            <LuCheck className="h-3.5 w-3.5" />
            {String(node.meta?.resultTransport || "") === "b64_json" ? "Base64 已本地保存" : "URL 回退保存"}
          </span>
          {imageTimingText(node.meta?.generationTiming) && (
            <span className="min-w-0 text-slate-300/70">{imageTimingText(node.meta?.generationTiming)}</span>
          )}
        </div>
      )}
      {isVideoNode(node) && (
        <div className="group relative mb-2 flex items-center justify-center rounded-xl bg-zinc-50 p-1" style={mediaBoxStyle(node)}>
          <video src={node.publicUrl} className="h-full w-full rounded-lg object-contain" controls />
          <button
            type="button"
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 shadow transition group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onPreview(node);
            }}
          >
            <LuMaximize2 className="h-3.5 w-3.5" />
            预览视频
          </button>
        </div>
      )}
      {isAudioNode(node) && (
        <div className="mb-2 rounded-xl border border-zinc-100 bg-zinc-50 p-2" onClick={(event) => event.stopPropagation()}>
          <div className="mb-2 grid grid-cols-2 gap-2 text-[11px] text-zinc-600">
            <div className="rounded-lg bg-white px-2 py-1">音频时长：{Number(node.meta?.sourceDurationSeconds || node.meta?.evidenceDurationSeconds || 0).toFixed(1)}s</div>
            <div className="rounded-lg bg-white px-2 py-1">覆盖范围：源视频全长</div>
            <div className="rounded-lg bg-white px-2 py-1">采样率：{String(node.meta?.sampleRate || "16000")}Hz</div>
            <div className="rounded-lg bg-white px-2 py-1">码率：{String(node.meta?.bitrate || "48k")}</div>
          </div>
          <audio src={currentBoardMediaUrl(node)} className="w-full" controls />
          <Button
            type="button"
            variant="default"
            size="sm"
            className="mt-2 w-full"
            disabled={isTranscribingAudio || !onTranscribeAudio}
            onClick={(event) => {
              event.stopPropagation();
              onTranscribeAudio?.(node.id);
            }}
          >
            {isTranscribingAudio ? <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LuFileText className="mr-1.5 h-3.5 w-3.5" />}
            {isTranscribingAudio ? "中文转写中..." : "中文音频转写"}
          </Button>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">首次使用会下载本地 Whisper 模型，完成后模型会保存在本机。</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            onClick={(event) => {
              event.stopPropagation();
              onPreview(node);
            }}
          >
            <LuMaximize2 className="mr-1.5 h-3.5 w-3.5" />
            预览完整音频
          </Button>
        </div>
      )}
      {(isImageNode(node) || isVideoNode(node) || isAudioNode(node)) && (
        <div className="mb-2" onClick={(event) => event.stopPropagation()}>
          <LocalFilePath
            filePath={activeFrame?.filePath || node.filePath}
            publicUrl={activeFrame?.publicUrl || node.publicUrl}
            compact
          />
        </div>
      )}
      {node.kind === "analysis" && (
        <div className="mb-2 space-y-2 rounded-xl bg-zinc-50 p-2 text-xs leading-relaxed text-zinc-700" onClick={(event) => event.stopPropagation()}>
          {isReferenceMethodAnalysis && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                variant={analysisLanguage === "english" ? "default" : "outline"}
                size="sm"
                onClick={() => setAnalysisLanguage("english")}
              >
                English
              </Button>
              {translatedChineseText && (
                <Button
                  type="button"
                  variant={analysisLanguage === "chinese" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAnalysisLanguage("chinese")}
                >
                  中文译文
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isTranslatingAnalysis || !onTranslateAnalysis}
                onClick={() => onTranslateAnalysis?.(node)}
              >
                {isTranslatingAnalysis ? <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LuFileText className="mr-1.5 h-3.5 w-3.5" />}
                {translatedChineseText ? "重新翻译" : "翻译为中文"}
              </Button>
            </div>
          )}
          <div className="max-h-48 overflow-auto whitespace-pre-wrap">{visibleAnalysisText}</div>
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => onPreview({ ...node, text: visibleAnalysisText })}>
            <LuMaximize2 className="mr-1.5 h-3.5 w-3.5" />
            预览全文
          </Button>
        </div>
      )}
      {node.kind === "prompt" && (
        <div className="mb-2 space-y-2 rounded-xl bg-zinc-50 p-2 text-xs leading-relaxed text-zinc-700" onClick={(event) => event.stopPropagation()}>
          {isVideoDirectorPrompt && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={isTranslatingDirector || !onTranslateDirector}
              onClick={() => onTranslateDirector?.(node)}
            >
              {isTranslatingDirector ? <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <LuFileText className="mr-1.5 h-3.5 w-3.5" />}
              {translatedChineseText ? "重新翻译中文稿" : "翻译为中文"}
            </Button>
          )}
          <div className="max-h-44 overflow-auto">
            <p className="mb-2 font-medium text-zinc-950">{isVideoDirectorPrompt ? "中文译文" : "中文说明"}</p>
            <p className="whitespace-pre-wrap">{isVideoDirectorPrompt ? (translatedChineseText || "尚未生成中文译文。") : (node.promptChinese || "暂无中文说明")}</p>
            <p className="mb-2 mt-3 font-medium text-zinc-950">English Prompt</p>
            <p className="whitespace-pre-wrap">{node.promptEnglish || "No English prompt yet."}</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => onPreview(node)}>
            <LuMaximize2 className="mr-1.5 h-3.5 w-3.5" />
            预览完整稿
          </Button>
        </div>
      )}
      {displayDescription(node) && <p className="line-clamp-3 text-xs text-zinc-500">{displayDescription(node)}</p>}
    </div>
  );
}

function MediaPreviewDialog({ node, onClose }: { node: BoardWorkflowNode; onClose: () => void }) {
  const isImage = isImageNode(node);
  const isVideo = isVideoNode(node);
  const isAudio = isAudioNode(node);
  const isText = Boolean(nodePreviewText(node));
  const isMedia = isImage || isVideo || isAudio;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails = Boolean(node.description || node.filePath || node.publicUrl);
  const dialogStyle = isText && !isImage && !isVideo && !isAudio
    ? { width: "min(1120px, 96vw)" }
    : isImage
      ? { width: "min(94vw, 960px)" }
      : previewDialogStyle(node, isAudio);
  const mediaDialogHeight = isImage ? "min(84dvh, 860px)" : "min(92dvh, 1080px)";
  const mediaStyle: CSSProperties = { maxHeight: "100%", maxWidth: "100%" };
  const currentMediaUrl = currentBoardMediaUrl(node);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  if ((!node.publicUrl || (!isImage && !isVideo && !isAudio)) && !isText) return null;

  return (
    <div
      className="fixed inset-0 z-[1000000] flex items-center justify-center bg-[#02070c]/88 p-3 backdrop-blur-md sm:p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex min-h-0 max-w-none flex-col overflow-hidden rounded-[22px] border border-cyan-100/18 bg-[#07151d] text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.62)]"
        style={{ ...dialogStyle, ...(isMedia ? { height: mediaDialogHeight } : { maxHeight: "92dvh" }) }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 border-b border-cyan-100/12 bg-[#0b1b24]/95 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{displayTitle(node)}</p>
            <p className="mt-0.5 text-xs text-slate-300/65">{nodeKindLabel(node)}</p>
          </div>
          <button
            type="button"
            className="rounded-xl border border-cyan-100/15 bg-white/[0.04] p-2 text-slate-200 transition hover:bg-white/[0.1] hover:text-white"
            onClick={onClose}
            aria-label="关闭预览"
          >
            <LuX className="h-5 w-5" />
          </button>
        </div>
        {isImage ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black/35 p-4 sm:p-5 lg:p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={node.publicUrl}
                alt={displayTitle(node)}
                className="h-auto w-auto rounded-xl border border-white/10 object-contain shadow-[0_18px_50px_rgba(0,0,0,0.42)]"
                style={mediaStyle}
              />
            </div>
            {hasDetails && (
              <aside className="shrink-0 border-t border-cyan-100/12 bg-[#06131a]/95 px-4 py-3 sm:px-5 lg:flex lg:w-[320px] lg:min-h-0 lg:flex-col lg:border-l lg:border-t-0 lg:px-5 lg:py-5">
                <p className="hidden text-xs font-semibold text-slate-100 lg:block">图片说明与本地文件位置</p>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left text-xs font-medium text-slate-200 transition hover:text-white lg:hidden"
                  onClick={() => setDetailsOpen((current) => !current)}
                  aria-expanded={detailsOpen}
                >
                  <span>图片说明与本地文件位置</span>
                  <span className="text-slate-300/65">{detailsOpen ? "收起" : "展开"}</span>
                </button>
                <div className={cn("mt-2 space-y-2 text-xs leading-relaxed text-slate-300/78", detailsOpen ? "block" : "hidden", "lg:mt-3 lg:block lg:min-h-0 lg:flex-1 lg:overflow-auto")}>
                  {node.description && <div>{node.description}</div>}
                  <LocalFilePath filePath={node.filePath} publicUrl={node.publicUrl} />
                </div>
              </aside>
            )}
          </div>
        ) : (
          <>
            <div className={`flex min-h-0 flex-1 overflow-auto p-3 sm:p-4 ${isText && !isMedia ? "items-start justify-start bg-white" : "items-center justify-center bg-black/35"}`}>
              {isVideo && (
                <video
                  src={node.publicUrl}
                  className="h-auto w-auto rounded-xl border border-white/10 bg-black object-contain shadow-[0_18px_50px_rgba(0,0,0,0.42)]"
                  style={mediaStyle}
                  controls
                  autoPlay
                />
              )}
              {isAudio && (
                <div className="w-full max-w-3xl rounded-2xl border border-cyan-100/15 bg-white/[0.06] p-5">
                  <p className="mb-3 text-sm font-semibold text-white">完整音频预览</p>
                  <audio src={currentMediaUrl} className="w-full" controls autoPlay />
                </div>
              )}
              {isText && !isVideo && !isAudio && (
                <pre className="max-h-[72vh] w-full whitespace-pre-wrap rounded-2xl bg-zinc-50 p-5 text-sm leading-7 text-zinc-800">
                  {nodePreviewText(node)}
                </pre>
              )}
            </div>
            {hasDetails && (
              <div className="shrink-0 border-t border-cyan-100/12 bg-black/15 px-4 py-2.5 sm:px-5">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left text-xs font-medium text-slate-200 transition hover:text-white"
                  onClick={() => setDetailsOpen((current) => !current)}
                  aria-expanded={detailsOpen}
                >
                  <span>图片说明与本地文件位置</span>
                  <span className="text-slate-300/65">{detailsOpen ? "收起" : "展开"}</span>
                </button>
                {detailsOpen && (
                  <div className="mt-2 max-h-[18dvh] space-y-2 overflow-auto text-xs leading-relaxed text-slate-300/75">
                    {node.description && <div>{node.description}</div>}
                    <LocalFilePath filePath={node.filePath} publicUrl={node.publicUrl} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DisconnectEdgesDialog({
  open,
  edgeCount,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  edgeCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000002] flex items-center justify-center bg-[#02070c]/78 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disconnect-board-edges-title"
      onClick={onCancel}
    >
      <section
        className="w-full max-w-[520px] overflow-hidden rounded-[26px] border border-cyan-100/20 bg-[linear-gradient(145deg,rgba(25,55,68,0.98),rgba(8,23,33,0.98))] text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.52)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-300/10 text-amber-100">
              <LuGitBranch className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 id="disconnect-board-edges-title" className="text-base font-semibold tracking-[0.01em]">断开全部连线</h2>
              <p className="mt-1 text-xs text-slate-300/75">只移除连线，不删除节点和本地文件</p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-xl p-2 text-slate-300/70 transition hover:bg-white/10 hover:text-white"
            onClick={onCancel}
            aria-label="关闭断开连线窗口"
          >
            <LuX className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5 sm:px-6">
          <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-sm leading-6 text-amber-50">
            确定断开当前画板全部 <span className="font-semibold">{edgeCount}</span> 条连线吗？节点和本地文件都会保留。
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-cyan-100/10 pt-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              <LuGitBranch className="mr-1.5 h-4 w-4" />
              断开全部连线
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function DeleteNodeDialog({
  node,
  connectedEdgeCount,
  managedFileCount,
  alsoDeleteFiles,
  isNodeRunning,
  canCancelRunningTask,
  isDeleting,
  error,
  onAlsoDeleteFilesChange,
  onCancel,
  onCancelRunningTask,
  onConfirm,
}: {
  node: BoardWorkflowNode | null;
  connectedEdgeCount: number;
  managedFileCount: number;
  alsoDeleteFiles: boolean;
  isNodeRunning: boolean;
  canCancelRunningTask: boolean;
  isDeleting: boolean;
  error: string;
  onAlsoDeleteFilesChange: (value: boolean) => void;
  onCancel: () => void;
  onCancelRunningTask: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!node) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isDeleting) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDeleting, node, onCancel]);

  if (!node) return null;

  const title = displayTitle(node);

  return (
    <div
      className="fixed inset-0 z-[1000002] flex items-center justify-center bg-[#02070c]/78 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-board-node-title"
      onClick={onCancel}
    >
      <section
        className="w-full max-w-[520px] overflow-hidden rounded-[26px] border border-cyan-100/20 bg-[linear-gradient(145deg,rgba(25,55,68,0.98),rgba(8,23,33,0.98))] text-slate-100 shadow-[0_28px_100px_rgba(0,0,0,0.52)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-cyan-100/12 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-300/25 bg-red-400/10 text-red-200">
              <LuTrash2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 id="delete-board-node-title" className="text-base font-semibold tracking-[0.01em]">移除画板节点</h2>
              <p className="mt-1 text-xs text-slate-300/75">节点、连线和本地文件分开处理</p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-xl p-2 text-slate-300/70 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onCancel}
            disabled={isDeleting}
            aria-label="关闭删除窗口"
          >
            <LuX className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5 sm:px-6">
          <div className="rounded-2xl border border-cyan-100/14 bg-black/15 px-4 py-3">
            <p className="truncate text-sm font-semibold text-white">{title}</p>
            <p className="mt-1 text-xs leading-5 text-slate-300/80">
              将从当前画板移除，并断开 {connectedEdgeCount} 条连线。
            </p>
          </div>

          {isNodeRunning ? (
            <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-50">
              此节点正在执行。为避免晚返回结果重新写入画板，请先取消当前任务，再移除节点。
            </div>
          ) : (
            <p className="text-sm leading-6 text-slate-200/90">
              默认仅移除画板上的节点与连线；商品库、人物包和外部原始素材都会保留。
            </p>
          )}

          {managedFileCount > 0 && (
            <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
              alsoDeleteFiles ? "border-cyan-200/45 bg-cyan-300/10" : "border-cyan-100/15 bg-white/[0.035] hover:bg-white/[0.06]"
            } ${isNodeRunning || isDeleting ? "cursor-not-allowed opacity-50" : ""}`}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-cyan-400"
                checked={alsoDeleteFiles}
                disabled={isNodeRunning || isDeleting}
                onChange={(event) => onAlsoDeleteFilesChange(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-100">同时清理 {managedFileCount} 个关联本地文件</span>
                <span className="mt-1 block text-xs leading-5 text-slate-300/75">
                  仅会删除当前画板的托管目录或归档目录中的文件；外部原始素材会自动保留。
                </span>
              </span>
            </label>
          )}

          {error && (
            <p className="rounded-xl border border-red-300/25 bg-red-400/10 px-3 py-2 text-sm leading-5 text-red-100">{error}</p>
          )}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-cyan-100/12 bg-black/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isDeleting} className="border-cyan-100/20 bg-white/[0.04] text-slate-100 hover:bg-white/[0.1] hover:text-white">
            取消
          </Button>
          {isNodeRunning && canCancelRunningTask && (
            <Button type="button" variant="outline" onClick={onCancelRunningTask} disabled={isDeleting} className="border-amber-200/30 bg-amber-300/10 text-amber-50 hover:bg-amber-300/20 hover:text-amber-50">
              取消当前任务
            </Button>
          )}
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting || isNodeRunning}
            className="bg-red-500 text-white hover:bg-red-600"
          >
            {isDeleting ? <LuLoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <LuTrash2 className="mr-1.5 h-4 w-4" />}
            从画板移除
          </Button>
        </footer>
      </section>
    </div>
  );
}




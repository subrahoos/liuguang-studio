import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  BoardWorkflowRevisionConflictError,
  createEdge,
  createNode,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualDirectInputNodeIds,
  startNodeExecution,
  updateBoardWorkflow,
  updateNodeExecution,
  writeBoardBuffer,
  type BoardVideoJob,
  type BoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import { isBoardOutputRecoverySuppressed } from "@/lib/board-output-recovery";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { uniqueStrings } from "@/lib/prompt-dedup";
import {
  encodeAudioFileForVideoReference,
  encodeImageFileForVideoReference,
  encodeVideoFileForVideoReference,
} from "@/lib/video-reference-images";
import {
  boardVideoReferenceNodes,
  bindDirectVideoReplacementMediaAliases,
  buildDirectVideoReplacementPrompt,
  buildVideoPromptWithReferenceResponsibilities,
  directVideoReplacementPackageFromNodes,
  grokReferencePackageFromNodes,
  isDirectVideoReplacementAudioReference,
  isDirectVideoReplacementVideoReference,
  isVideoFaceReference,
  isVideoModelReference,
  isVideoVisualBase,
  usesVideoReferenceRolePackage,
} from "@/lib/video-reference-contract";
import { getBoardVideoProfile, normalizeBoardVideoResolution } from "@/lib/board-video-protocol";
import {
  cleanupCloudinaryVideoReferences,
  unverifiedCloudinaryVideoReferenceCleanup,
} from "@/lib/cloudinary-video-reference-hosting";
import type { CloudinaryReferenceCleanup } from "@/lib/video-reference-hosting-types";
import { isLingganyaFileId } from "@/lib/lingganya-reference-files";
import {
  isLingganyaTemporaryFileReferenceChannel,
  prepareVideoReferencesForChannel,
  type PreparedVideoReferenceBatch,
} from "@/lib/video-reference-transport";
import { resolveVideoChannel, resolveVideoReferenceHosting } from "@/lib/server-model-settings";
import {
  assertCurrentBoardVideoChannel,
  assertBoardVideoPromptWithinLimit,
  downloadRjmusGrokVideo,
  getRjmusGrokVideoStatus,
  isRetryableRjmusVideoError,
  isTransientVideoPollInterruption,
  RjmusGrokVideoError,
  submitRjmusGrokVideo,
  verifyRjmusGrokVideoChannel,
} from "@/lib/rjmus-grok-video";
import {
  readStoredVideoShotSegmentPlan,
} from "@/lib/video-shot-segments";
import {
  directorPromptRequiresAudio,
  VIDEO_DIRECTOR_SCHEMA_VERSION,
} from "@/lib/video-director-contract";
import { probeVideoMedia } from "@/lib/video-media-probe";
import { validateBoardVideoOutput } from "@/lib/board-video-output-contract";
import type { VideoModelChannel } from "@/lib/stores/settings-store";
import { auditModelApiCall } from "@/lib/model-api-audit";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const VIDEO_MAIN_REFERENCE_BYTES = 1_500 * 1024;
const VIDEO_PRODUCT_REFERENCE_BYTES = 1_200 * 1024;
const VIDEO_FACE_REFERENCE_BYTES = 1_200 * 1024;
const VIDEO_MODEL_REFERENCE_BYTES = 1_200 * 1024;
const VIDEO_SCENE_REFERENCE_BYTES = 1_000 * 1024;
const inFlightVideoSubmissions = new Set<string>();
const inFlightVideoPolls = new Set<string>();

interface DirectorPlan {
  segmentPrompts?: Array<{
    segmentIndex?: number;
    timeRange?: string;
    outputTimeRange?: string;
    duration?: number;
    promptEnglish?: string;
    editorialTimingLock?: string;
  }>;
}

function roleOf(node?: BoardWorkflowNode) {
  return String(node?.meta?.assetRole || "");
}

function activeVideoJob(node?: BoardWorkflowNode) {
  return node?.execution?.videoJob;
}

function isActiveJob(job?: BoardVideoJob) {
  return Boolean(job && ["submitted", "queued", "running", "completed_pending_content"].includes(job.status));
}

function readPosition(body: Record<string, unknown>, fallbackX: number, fallbackY: number) {
  const x = Number(body.x ?? fallbackX);
  const y = Number(body.y ?? fallbackY);
  return {
    x: Number.isFinite(x) ? x : fallbackX,
    y: Number.isFinite(y) ? y : fallbackY,
  };
}

function videoReferenceTargetBytes(node: BoardWorkflowNode) {
  if (isVideoVisualBase(node)) return VIDEO_MAIN_REFERENCE_BYTES;
  if (["product_image", "product_evidence_board"].includes(roleOf(node))) return VIDEO_PRODUCT_REFERENCE_BYTES;
  if (isVideoFaceReference(node)) return VIDEO_FACE_REFERENCE_BYTES;
  if (isVideoModelReference(node)) return VIDEO_MODEL_REFERENCE_BYTES;
  return VIDEO_SCENE_REFERENCE_BYTES;
}

async function nodeToReference(node: BoardWorkflowNode, targetBytes: number) {
  if (node.filePath) return encodeImageFileForVideoReference(node.filePath, { targetBytes });
  return node.publicUrl || "";
}

function directorSegment(directorNode: BoardWorkflowNode, segmentIndex: number) {
  const parsed = directorNode.meta?.parsed as DirectorPlan | undefined;
  return parsed?.segmentPrompts?.find((segment) => Number(segment.segmentIndex) === segmentIndex);
}

function selectExecutionInputs(workflow: BoardWorkflow, executorNodeId: string, channel: VideoModelChannel) {
  const executorNode = workflow.nodes.find((node) => node.id === executorNodeId);
  if (String(executorNode?.meta?.controlRole || "") !== "video_generate") {
    throw new RjmusGrokVideoError("请从画板中的视频生成节点执行任务。", "INVALID_EXECUTOR");
  }
  const directIds = manualDirectInputNodeIds(workflow, executorNodeId);
  const directNodes = directIds
    .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  const profile = getBoardVideoProfile(channel);
  if (!profile) {
    throw new RjmusGrokVideoError("当前视频模型没有画板协议配置。", "UNSUPPORTED_MODEL");
  }
  const directors = directNodes.filter((node) => roleOf(node) === "video_director_prompt");
  if (directors.length !== 1) {
    throw new RjmusGrokVideoError("请手动连线且仅连线 1 个最新完整视频导演稿。", "INVALID_DIRECTOR");
  }
  const directorNode = directors[0];
  if (Number(directorNode.meta?.directorSchemaVersion || 0) !== VIDEO_DIRECTOR_SCHEMA_VERSION) {
    throw new RjmusGrokVideoError("当前完整视频导演稿不是最新版本，请重新生成。", "STALE_DIRECTOR");
  }
  const references = directNodes.filter((node) => node.id !== directorNode.id);
  // A task can choose a different visual base / scene from the same manually
  // connected candidate pool. The chosen package is validated below.
  if (usesVideoReferenceRolePackage(channel)) {
    const packageResult = grokReferencePackageFromNodes(references);
    if (!packageResult.package) {
      throw new RjmusGrokVideoError(
        packageResult.error || "当前视频模型需要完整的五张参考图包。",
        "INVALID_REFERENCES",
      );
    }
    return {
      executorNode: executorNode!,
      directorNode,
      referenceNodes: packageResult.package.ordered,
    };
  }
  const visualBases = references.filter(isVideoVisualBase);
  if (visualBases.length !== 1 || references.length !== 1) {
    throw new RjmusGrokVideoError(
      visualBases.length === 0
        ? "Grok 视频任务需要且只接受 1 张合成主图或修复图。"
        : "Grok 视频任务只接受 1 张合成主图或修复图；请移除其他直连参考图。",
      "INVALID_REFERENCES",
    );
  }
  return {
    executorNode: executorNode!,
    directorNode,
    referenceNodes: visualBases,
  };
}

function selectedReferencesForTask(
  candidates: BoardWorkflowNode[],
  requestedIds: string[],
  channel: VideoModelChannel,
) {
  const requested = uniqueStrings(requestedIds);
  if (requested.length === 0) {
    throw new RjmusGrokVideoError("请先为该视频任务选择参考图。", "MISSING_TASK_REFERENCES");
  }
  const candidateById = new Map(candidates.map((node) => [node.id, node]));
  const selected = requested.map((id) => candidateById.get(id)).filter((node): node is BoardWorkflowNode => Boolean(node));
  if (selected.length !== requested.length) {
    throw new RjmusGrokVideoError("任务参考图必须来自当前视频节点的手动直连素材，请刷新画板后重试。", "STALE_REFERENCES");
  }

  const profile = getBoardVideoProfile(channel);
  if (!profile) throw new RjmusGrokVideoError("当前视频模型没有画板协议配置。", "UNSUPPORTED_MODEL");
  if (usesVideoReferenceRolePackage(channel)) {
    const packageResult = grokReferencePackageFromNodes(selected);
    if (!packageResult.package) {
      throw new RjmusGrokVideoError(packageResult.error || "当前任务需要完整、无重复的职责参考图包。", "INVALID_REFERENCES");
    }
    return packageResult.package.ordered;
  }

  const visualBases = selected.filter(isVideoVisualBase);
  if (visualBases.length !== 1 || selected.length !== 1) {
    throw new RjmusGrokVideoError("当前模型只接受 1 张合成主图或修复图作为本任务参考图。", "INVALID_REFERENCES");
  }
  return boardVideoReferenceNodes(visualBases, channel);
}

async function nodeToVideoReference(node: BoardWorkflowNode) {
  if (!isDirectVideoReplacementVideoReference(node)) return "";
  if (node.filePath) return encodeVideoFileForVideoReference(node.filePath);
  return /^https:\/\//i.test(String(node.publicUrl || "")) ? String(node.publicUrl).trim() : "";
}

async function nodeToAudioReference(node: BoardWorkflowNode) {
  if (!isDirectVideoReplacementAudioReference(node)) return "";
  if (node.filePath) return encodeAudioFileForVideoReference(node.filePath);
  return /^https:\/\//i.test(String(node.publicUrl || "")) ? String(node.publicUrl).trim() : "";
}

async function directReferenceVideoDuration(node: BoardWorkflowNode, maxSeconds: number) {
  if (!node.filePath) {
    throw new RjmusGrokVideoError("直接参考视频替换只接受已落盘的画板本地视频，无法核验时长的公网链接不能提交。", "UNVERIFIED_REFERENCE_VIDEO");
  }
  const media = await probeVideoMedia(node.filePath);
  const durationSeconds = Number(media.durationSeconds || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RjmusGrokVideoError("无法读取参考视频时长，请重新导入有效的 MP4、WebM 或 MOV 文件。", "INVALID_REFERENCE_DURATION");
  }
  // ffprobe containers often report a few frames beyond the intended endpoint.
  if (durationSeconds > maxSeconds + 0.25) {
    throw new RjmusGrokVideoError(
      `参考视频为 ${durationSeconds.toFixed(2)} 秒，超过当前通道单任务 ${maxSeconds} 秒；请先截取不超过 ${maxSeconds} 秒的参考片段。`,
      "REFERENCE_VIDEO_TOO_LONG",
    );
  }
  return durationSeconds;
}

function segmentPlanForDirector(
  directorNode: BoardWorkflowNode,
  segmentIndex: number,
  generationSeconds: number,
) {
  const plans = readStoredVideoShotSegmentPlan(directorNode.meta?.segmentPlan, generationSeconds);
  if (!plans) {
    throw new RjmusGrokVideoError("完整视频导演稿缺少当前镜头切点分段计划，请重新生成导演稿。", "STALE_SEGMENT_PLAN");
  }
  const plan = plans.find((segment) => segment.index === segmentIndex);
  const prompt = directorSegment(directorNode, segmentIndex);
  if (!plan || !prompt?.promptEnglish?.trim()) {
    throw new RjmusGrokVideoError("完整视频导演稿没有覆盖当前任务，请重新生成导演稿。", "MISSING_SEGMENT");
  }
  if (
    String(prompt.timeRange || "").trim() !== plan.sourceTimeRange
    || String(prompt.outputTimeRange || "").trim() !== plan.outputTimeRange
    || Number(prompt.duration) !== generationSeconds
  ) {
    throw new RjmusGrokVideoError("完整视频导演稿的任务时间范围与当前时长计划不一致，请重新生成。", "STALE_SEGMENT_PLAN");
  }
  return {
    plan,
    plans,
    promptEnglish: prompt.promptEnglish.trim(),
    editorialTimingLock: String(prompt.editorialTimingLock || "").trim(),
  };
}

async function appendVideoDebugLog(localDir: string, event: string, payload: Record<string, unknown> = {}) {
  if (!localDir) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  const diagnosticsDir = path.join(localDir, "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true }).catch(() => undefined);
  await appendFile(path.join(diagnosticsDir, "video.log"), `${line}\n`, "utf8").catch(() => undefined);
}

async function currentVideoChannel(
  req: NextRequest,
  incoming: Partial<VideoModelChannel> | null | undefined,
  channelId: string,
) {
  const channel = await resolveVideoChannel(req, incoming, channelId, "full_video");
  if (!channel) throw new RjmusGrokVideoError("找不到当前视频模型通道。", "MISSING_CHANNEL");
  if (channelId && channel.id !== channelId) {
    throw new RjmusGrokVideoError("原视频任务使用的模型通道已不可用，不能改用其他通道查询同一任务。", "CHANNEL_CHANGED");
  }
  assertCurrentBoardVideoChannel(channel);
  return channel;
}

async function patchJob(
  workflowId: string,
  executorNodeId: string,
  job: BoardVideoJob,
  summary: string,
) {
  // The upstream task has already been created when this function runs. A
  // concurrent canvas PATCH must not turn a transient revision conflict into a
  // lost task ID (and an unrecoverable paid task), so use the same bounded
  // retry policy as terminal video writes.
  return updateVideoExecutionWithRetry(workflowId, executorNodeId, {
    status: "running",
    summary,
    error: "",
    videoJob: job,
  }, "running");
}

async function cancelledVideoSubmissionWorkflow(
  req: NextRequest,
  workflowId: string,
  executorNodeId: string,
  clientTaskId: string,
  hostedReferences: BoardVideoJob["hostedReferences"],
  submittedJob?: BoardVideoJob,
  temporaryReferences?: { uploadCount: number; expiresAt?: string },
) {
  const current = await getBoardWorkflow(workflowId);
  const executor = current?.nodes.find((node) => node.id === executorNodeId);
  const execution = executor?.execution;
  const supersededByAnotherRun = Boolean(
    clientTaskId
    && execution?.status === "running"
    && execution?.clientTaskId
    && execution.clientTaskId !== clientTaskId,
  );
  const cancellationMatchesThisRun = Boolean(
    execution?.status === "cancelled"
    && (!clientTaskId || execution.clientTaskId === clientTaskId),
  );
  const cancelled = Boolean(
    !current
    || !executor
    || isBoardTaskCancelled(workflowId, clientTaskId)
    || cancellationMatchesThisRun
    || supersededByAnotherRun,
  );
  if (!cancelled || !current || !executor || !execution) return null;

  const cleanup = await cleanupHostedReferences(req, current, hostedReferences).catch(() => undefined);
  const cancelledJob = submittedJob
    ? {
        ...submittedJob,
        status: "cancelled" as const,
        lastPolledAt: new Date().toISOString(),
        ...(cleanup ? { referenceCleanup: cleanup } : {}),
    }
    : undefined;
  const lingganyaSummary = submittedJob?.referenceTransport === "lingganya_file_id"
    ? lingganyaTemporaryReferenceSummary(submittedJob.referenceUploadCount || 0, submittedJob.referenceExpiresAt)
    : lingganyaTemporaryReferenceSummary(temporaryReferences?.uploadCount || 0, temporaryReferences?.expiresAt);
  const cleanupSummary = [cleanup ? cleanupAuditSummary(cleanup) : "", lingganyaSummary]
    .filter(Boolean)
    .join(" ");
  return updateNodeExecution(workflowId, executorNodeId, {
    ...execution,
    status: "cancelled",
    finishedAt: execution.finishedAt || new Date().toISOString(),
    summary: submittedJob
      ? `用户取消，远端任务不再写回画板。${cleanupSummary ? ` ${cleanupSummary}` : ""}`
      : `用户取消，已停止提交。${cleanupSummary ? ` ${cleanupSummary}` : ""}`,
    error: "",
    ...(cleanup ? { referenceCleanup: cleanup } : {}),
    ...(cancelledJob ? { videoJob: cancelledJob } : {}),
  }, "pending") || current;
}

/**
 * A browser can persist a canvas snapshot while the server is writing a task
 * terminal state. Retry only revision conflicts so a failed upstream task
 * cannot remain visually running just because a position update won a race.
 */
async function updateVideoExecutionWithRetry(
  workflowId: string,
  executorNodeId: string,
  patch: NonNullable<BoardWorkflowNode["execution"]>,
  status: BoardWorkflowNode["status"],
) {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await updateNodeExecution(workflowId, executorNodeId, patch, status);
    } catch (error) {
      if (!(error instanceof BoardWorkflowRevisionConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict instanceof Error ? lastConflict : new Error("视频任务终态写回时发生画板版本冲突。");
}

async function cleanupHostedReferences(
  req: NextRequest,
  workflow: BoardWorkflow,
  assets: BoardVideoJob["hostedReferences"],
) {
  if (assets.length === 0) return undefined;
  const setting = await resolveVideoReferenceHosting(req).catch(() => null);
  const cleanup = setting
    ? await cleanupCloudinaryVideoReferences(setting, assets).catch((error) =>
      unverifiedCloudinaryVideoReferenceCleanup(
        assets,
        error instanceof Error ? error.message : String(error),
      ))
    : unverifiedCloudinaryVideoReferenceCleanup(
      assets,
      "未能读取 Cloudinary 配置，未能核实临时参考文件是否已清理。",
    );
  await appendVideoDebugLog(workflow.localDir, "reference_images_cleanup", { ...cleanup });
  return cleanup;
}

function cleanupAuditSummary(cleanup: CloudinaryReferenceCleanup) {
  if (cleanup.status === "confirmed") {
    return `Cloudinary 临时参考已确认不存在：删除 ${cleanup.deleted} 个，原本不存在 ${cleanup.alreadyAbsent} 个。`;
  }
  if (cleanup.status === "partial_failure") {
    return `Cloudinary 临时参考清理未完成：删除 ${cleanup.deleted} 个，已不存在 ${cleanup.alreadyAbsent} 个，失败 ${cleanup.failed} 个。`;
  }
  return "Cloudinary 临时参考未能核实是否已清理。";
}

function earliestReferenceExpiry(batches: Array<PreparedVideoReferenceBatch | null>) {
  return batches
    .map((batch) => batch?.expiresAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function lingganyaTemporaryReferenceSummary(uploadCount: number, expiresAt?: string) {
  if (uploadCount <= 0) return "";
  const expiry = expiresAt && Number.isFinite(Date.parse(expiresAt))
    ? new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })
    : "上传成功后24小时";
  return `灵感鸭临时参考已上传 ${uploadCount} 个，将于 ${expiry} 自动失效。`;
}

async function cleanupJobReferences(
  req: NextRequest,
  workflow: BoardWorkflow,
  executorNodeId: string,
  job: BoardVideoJob,
) {
  if (job.hostedReferences.length === 0 || job.referenceCleanup?.completedAt) return workflow;
  const cleanup = await cleanupHostedReferences(req, workflow, job.hostedReferences);
  if (!cleanup) return workflow;

  const latest = await getBoardWorkflow(workflow.id) || workflow;
  const executor = latest.nodes.find((node) => node.id === executorNodeId);
  const latestJob = executor?.execution?.videoJob;
  if (!executor?.execution || latestJob?.taskId !== job.taskId) return latest;
  return updateNodeExecution(workflow.id, executorNodeId, {
    ...executor.execution,
    referenceCleanup: cleanup,
    videoJob: {
      ...latestJob,
      referenceCleanup: cleanup,
    },
  }, executor.status) || latest;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient_user_quota|quota|credit|balance|额度不足|余额不足|预扣/i.test(message)) {
    return `视频模型额度不足：${message}`;
  }
  return message || "视频生成失败";
}

function isStoredOutputMismatch(job: BoardVideoJob) {
  return job.status === "failed"
    && job.outputValidation?.valid === false
    && Boolean(job.outputValidation.diagnosticFilePath);
}

function outputMismatchMessage(job: BoardVideoJob) {
  if (job.lastError?.trim()) return job.lastError.trim();
  const violations = job.outputValidation?.violations || [];
  return `上游回传视频不符合本次任务规格：${violations.join("；") || "请核对回传文件。"}`;
}

/**
 * A provider can finish successfully while returning a file that does not match
 * the requested duration / frame. Keep that file for review, but give it a
 * distinct role so the compose endpoint can never treat it as a valid segment.
 */
async function materializeOutputMismatch(
  req: NextRequest,
  workflow: BoardWorkflow,
  executorNode: BoardWorkflowNode,
  job: BoardVideoJob,
  filePath: string,
  message: string,
) {
  const validation = job.outputValidation;
  if (!validation || validation.valid || !filePath || !existsSync(filePath)) {
    throw new RjmusGrokVideoError("规格不符的视频文件不存在，无法写入画板供核对。", "MISSING_DIAGNOSTIC_VIDEO", 500);
  }

  const latest = await getBoardWorkflow(workflow.id) || workflow;
  if (isBoardOutputRecoverySuppressed(
    latest,
    "video_output_mismatch",
    job.taskId,
    executorNode.id,
  )) {
    return { workflow: latest, node: undefined, suppressed: true as const };
  }
  const existing = latest.nodes.find((node) =>
    String(node.meta?.taskId || "") === job.taskId
      && String(node.meta?.assetRole || "") === "video_output_mismatch"
      && Boolean(node.filePath),
  );
  const mismatchNode = existing || createNode({
    kind: "video_clip",
    title: `回传规格不符 · ${job.resultTitle}`,
    description: `本地已保存，供人工核对；禁止参与成片合成。${validation.violations.join("；")}`,
    filePath,
    publicUrl: boardFilePublicUrl(workflow.id, filePath),
    promptEnglish: job.promptEnglish,
    status: "failed",
    error: message,
    meta: {
      assetRole: "video_output_mismatch",
      provider: "video-output-validation",
      channelId: job.channelId,
      channelName: job.channelName,
      model: job.model,
      executionMode: job.executionMode || "director_segments",
      capabilitySignature: job.capabilitySignature,
      requestId: job.requestId,
      upstreamRequestId: job.upstreamRequestId,
      taskId: job.taskId,
      directorNodeId: job.directorNodeId,
      directorSchemaVersion: job.directorSchemaVersion,
      referenceNodeIds: job.referenceNodeIds,
      audioReferenceNodeId: job.audioReferenceNodeId,
      segmentIndex: job.segmentIndex,
      segmentCount: job.segmentCount,
      generationDuration: job.generationDuration,
      sourceDuration: job.sourceDuration,
      sourceTimeRange: job.sourceTimeRange,
      outputDuration: job.outputDuration,
      outputTimeRange: job.outputTimeRange,
      requestedTotalDuration: job.requestedTotalDuration,
      plannedOutputDuration: job.plannedOutputDuration,
      executorNodeId: executorNode.id,
      aspectRatio: validation.expected.aspectRatio,
      resolution: validation.expected.resolution,
      actualDuration: validation.actual.durationSeconds,
      width: validation.actual.width,
      height: validation.actual.height,
      hasAudio: validation.actual.hasAudio,
      outputValidation: validation,
      blockedFromComposition: true,
    },
    x: job.x,
    y: job.y,
  });

  const persisted = existing
    ? latest
    : await updateBoardWorkflow(workflow.id, {
      nodes: [...latest.nodes, mismatchNode],
      edges: [
        ...latest.edges,
        ...(job.directorNodeId ? [createEdge(job.directorNodeId, mismatchNode.id, "视频生成规格核对")] : []),
        createEdge(executorNode.id, mismatchNode.id, "回传结果（规格不符）"),
        ...job.referenceNodeIds.map((referenceId) => createEdge(referenceId, mismatchNode.id, job.executionMode === "direct_video_replacement" ? "参考素材" : "参考图")),
      ],
    }, latest.revision ?? 0);

  const failedJob: BoardVideoJob = {
    ...job,
    status: "failed",
    lastError: message,
    lastPolledAt: new Date().toISOString(),
    outputNodeIds: [mismatchNode.id],
    outputValidation: {
      ...validation,
      checkedAt: validation.checkedAt || new Date().toISOString(),
      diagnosticFilePath: filePath,
    },
  };
  await failNodeExecution(workflow.id, executorNode.id, executorNode.execution?.inputNodeIds || [], message);
  const final = await updateNodeExecution(workflow.id, executorNode.id, {
    status: "failed",
    summary: "视频已保存到本地并写入画板；回传规格不符，不能参与合成。",
    error: message,
    videoJob: failedJob,
    outputNodeIds: [mismatchNode.id],
  }, "failed") || persisted;
  const cleaned = await cleanupJobReferences(req, final, executorNode.id, failedJob);
  clearBoardTaskCancellation(workflow.id, executorNode.execution?.clientTaskId);
  await appendVideoDebugLog(workflow.localDir, "output_contract_mismatch_saved", {
    taskId: job.taskId,
    filePath,
    expected: validation.expected,
    actual: validation.actual,
    violations: validation.violations,
    canvasNodeId: mismatchNode.id,
  });
  return { workflow: cleaned, node: mismatchNode, suppressed: false as const };
}

function isLingganyaStatusPermissionDelay(error: unknown, channel: VideoModelChannel) {
  return getBoardVideoProfile(channel)?.protocol === "lingganya"
    && error instanceof RjmusGrokVideoError
    && error.statusCode === 403;
}

/**
 * Channel-isolated path for multimedia replacement models. The reference
 * video supplies motion/camera/timing; this channel's saved image contract
 * supplies only the visual domains to replace. It deliberately has no director, segment, or compose
 * dependency.
 */
async function submitDirectVideoReplacementTask(
  req: NextRequest,
  workflow: BoardWorkflow,
  userId: string,
  body: Record<string, unknown>,
  channel: VideoModelChannel,
) {
  const executorNodeId = String(body.executorNodeId || "");
  const clientTaskId = String(body.clientTaskId || "");
  const channelProfile = getBoardVideoProfile(channel);
  if (!channelProfile?.directVideoReplacement) {
    throw new RjmusGrokVideoError("当前视频通道未配置直接参考视频替换能力。", "UNSUPPORTED_DIRECT_MODE");
  }
  const rawResolution = typeof body.resolution === "string" ? body.resolution.trim() : "";
  const requestedResolution = rawResolution ? normalizeBoardVideoResolution(rawResolution) : null;
  if (rawResolution && (!requestedResolution || !channelProfile.resolutionOptions.includes(requestedResolution))) {
    throw new RjmusGrokVideoError("本次输出分辨率不在当前视频通道允许的选项中。", "INVALID_RESOLUTION");
  }
  const profile = requestedResolution
    ? getBoardVideoProfile({ ...channel, resolution: requestedResolution })
    : channelProfile;
  if (!profile) throw new RjmusGrokVideoError("当前视频模型没有画板协议配置。", "UNSUPPORTED_MODEL");
  const rawGenerationSeconds = body.generationSeconds;
  const generationSeconds = rawGenerationSeconds === undefined || rawGenerationSeconds === null || String(rawGenerationSeconds).trim() === ""
    ? profile.generationSeconds
    : Math.round(Number(rawGenerationSeconds));
  if (!profile.durationOptions.includes(generationSeconds)) {
    throw new RjmusGrokVideoError("本次生成时长不在当前视频通道声明的可用秒数中。", "INVALID_DURATION");
  }
  const executorNode = workflow.nodes.find((node) => node.id === executorNodeId);
  if (String(executorNode?.meta?.controlRole || "") !== "video_generate") {
    throw new RjmusGrokVideoError("请从画板中的视频生成节点执行任务。", "INVALID_EXECUTOR");
  }
  const directIds = manualDirectInputNodeIds(workflow, executorNodeId);
  const candidates = directIds
    .map((nodeId) => workflow.nodes.find((node) => node.id === nodeId))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  const requestedReferenceIds = Array.isArray(body.referenceNodeIds)
    ? uniqueStrings(body.referenceNodeIds.filter((value): value is string => typeof value === "string"))
    : [];
  const candidateById = new Map(candidates.map((node) => [node.id, node]));
  const selectedNodes = requestedReferenceIds
    .map((nodeId) => candidateById.get(nodeId))
    .filter((node): node is BoardWorkflowNode => Boolean(node));
  if (selectedNodes.length !== requestedReferenceIds.length) {
    throw new RjmusGrokVideoError("参考素材必须来自当前视频节点的手动直连节点；请刷新画板后重新选择。", "STALE_REFERENCES");
  }
  const packageResult = directVideoReplacementPackageFromNodes(selectedNodes, {
    sceneOptional: profile.directVideoReplacementSceneOptional,
    faceOptional: profile.directVideoReplacementFaceOptional,
    referenceContract: profile.directVideoReplacementReferenceContract,
  });
  if (!packageResult.package) {
    const rawProductFrontContract = profile.directVideoReplacementReferenceContract === "product_front_face";
    throw new RjmusGrokVideoError(
      packageResult.error || (profile.directVideoReplacementSceneOptional
        ? rawProductFrontContract
          ? profile.directVideoReplacementFaceOptional
            ? "请连接 1 条参考视频和商品正面图；人脸图、场景图可选。"
            : "请连接 1 条参考视频、商品正面图和人脸图；场景图可选。"
          : "请连接 1 条参考视频和商品、人脸、人物各 1 张图；场景图可选。"
        : rawProductFrontContract
          ? profile.directVideoReplacementFaceOptional
            ? "请连接 1 条参考视频、商品正面图和场景图；人脸图可选。"
            : "请连接 1 条参考视频、商品正面图、人脸图和场景图。"
          : "请连接 1 条参考视频和商品、人脸、人物、场景各 1 张图。"),
      "INVALID_REFERENCES",
    );
  }
  const replacement = packageResult.package;
  const requestedAudioNodeId = String(body.audioNodeId || "").trim();
  const audioNode = requestedAudioNodeId ? candidateById.get(requestedAudioNodeId) : undefined;
  if (requestedAudioNodeId && !audioNode) {
    throw new RjmusGrokVideoError("参考音频必须来自当前视频节点的手动直连节点；请刷新画板后重新选择。", "STALE_AUDIO_REFERENCE");
  }
  if (audioNode && profile.maxReferenceAudios < 1) {
    throw new RjmusGrokVideoError("当前视频通道未声明参考音频能力，不能发送已连接的音频。", "UNSUPPORTED_AUDIO_REFERENCE");
  }
  if (audioNode && !isDirectVideoReplacementAudioReference(audioNode)) {
    throw new RjmusGrokVideoError("参考音频必须是已落盘的音频节点。", "INVALID_AUDIO_REFERENCE");
  }
  const referenceDuration = await directReferenceVideoDuration(replacement.referenceVideo, generationSeconds);
  const referenceNodeIds = [...replacement.ordered.map((node) => node.id), ...(audioNode ? [audioNode.id] : [])];
  const baseExecutionPrompt = buildDirectVideoReplacementPrompt(
    Boolean(audioNode),
    profile.directVideoReplacementPromptLanguage,
    Boolean(replacement.scene),
    profile.directVideoReplacementReferenceContract,
    Boolean(replacement.face),
    profile.directVideoReplacementFaceOptional,
    generationSeconds,
    referenceDuration,
    profile.protocol === "mikoto_sora",
    profile.directVideoReplacementPromptVersion,
  );
  const executionPrompt = profile.protocol === "lingganya"
    && ["sd-2.0-vip", "sd-2.0-g"].includes(channel.model.trim().toLowerCase())
    ? bindDirectVideoReplacementMediaAliases(baseExecutionPrompt, profile.directVideoReplacementPromptLanguage)
    : baseExecutionPrompt;
  assertBoardVideoPromptWithinLimit(channel.model, executionPrompt);
  const existingJob = activeVideoJob(executorNode);
  if (isActiveJob(existingJob)) {
    return NextResponse.json({
      error: `该节点已有远端任务 ${existingJob!.taskId}，正在自动恢复，不能重复创建付费任务。`,
      workflow,
      pending: true,
      taskId: existingJob!.taskId,
    }, { status: 409 });
  }

  const submissionKey = `${workflow.id}:${executorNodeId}:direct-video-replacement`;
  if (inFlightVideoSubmissions.has(submissionKey)) {
    return NextResponse.json({ error: "相同视频替换任务正在提交，请稍候。", workflow }, { status: 409 });
  }
  const channelCheck = await verifyRjmusGrokVideoChannel({
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    model: channel.model,
    videoProtocol: channel.videoProtocol,
    submitPath: channel.submitPath,
    statusPath: channel.statusPath,
    contentPath: channel.contentPath,
    durationOptions: channel.durationOptions,
    maxReferenceImages: channel.maxReferenceImages,
    maxReferenceVideos: channel.maxReferenceVideos,
    maxReferenceAudios: channel.maxReferenceAudios,
  });
  if ((profile.protocol === "lingganya" || profile.protocol === "mikoto") && !channelCheck.modelVisible) {
    throw new RjmusGrokVideoError(
      `当前 LGY API Key 的模型目录未包含 ${channel.model}，请先在模型池填写该 Key 实际返回的模型名。`,
      "MODEL_UNAVAILABLE",
    );
  }
  inFlightVideoSubmissions.add(submissionKey);
  const inputNodeIds = referenceNodeIds;
  let hostedAssets: BoardVideoJob["hostedReferences"] = [];
  const usesLingganyaFiles = isLingganyaTemporaryFileReferenceChannel(channel);
  let referenceTransport: BoardVideoJob["referenceTransport"] = usesLingganyaFiles
    ? "lingganya_file_id"
    : "cloudinary_https";
  let referenceUploadCount = 0;
  let referenceExpiresAt: string | undefined;
  const recordLingganyaUpload = (file: { expiresAt: string }) => {
    referenceUploadCount += 1;
    if (!referenceExpiresAt || Date.parse(file.expiresAt) < Date.parse(referenceExpiresAt)) {
      referenceExpiresAt = file.expiresAt;
    }
  };
  try {
    const cancelledBeforeStart = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      hostedAssets,
    );
    if (cancelledBeforeStart) {
      return NextResponse.json({ workflow: cancelledBeforeStart, cancelled: true, pending: false });
    }
    await startNodeExecution(workflow.id, executorNodeId, inputNodeIds, clientTaskId);
    const referenceVideoSource = await nodeToVideoReference(replacement.referenceVideo);
    const audioReferenceSource = audioNode ? await nodeToAudioReference(audioNode) : "";
    const replacementNodes = [
      replacement.product,
      ...(replacement.face ? [replacement.face] : []),
      ...(replacement.model ? [replacement.model] : []),
      ...(replacement.scene ? [replacement.scene] : []),
    ];
    const replacementImageSources = await Promise.all(
      replacementNodes.map((node) => nodeToReference(node, videoReferenceTargetBytes(node))),
    );
    if (!referenceVideoSource || (audioNode && !audioReferenceSource) || replacementImageSources.some((source) => !source)) {
      throw new RjmusGrokVideoError("有参考视频或职责图无法读取；请检查本地文件后重试。", "REFERENCE_READ_FAILED");
    }
    const hostingSetting = usesLingganyaFiles ? undefined : await resolveVideoReferenceHosting(req);
    const hostedVideo = await prepareVideoReferencesForChannel({
      channel,
      sources: [referenceVideoSource],
      setting: hostingSetting,
      ownerId: userId,
      scopeId: workflow.id,
      referenceIds: [replacement.referenceVideo.id],
      mediaType: "video",
      onLingganyaFileUploaded: recordLingganyaUpload,
    });
    hostedAssets = [...hostedVideo.assets];
    const hostedImages = await prepareVideoReferencesForChannel({
      channel,
      sources: replacementImageSources,
      setting: hostingSetting,
      ownerId: userId,
      scopeId: workflow.id,
      referenceIds: replacementNodes.map((node) => node.id),
      mediaType: "image",
      onLingganyaFileUploaded: recordLingganyaUpload,
    });
    hostedAssets = [...hostedAssets, ...hostedImages.assets];
    const hostedAudio = audioReferenceSource ? await prepareVideoReferencesForChannel({
      channel,
      sources: [audioReferenceSource],
      setting: hostingSetting,
      ownerId: userId,
      scopeId: workflow.id,
      referenceIds: [audioNode!.id],
      mediaType: "audio",
      onLingganyaFileUploaded: recordLingganyaUpload,
    }) : null;
    hostedAssets = [...hostedAssets, ...(hostedAudio?.assets || [])];
    const referenceBatches = [hostedVideo, hostedImages, hostedAudio];
    referenceTransport = hostedImages.transport === "lingganya_file_id"
      ? "lingganya_file_id"
      : "cloudinary_https";
    if (!usesLingganyaFiles) {
      referenceUploadCount = referenceBatches.reduce((total, batch) => total + Number(batch?.uploadCount || 0), 0);
      referenceExpiresAt = earliestReferenceExpiry(referenceBatches);
    }
    const validReference = usesLingganyaFiles
      ? isLingganyaFileId
      : (value: string) => value.startsWith("https://");
    if (
      hostedVideo.urls.length !== 1
      || hostedImages.urls.length !== replacementNodes.length
      || (audioNode && hostedAudio?.urls.length !== 1)
      || [...hostedVideo.urls, ...hostedImages.urls, ...(hostedAudio?.urls || [])].some((value) => !validReference(value))
    ) {
      throw new RjmusGrokVideoError(
        usesLingganyaFiles
          ? `参考视频和 ${replacementNodes.length} 张职责图未能全部上传为灵感鸭临时 file_id。`
          : `参考视频和 ${replacementNodes.length} 张职责图未能全部转换为公网 HTTPS URL。`,
        "HOSTING_FAILED",
      );
    }
    if (usesLingganyaFiles && referenceUploadCount !== 1 + replacementNodes.length + (audioNode ? 1 : 0)) {
      throw new RjmusGrokVideoError("灵感鸭临时参考上传数量与本次任务输入不一致。", "REFERENCE_INTEGRITY_UNVERIFIED");
    }
    if (!usesLingganyaFiles && hostedAssets.some((asset) => !asset.sourceSha256 || !asset.sourceBytes || !asset.verifiedAt)) {
      throw new RjmusGrokVideoError(
        "本地参考素材未完成 Cloudinary 原始字节校验，已阻止提交给视频模型。",
        "REFERENCE_INTEGRITY_UNVERIFIED",
      );
    }
    const cancelledBeforeSubmit = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      hostedAssets,
      undefined,
      { uploadCount: referenceUploadCount, expiresAt: referenceExpiresAt },
    );
    if (cancelledBeforeSubmit) {
      return NextResponse.json({ workflow: cancelledBeforeSubmit, cancelled: true, pending: false });
    }
    const submitted = await auditModelApiCall({
      userId,
      callType: "video",
      providerKey: "rjmus-grok",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      source: "board.video.direct-replacement",
      boardWorkflowId: workflow.id,
      boardNodeId: executorNodeId,
    }, () => submitRjmusGrokVideo({
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: channel.model,
      videoProtocol: channel.videoProtocol,
      prompt: executionPrompt,
      imageUrls: hostedImages.urls,
      videoUrls: hostedVideo.urls,
      audioUrls: hostedAudio?.urls || [],
      submitPath: channel.submitPath,
      statusPath: channel.statusPath,
      contentPath: channel.contentPath,
      resolution: profile.resolution,
      durationOptions: channel.durationOptions,
      generationSeconds,
      maxReferenceImages: channel.maxReferenceImages,
      maxReferenceVideos: channel.maxReferenceVideos,
      maxReferenceAudios: channel.maxReferenceAudios,
      directVideoReplacementSceneOptional: profile.directVideoReplacementSceneOptional,
      directVideoReplacementFaceOptional: profile.directVideoReplacementFaceOptional,
      directVideoReplacementReferenceContract: profile.directVideoReplacementReferenceContract,
    }), { toResult: (result) => ({ remoteTaskId: result.taskId }) });
    const position = readPosition(body, 1420, 1300);
    const job: BoardVideoJob = {
      taskId: submitted.taskId,
      status: "submitted",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      resolution: profile.resolution,
      executionMode: "direct_video_replacement",
      capabilitySignature: profile.capabilitySignature,
      promptVersion: profile.directVideoReplacementPromptVersion,
      requestId: submitted.requestId || channelCheck.requestId,
      upstreamRequestId: submitted.upstreamRequestId || channelCheck.upstreamRequestId,
      directorNodeId: "",
      directorSchemaVersion: 0,
      segmentIndex: 1,
      segmentCount: 1,
      segmentStart: 0,
      generationDuration: generationSeconds,
      sourceDuration: referenceDuration,
      sourceTimeRange: `参考视频 ${referenceDuration.toFixed(2)}s`,
      outputDuration: generationSeconds,
      outputTimeRange: `00:00–00:${String(generationSeconds).padStart(2, "0")}`,
      requestedTotalDuration: generationSeconds,
      plannedOutputDuration: generationSeconds,
      referenceNodeIds,
      audioReferenceNodeId: audioNode?.id,
      promptEnglish: executionPrompt,
      requiresAudio: Boolean(audioNode),
      resultTitle: String(body.resultTitle || "参考视频替换成片"),
      resultDescription: String(body.resultDescription || (
        replacement.scene
          ? "按参考视频的动作、镜头与时序生成，并替换商品、人脸、人物和场景。"
          : "按参考视频的动作、镜头、时序和背景生成，并替换商品、人脸和人物。"
      )),
      x: position.x,
      y: position.y,
      hostedReferences: hostedAssets,
      referenceTransport,
      ...(referenceUploadCount > 0 ? { referenceUploadCount } : {}),
      ...(referenceExpiresAt ? { referenceExpiresAt } : {}),
      submittedAt: new Date().toISOString(),
      pollFailures: 0,
      contentFailures: 0,
    };
    const persisted = await patchJob(workflow.id, executorNodeId, job, `远端视频替换任务已提交：${submitted.taskId}`);
    const cancelledAfterSubmit = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      hostedAssets,
      job,
    );
    if (cancelledAfterSubmit) {
      return NextResponse.json({
        workflow: cancelledAfterSubmit,
        cancelled: true,
        pending: false,
        taskId: submitted.taskId,
      });
    }
    await appendVideoDebugLog(workflow.localDir, "direct_video_replacement_submitted", {
      taskId: submitted.taskId,
      model: channel.model,
      seconds: String(generationSeconds),
      resolution: profile.resolution,
      videoReferenceCount: hostedVideo.urls.length,
      imageReferenceCount: hostedImages.urls.length,
      audioReferenceCount: hostedAudio?.urls.length || 0,
      referenceTransport,
      referenceUploadCount,
      referenceExpiresAt,
      promptUtf8Bytes: Buffer.byteLength(executionPrompt, "utf8"),
      requestId: submitted.requestId || channelCheck.requestId,
      upstreamRequestId: submitted.upstreamRequestId || channelCheck.upstreamRequestId,
    });
    return NextResponse.json({ workflow: persisted, pending: true, taskId: submitted.taskId }, { status: 202 });
  } catch (error) {
    const cancelled = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      hostedAssets,
      undefined,
      { uploadCount: referenceUploadCount, expiresAt: referenceExpiresAt },
    );
    if (cancelled) return NextResponse.json({ workflow: cancelled, cancelled: true, pending: false });
    const message = friendlyError(error);
    const failed = await failNodeExecution(workflow.id, executorNodeId, inputNodeIds, message).catch(() => null);
    const cleanup = await cleanupHostedReferences(req, failed || workflow, hostedAssets).catch(() => undefined);
    const temporarySummary = referenceTransport === "lingganya_file_id"
      ? lingganyaTemporaryReferenceSummary(referenceUploadCount, referenceExpiresAt)
      : "";
    const audited = cleanup || temporarySummary
      ? await updateNodeExecution(workflow.id, executorNodeId, {
        status: "failed",
        summary: `视频任务提交失败。${cleanup ? cleanupAuditSummary(cleanup) : temporarySummary}`,
        error: message,
        ...(cleanup ? { referenceCleanup: cleanup } : {}),
      }, "failed").catch(() => null)
      : failed;
    throw Object.assign(error instanceof Error ? error : new Error(message), { failedWorkflow: audited || failed });
  } finally {
    inFlightVideoSubmissions.delete(submissionKey);
  }
}

async function submitTask(
  req: NextRequest,
  workflow: BoardWorkflow,
  userId: string,
  body: Record<string, unknown>,
) {
  const executorNodeId = String(body.executorNodeId || "");
  const clientTaskId = String(body.clientTaskId || "");
  const incomingChannel = body.channel as Partial<VideoModelChannel> | undefined;
  // The board always resolves the saved model-pool channel. Do not trust a
  // browser-provided capability list or credential for a paid video task.
  const channel = await currentVideoChannel(req, undefined, String(incomingChannel?.id || ""));
  const profile = getBoardVideoProfile(channel);
  if (!profile) throw new RjmusGrokVideoError("当前视频模型没有画板协议配置。", "UNSUPPORTED_MODEL");
  if (profile.directVideoReplacement) {
    return submitDirectVideoReplacementTask(req, workflow, userId, body, channel);
  }
  const { executorNode, directorNode, referenceNodes } = selectExecutionInputs(workflow, executorNodeId, channel);
  const segmentIndex = Number(body.segmentIndex);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 1) {
    throw new RjmusGrokVideoError("请选择完整导演稿中的一个视频任务。", "INVALID_SEGMENT");
  }
  const directorModel = String(directorNode.meta?.videoModel || "").trim();
  const directorGenerationSeconds = Number(directorNode.meta?.videoGenerationSeconds || 0);
  const directorChannelId = String(directorNode.meta?.videoChannelId || "").trim();
  const directorCapabilitySignature = String(directorNode.meta?.videoCapabilitySignature || "").trim();
  if (
    directorChannelId !== channel.id
    || directorModel !== channel.model
    || directorGenerationSeconds !== profile.generationSeconds
    || directorCapabilitySignature !== profile.capabilitySignature
  ) {
    throw new RjmusGrokVideoError("完整导演稿不是按当前所选视频模型生成的，请重新生成完整导演稿。", "STALE_DIRECTOR_PROFILE");
  }
  const { plan, plans, promptEnglish, editorialTimingLock } = segmentPlanForDirector(directorNode, segmentIndex, profile.generationSeconds);
  const requestedReferenceIds = Array.isArray(body.referenceNodeIds)
    ? body.referenceNodeIds.filter((value): value is string => typeof value === "string")
    : [];
  const selectedReferenceNodes = selectedReferencesForTask(referenceNodes, requestedReferenceIds, channel);
  const referenceNodeIds = selectedReferenceNodes.map((node) => node.id);
  const executionPrompt = buildVideoPromptWithReferenceResponsibilities(
    promptEnglish,
    selectedReferenceNodes,
    editorialTimingLock,
  );
  const requiresAudio = directorPromptRequiresAudio(promptEnglish);
  assertBoardVideoPromptWithinLimit(channel.model, executionPrompt);

  const existingJob = activeVideoJob(executorNode);
  if (isActiveJob(existingJob)) {
    return NextResponse.json({
      error: `该节点已有远端任务 ${existingJob!.taskId}，正在自动恢复，不能重复创建付费任务。`,
      workflow,
      pending: true,
      taskId: existingJob!.taskId,
    }, { status: 409 });
  }

  const submissionKey = `${workflow.id}:${executorNodeId}:${segmentIndex}`;
  if (inFlightVideoSubmissions.has(submissionKey)) {
    return NextResponse.json({ error: "相同视频任务正在提交，请稍候。", workflow }, { status: 409 });
  }
  const channelCheck = await verifyRjmusGrokVideoChannel({
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    model: channel.model,
    videoProtocol: channel.videoProtocol,
    submitPath: channel.submitPath,
    statusPath: channel.statusPath,
    contentPath: channel.contentPath,
    durationOptions: channel.durationOptions,
    maxReferenceImages: channel.maxReferenceImages,
    maxReferenceVideos: channel.maxReferenceVideos,
    maxReferenceAudios: channel.maxReferenceAudios,
  });
  if ((profile.protocol === "lingganya" || profile.protocol === "mikoto") && !channelCheck.modelVisible) {
    throw new RjmusGrokVideoError(
      `当前 LGY API Key 的模型目录未包含 ${channel.model}，请先在模型池填写该 Key 实际返回的模型名。`,
      "MODEL_UNAVAILABLE",
    );
  }
  inFlightVideoSubmissions.add(submissionKey);
  let hostedReferences: PreparedVideoReferenceBatch | null = null;
  const usesLingganyaFiles = isLingganyaTemporaryFileReferenceChannel(channel);
  let referenceUploadCount = 0;
  let referenceExpiresAt: string | undefined;
  const recordLingganyaUpload = (file: { expiresAt: string }) => {
    referenceUploadCount += 1;
    if (!referenceExpiresAt || Date.parse(file.expiresAt) < Date.parse(referenceExpiresAt)) {
      referenceExpiresAt = file.expiresAt;
    }
  };
  const inputNodeIds = uniqueStrings([directorNode.id, ...referenceNodeIds]);
  try {
    const cancelledBeforeStart = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      [],
    );
    if (cancelledBeforeStart) {
      return NextResponse.json({ workflow: cancelledBeforeStart, cancelled: true, pending: false });
    }
    await startNodeExecution(workflow.id, executorNodeId, inputNodeIds, clientTaskId);
    const referenceSources = await Promise.all(selectedReferenceNodes.map((node) =>
      nodeToReference(node, videoReferenceTargetBytes(node))
    ));
    if (referenceSources.some((source) => !source)) {
      throw new RjmusGrokVideoError("有参考图无法读取，请检查本地文件后重试。", "REFERENCE_READ_FAILED");
    }
    const hostingSetting = usesLingganyaFiles ? undefined : await resolveVideoReferenceHosting(req);
    hostedReferences = await prepareVideoReferencesForChannel({
      channel,
      sources: referenceSources,
      setting: hostingSetting,
      ownerId: userId,
      scopeId: workflow.id,
      referenceIds: referenceNodeIds,
      mediaType: "image",
      onLingganyaFileUploaded: recordLingganyaUpload,
    });
    const validReference = usesLingganyaFiles
      ? isLingganyaFileId
      : (value: string) => value.startsWith("https://");
    if (hostedReferences.urls.length !== profile.referenceImageCount || hostedReferences.urls.some((value) => !validReference(value))) {
      throw new RjmusGrokVideoError(
        usesLingganyaFiles
          ? `当前模型的 ${profile.referenceImageCount} 张参考图没有全部上传为灵感鸭临时 file_id。`
          : `当前模型的 ${profile.referenceImageCount} 张参考图没有全部转换成公网 HTTPS URL。`,
        "HOSTING_FAILED",
      );
    }
    if (usesLingganyaFiles && hostedReferences.uploadCount !== profile.referenceImageCount) {
      throw new RjmusGrokVideoError("灵感鸭临时参考上传数量与本次任务输入不一致。", "REFERENCE_INTEGRITY_UNVERIFIED");
    }
    const submittedReferences = hostedReferences;
    if (!submittedReferences) throw new RjmusGrokVideoError("Hosted video references are missing.", "HOSTING_FAILED");
    const cancelledBeforeSubmit = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      submittedReferences.assets,
      undefined,
      { uploadCount: referenceUploadCount, expiresAt: referenceExpiresAt },
    );
    if (cancelledBeforeSubmit) {
      return NextResponse.json({ workflow: cancelledBeforeSubmit, cancelled: true, pending: false });
    }
    const submitted = await auditModelApiCall({
      userId,
      callType: "video",
      providerKey: "rjmus-grok",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      source: "board.video.generate",
      boardWorkflowId: workflow.id,
      boardNodeId: executorNodeId,
    }, () => submitRjmusGrokVideo({
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: channel.model,
      videoProtocol: channel.videoProtocol,
      prompt: executionPrompt,
      imageUrls: submittedReferences.urls,
      submitPath: channel.submitPath,
      statusPath: channel.statusPath,
      contentPath: channel.contentPath,
      resolution: profile.resolution,
      durationOptions: channel.durationOptions,
      generationSeconds: profile.generationSeconds,
      maxReferenceImages: channel.maxReferenceImages,
      maxReferenceVideos: channel.maxReferenceVideos,
      maxReferenceAudios: channel.maxReferenceAudios,
    }), { toResult: (result) => ({ remoteTaskId: result.taskId }) });
    const position = readPosition(body, 1420, 1300 + (segmentIndex - 1) * 260);
    const job: BoardVideoJob = {
      taskId: submitted.taskId,
      status: "submitted",
      channelId: channel.id,
      channelName: channel.name,
      model: channel.model,
      resolution: profile.resolution,
      capabilitySignature: profile.capabilitySignature,
      requestId: submitted.requestId || channelCheck.requestId,
      upstreamRequestId: submitted.upstreamRequestId || channelCheck.upstreamRequestId,
      directorNodeId: directorNode.id,
      directorSchemaVersion: VIDEO_DIRECTOR_SCHEMA_VERSION,
      segmentIndex,
      segmentCount: plans.length,
      segmentStart: plan.start,
      generationDuration: profile.generationSeconds,
      sourceDuration: plan.sourceDuration,
      sourceTimeRange: plan.sourceTimeRange,
      outputDuration: plan.outputDuration,
      outputTimeRange: plan.outputTimeRange,
      requestedTotalDuration: plan.requestedTotal,
      plannedOutputDuration: plan.plannedOutputDuration,
      referenceNodeIds,
      promptEnglish: executionPrompt,
      requiresAudio,
      resultTitle: plans.length === 1
        ? "画板完整成片"
        : String(body.resultTitle || `节点分段视频 ${segmentIndex}/${plans.length}`),
      resultDescription: plans.length === 1
        ? `完整 ${plan.requestedTotal} 秒视频任务。`
        : String(body.resultDescription || `任务 ${segmentIndex}/${plans.length}，完整保留 ${plan.outputDuration} 秒。`),
      x: position.x,
      y: position.y,
      hostedReferences: hostedReferences.assets,
      referenceTransport: hostedReferences.transport === "lingganya_file_id" ? "lingganya_file_id" : "cloudinary_https",
      ...(hostedReferences.uploadCount > 0 ? { referenceUploadCount: hostedReferences.uploadCount } : {}),
      ...(hostedReferences.expiresAt ? { referenceExpiresAt: hostedReferences.expiresAt } : {}),
      submittedAt: new Date().toISOString(),
      pollFailures: 0,
      contentFailures: 0,
    };
    const persisted = await patchJob(workflow.id, executorNodeId, job, `远端任务已提交：${submitted.taskId}`);
    const cancelledAfterSubmit = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      submittedReferences.assets,
      job,
    );
    if (cancelledAfterSubmit) {
      return NextResponse.json({
        workflow: cancelledAfterSubmit,
        cancelled: true,
        pending: false,
        taskId: submitted.taskId,
      });
    }
    await appendVideoDebugLog(workflow.localDir, "task_submitted", {
      taskId: submitted.taskId,
      segmentIndex,
      segmentCount: plans.length,
      model: channel.model,
      seconds: String(profile.generationSeconds),
      resolution: profile.resolution,
      aspectRatio: profile.aspectRatio,
      referenceCount: hostedReferences.urls.length,
      referenceTransport: hostedReferences.transport,
      referenceUploadCount: hostedReferences.uploadCount,
      referenceExpiresAt: hostedReferences.expiresAt,
      promptChars: executionPrompt.length,
      promptUtf8Bytes: Buffer.byteLength(executionPrompt, "utf8"),
      requestId: submitted.requestId || channelCheck.requestId,
      upstreamRequestId: submitted.upstreamRequestId || channelCheck.upstreamRequestId,
    });
    return NextResponse.json({ workflow: persisted, pending: true, taskId: submitted.taskId }, { status: 202 });
  } catch (error) {
    const cancelled = await cancelledVideoSubmissionWorkflow(
      req,
      workflow.id,
      executorNodeId,
      clientTaskId,
      hostedReferences?.assets || [],
      undefined,
      { uploadCount: referenceUploadCount, expiresAt: referenceExpiresAt },
    );
    if (cancelled) return NextResponse.json({ workflow: cancelled, cancelled: true, pending: false });
    const message = friendlyError(error);
    const failed = await failNodeExecution(workflow.id, executorNodeId, inputNodeIds, message).catch(() => null);
    const cleanup = await cleanupHostedReferences(req, failed || workflow, hostedReferences?.assets || []).catch(() => undefined);
    const temporarySummary = usesLingganyaFiles
      ? lingganyaTemporaryReferenceSummary(referenceUploadCount, referenceExpiresAt)
      : "";
    const audited = cleanup || temporarySummary
      ? await updateNodeExecution(workflow.id, executorNodeId, {
        status: "failed",
        summary: `视频任务提交失败。${cleanup ? cleanupAuditSummary(cleanup) : temporarySummary}`,
        error: message,
        ...(cleanup ? { referenceCleanup: cleanup } : {}),
      }, "failed").catch(() => null)
      : failed;
    throw Object.assign(error instanceof Error ? error : new Error(message), { failedWorkflow: audited || failed });
  } finally {
    inFlightVideoSubmissions.delete(submissionKey);
  }
}

async function pollTask(req: NextRequest, workflow: BoardWorkflow, body: Record<string, unknown>) {
  const executorNodeId = String(body.executorNodeId || "");
  const executorNode = workflow.nodes.find((node) => node.id === executorNodeId);
  if (!executorNode || String(executorNode.meta?.controlRole || "") !== "video_generate") {
    throw new RjmusGrokVideoError("找不到要恢复的视频功能节点。", "INVALID_EXECUTOR");
  }
  const job = activeVideoJob(executorNode);
  if (!job?.taskId) throw new RjmusGrokVideoError("当前节点没有可恢复的远端视频任务。", "NO_REMOTE_JOB");
  if (job.status === "completed" && job.outputNodeIds?.length) {
    return NextResponse.json({ workflow, pending: false, taskId: job.taskId });
  }
  if (executorNode.execution?.status === "cancelled" || isNodeExecutionCancelled(workflow, executorNodeId)) {
    const cancelledJob = { ...job, status: "cancelled" as const, lastPolledAt: new Date().toISOString() };
    const cleaned = await cleanupJobReferences(req, workflow, executorNodeId, cancelledJob);
    return NextResponse.json({ workflow: cleaned, cancelled: true, pending: false, taskId: job.taskId });
  }

  // Backfill a diagnostic node for a file downloaded before this behavior was
  // introduced. This path is local-only: it never polls or re-submits upstream.
  if (isStoredOutputMismatch(job)) {
    if (isBoardOutputRecoverySuppressed(
      workflow,
      "video_output_mismatch",
      job.taskId,
      executorNode.id,
    )) {
      return NextResponse.json({
        error: outputMismatchMessage(job),
        workflow,
        pending: false,
        taskId: job.taskId,
        outputMismatch: true,
        outputSuppressed: true,
      });
    }
    const materialized = await materializeOutputMismatch(
      req,
      workflow,
      executorNode,
      job,
      String(job.outputValidation?.diagnosticFilePath || ""),
      outputMismatchMessage(job),
    );
    return NextResponse.json({
      error: outputMismatchMessage(job),
      workflow: materialized.workflow,
      pending: false,
      taskId: job.taskId,
      node: materialized.node,
      outputMismatch: true,
      outputSuppressed: materialized.suppressed,
    });
  }

  const channel = await currentVideoChannel(req, null, job.channelId);
  const jobProfile = getBoardVideoProfile({ ...channel, resolution: job.resolution });
  const submittedAtMs = Date.parse(String(job.submittedAt || ""));
  const lingganyaFirstPollDelayMs = 30_000;
  const taskAgeMs = Number.isFinite(submittedAtMs) ? Date.now() - submittedAtMs : lingganyaFirstPollDelayMs;
  if (jobProfile?.protocol === "lingganya" && taskAgeMs < lingganyaFirstPollDelayMs) {
    const remainingSeconds = Math.max(1, Math.ceil((lingganyaFirstPollDelayMs - taskAgeMs) / 1_000));
    const waitingJob = { ...job, status: "submitted" as const, lastError: "" };
    const waitingWorkflow = await patchJob(
      workflow.id,
      executorNodeId,
      waitingJob,
      `上游任务已创建，按 Lingganya 协议将在约 ${remainingSeconds} 秒后首次查询状态`,
    );
    return NextResponse.json({ workflow: waitingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
  }

  const pollKey = `${workflow.id}:${job.taskId}`;
  if (inFlightVideoPolls.has(pollKey)) {
    return NextResponse.json({ workflow, pending: true, taskId: job.taskId }, { status: 202 });
  }
  inFlightVideoPolls.add(pollKey);
  try {
    const existingOutput = workflow.nodes.find((node) =>
      String(node.meta?.taskId || "") === job.taskId
        && String(node.meta?.assetRole || "") !== "video_output_mismatch"
        && Boolean(node.filePath),
    );
    if (existingOutput) {
      const completedJob = { ...job, status: "completed" as const, outputNodeIds: [existingOutput.id] };
      await patchJob(workflow.id, executorNodeId, completedJob, "视频已保存到本地并同步到画板");
      const final = await finishNodeExecution(workflow.id, executorNodeId, executorNode.execution?.inputNodeIds || [], [existingOutput.id], "视频生成完成");
      return NextResponse.json({ workflow: final, pending: false, taskId: job.taskId, node: existingOutput });
    }

    // Query the task-status endpoint before touching the protected content
    // endpoint. LGY can keep /content open while the task is still generating;
    // probing it first would prevent this handler from recording lastPolledAt
    // or honoring the documented 30-second retry for a 403 status response.
    let remoteStatus: Awaited<ReturnType<typeof getRjmusGrokVideoStatus>> | null = null;
    try {
      remoteStatus = await getRjmusGrokVideoStatus({
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        model: channel.model,
        videoProtocol: channel.videoProtocol,
        submitPath: channel.submitPath,
        statusPath: channel.statusPath,
        contentPath: channel.contentPath,
        durationOptions: channel.durationOptions,
        maxReferenceImages: channel.maxReferenceImages,
        maxReferenceVideos: channel.maxReferenceVideos,
        maxReferenceAudios: channel.maxReferenceAudios,
        taskId: job.taskId,
      });
    } catch (error) {
      const lingganyaStatusPermissionDelay = isLingganyaStatusPermissionDelay(error, channel);
      if (isRetryableRjmusVideoError(error) || lingganyaStatusPermissionDelay) {
        const pendingJob = {
          ...job,
          status: lingganyaStatusPermissionDelay ? "running" as const : job.status,
          lastPolledAt: new Date().toISOString(),
          pollFailures: Number(job.pollFailures || 0) + 1,
          lastError: friendlyError(error),
        };
        const pendingWorkflow = await patchJob(
          workflow.id,
          executorNodeId,
          pendingJob,
          lingganyaStatusPermissionDelay
            ? "上游任务仍在生成；状态接口暂未授权，30 秒后自动重试"
            : "查询暂时失败，正在自动重试",
        );
        return NextResponse.json({ workflow: pendingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
      }
      throw error;
    }

    if (!remoteStatus) throw new RjmusGrokVideoError("视频状态查询未返回结果。", "UNKNOWN_STATUS");

    if (remoteStatus.status === "queued" || remoteStatus.status === "running") {
      const pendingJob = {
        ...job,
        status: remoteStatus.status,
        lastPolledAt: new Date().toISOString(),
        pollFailures: 0,
        lastError: "",
      };
      const pendingWorkflow = await patchJob(
        workflow.id,
        executorNodeId,
        pendingJob,
        remoteStatus.status === "queued" ? "远端任务排队中" : "远端任务生成中",
      );
      return NextResponse.json({ workflow: pendingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
    }

    if (remoteStatus.status === "failed" || remoteStatus.status === "cancelled") {
      const message = remoteStatus.error || `远端视频任务状态：${remoteStatus.status}`;
      const terminalJob = { ...job, status: remoteStatus.status, lastError: message };
      await updateVideoExecutionWithRetry(workflow.id, executorNodeId, {
        status: "failed",
        summary: "远端视频任务失败",
        error: message,
        videoJob: terminalJob,
      }, "failed");
      const failed = await failNodeExecution(workflow.id, executorNodeId, executorNode.execution?.inputNodeIds || [], message);
      const cleaned = await cleanupJobReferences(req, failed || workflow, executorNodeId, terminalJob);
      return NextResponse.json({ error: message, workflow: cleaned, pending: false, taskId: job.taskId }, { status: 502 });
    }

    const resultUrl = remoteStatus.resultUrls[0];
    if (!resultUrl) {
      const pendingJob = {
        ...job,
        status: "completed_pending_content" as const,
        lastPolledAt: new Date().toISOString(),
        contentFailures: Number(job.contentFailures || 0) + 1,
        lastError: "上游任务已完成，正在等待签名下载地址。",
      };
      const pendingWorkflow = await patchJob(workflow.id, executorNodeId, pendingJob, "生成完成，正在等待视频下载地址");
      return NextResponse.json({ workflow: pendingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
    }

    const completedProfile = getBoardVideoProfile({ ...channel, resolution: job.resolution });
    if (!completedProfile) throw new RjmusGrokVideoError("远端任务使用了未配置的视频模型。", "UNSUPPORTED_MODEL");

    let video;
    try {
      video = await downloadRjmusGrokVideo({
        resultUrl,
        apiKey: channel.apiKey,
        requiresApiKey: remoteStatus.contentRequiresApiKey,
        authorizedBaseUrl: channel.baseUrl,
      });
    } catch (error) {
      if (isRetryableRjmusVideoError(error)) {
        const pendingJob = {
          ...job,
          status: "completed_pending_content" as const,
          lastPolledAt: new Date().toISOString(),
          contentFailures: Number(job.contentFailures || 0) + 1,
          lastError: friendlyError(error),
        };
        const pendingWorkflow = await patchJob(workflow.id, executorNodeId, pendingJob, "生成完成，等待视频文件可下载");
        return NextResponse.json({ workflow: pendingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
      }
      throw error;
    }

    const latestBeforeWrite = await getBoardWorkflow(workflow.id) || workflow;
    if (isBoardTaskCancelled(workflow.id, executorNode.execution?.clientTaskId) || isNodeExecutionCancelled(latestBeforeWrite, executorNodeId)) {
      const cleaned = await cleanupJobReferences(req, latestBeforeWrite, executorNodeId, job);
      return NextResponse.json({ workflow: cleaned, cancelled: true, pending: false, taskId: job.taskId });
    }

    const role = job.segmentCount === 1 ? "composed_video" : "generated_video";
    const filePath = await writeBoardBuffer(
      workflow.id,
      boardArtifactRelativePath(
        "video",
        boardArtifactFileName(workflow, `任务${job.segmentIndex}-${job.sourceTimeRange || role}`, video.ext),
      ),
      video.bytes,
    );
    const media = await probeVideoMedia(filePath);
    const outputValidation = validateBoardVideoOutput(
      completedProfile,
      job.generationDuration,
      media,
      { requiresAudio: Boolean(job.requiresAudio) },
    );
    if (!outputValidation.valid) {
      const message = `上游回传视频不符合本次任务规格：${outputValidation.violations.join("；")}`;
      const failedJob: BoardVideoJob = {
        ...job,
        status: "failed",
        lastError: message,
        lastPolledAt: new Date().toISOString(),
        outputValidation: {
          ...outputValidation,
          checkedAt: new Date().toISOString(),
          diagnosticFilePath: filePath,
        },
      };
      await appendVideoDebugLog(workflow.localDir, "output_contract_mismatch", {
        taskId: job.taskId,
        model: job.model,
        executionMode: job.executionMode || "director_segments",
        expected: outputValidation.expected,
        actual: outputValidation.actual,
        violations: outputValidation.violations,
        diagnosticFilePath: filePath,
      });
      const materialized = await materializeOutputMismatch(
        req,
        workflow,
        executorNode,
        failedJob,
        filePath,
        message,
      );
      return NextResponse.json({
        error: message,
        workflow: materialized.workflow,
        pending: false,
        taskId: job.taskId,
        node: materialized.node,
        outputMismatch: true,
        outputSuppressed: materialized.suppressed,
      }, { status: 422 });
    }
    const resultNode = createNode({
      kind: "video_clip",
      title: job.resultTitle,
      description: job.resultDescription,
      filePath,
      publicUrl: boardFilePublicUrl(workflow.id, filePath),
      promptEnglish: job.promptEnglish,
      meta: {
        assetRole: role,
        provider: completedProfile.protocol === "lingganya" ? "lingganya-video" : "rjmus-video",
        channelId: job.channelId,
        channelName: job.channelName,
        model: job.model,
        executionMode: job.executionMode || "director_segments",
        capabilitySignature: job.capabilitySignature,
        requestId: job.requestId,
        upstreamRequestId: job.upstreamRequestId,
        taskId: job.taskId,
        directorNodeId: job.directorNodeId,
        directorSchemaVersion: job.directorSchemaVersion,
        referenceNodeIds: job.referenceNodeIds,
        audioReferenceNodeId: job.audioReferenceNodeId,
        segmentIndex: job.segmentIndex,
        segmentCount: job.segmentCount,
        generationDuration: job.generationDuration,
        sourceDuration: job.sourceDuration,
        sourceTimeRange: job.sourceTimeRange,
        outputDuration: job.outputDuration,
        outputTimeRange: job.outputTimeRange,
        requestedTotalDuration: job.requestedTotalDuration,
        plannedOutputDuration: job.plannedOutputDuration,
        executorNodeId,
        aspectRatio: completedProfile.aspectRatio,
        resolution: completedProfile.resolution,
        referenceTransport: job.referenceTransport,
        hasAudio: media.hasAudio,
        actualDuration: media.durationSeconds,
        width: media.width,
        height: media.height,
        fps: media.fps,
      },
      x: job.x,
      y: job.y,
    });
    const latest = await getBoardWorkflow(workflow.id) || workflow;
    const edges = [
      ...(job.directorNodeId ? [createEdge(job.directorNodeId, resultNode.id, "视频生成")] : []),
      createEdge(executorNodeId, resultNode.id, "节点执行输出"),
      ...job.referenceNodeIds.map((referenceId) => createEdge(referenceId, resultNode.id, job.executionMode === "direct_video_replacement" ? "参考素材" : "参考图")),
    ];
    const next = await updateBoardWorkflow(workflow.id, {
      status: job.segmentCount === 1 ? "done" : "assets",
      nodes: [...latest.nodes, resultNode],
      edges: [...latest.edges, ...edges],
    }, latest.revision ?? 0);
    const completedJob = {
      ...job,
      status: "completed" as const,
      lastPolledAt: new Date().toISOString(),
      lastError: "",
      outputNodeIds: [resultNode.id],
    };
    await updateNodeExecution(workflow.id, executorNodeId, {
      status: "running",
      summary: "视频已保存到本地，正在同步画板",
      error: "",
      videoJob: completedJob,
    }, "running");
    const final = await finishNodeExecution(
      workflow.id,
      executorNodeId,
      executorNode.execution?.inputNodeIds || [],
      [resultNode.id],
      job.segmentCount === 1 ? "完整成片已生成" : `分段任务 ${job.segmentIndex} 已生成`,
    ) || next;
    const cleaned = await cleanupJobReferences(req, final, executorNodeId, completedJob);
    clearBoardTaskCancellation(workflow.id, executorNode.execution?.clientTaskId);
    await appendVideoDebugLog(workflow.localDir, "task_saved", {
      taskId: job.taskId,
      filePath,
      bytes: video.bytes.length,
      hasAudio: media.hasAudio,
      actualDuration: media.durationSeconds,
    });
    return NextResponse.json({ workflow: cleaned, pending: false, taskId: job.taskId, node: resultNode });
  } catch (error) {
    if (isTransientVideoPollInterruption(error)) {
      const pendingJob: BoardVideoJob = {
        ...job,
        status: job.status === "completed_pending_content" ? "completed_pending_content" : "running",
        lastPolledAt: new Date().toISOString(),
        pollFailures: Number(job.pollFailures || 0) + 1,
        lastError: "本地轮询连接短暂中断；远端任务保持可恢复，正在重试。",
      };
      const pendingWorkflow = await patchJob(
        workflow.id,
        executorNodeId,
        pendingJob,
        "本地轮询连接短暂中断；远端任务仍保留，正在自动重试",
      ).catch(() => workflow);
      return NextResponse.json({ workflow: pendingWorkflow, pending: true, taskId: job.taskId }, { status: 202 });
    }
    const message = friendlyError(error);
    const outputValidation = (error as Error & {
      outputValidation?: ReturnType<typeof validateBoardVideoOutput>;
      diagnosticFilePath?: string;
    }).outputValidation;
    const failedJob = {
      ...job,
      status: "failed" as const,
      lastError: message,
      lastPolledAt: new Date().toISOString(),
      ...(outputValidation ? {
        outputValidation: {
          ...outputValidation,
          checkedAt: new Date().toISOString(),
          diagnosticFilePath: (error as Error & { diagnosticFilePath?: string }).diagnosticFilePath,
        },
      } : {}),
    };
    await updateVideoExecutionWithRetry(workflow.id, executorNodeId, {
      status: "failed",
      summary: "视频任务恢复失败",
      error: message,
      videoJob: failedJob,
    }, "failed").catch(() => null);
    const failed = await failNodeExecution(workflow.id, executorNodeId, executorNode.execution?.inputNodeIds || [], message).catch(() => null);
    const cleaned = await cleanupJobReferences(req, failed || workflow, executorNodeId, failedJob).catch(() => failed || workflow);
    return NextResponse.json({ error: message, workflow: cleaned, pending: false, taskId: job.taskId }, {
      status: error instanceof RjmusGrokVideoError && error.statusCode && error.statusCode >= 400
        ? error.statusCode
        : 500,
    });
  } finally {
    inFlightVideoPolls.delete(pollKey);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflow: BoardWorkflow | null = null;
  let executorNodeId = "";
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    workflow = access.workflow;
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    executorNodeId = String(body.executorNodeId || "");
    if (String(body.action || "submit") === "poll") {
      return await pollTask(req, access.workflow, body);
    }
    return await submitTask(req, access.workflow, access.user.id, body);
  } catch (error) {
    const message = friendlyError(error);
    const attachedWorkflow = (error as Error & { failedWorkflow?: BoardWorkflow | null })?.failedWorkflow;
    const failedWorkflow = attachedWorkflow || (workflow && executorNodeId
      ? await failNodeExecution(
        workflow.id,
        executorNodeId,
        manualDirectInputNodeIds(workflow, executorNodeId),
        message,
      ).catch(() => null)
      : null);
    return NextResponse.json({ error: message, workflow: failedWorkflow || undefined }, {
      status: error instanceof RjmusGrokVideoError && error.statusCode && error.statusCode >= 400
        ? error.statusCode
        : 500,
    });
  }
}

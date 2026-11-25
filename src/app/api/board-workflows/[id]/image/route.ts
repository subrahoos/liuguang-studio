import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent, request as undiciRequest } from "undici";
import { NextRequest, NextResponse } from "next/server";
import { getOwnedBoardWorkflowAccess } from "@/lib/server/resource-access";
import {
  boardFilePublicUrl,
  boardArtifactFileName,
  boardArtifactRelativePath,
  createEdge,
  createNode,
  deferNodeExecution,
  failNodeExecution,
  finishNodeExecution,
  getBoardWorkflow,
  isNodeExecutionCancelled,
  manualDirectInputNodeIds,
  parseDataUrl,
  startNodeExecution,
  updateBoardWorkflow,
  writeUniqueBoardBuffer,
  type BoardWorkflow,
  type BoardWorkflowNode,
} from "@/lib/board-workflows";
import {
  deleteBoardImagePendingResult,
  getBoardImagePendingResult,
  listBoardImagePendingResults,
  saveBoardImagePendingResult,
  summarizeBoardImagePendingResult,
  updateBoardImagePendingResult,
  type BoardImageGenerationTiming,
  type BoardImagePendingResult,
} from "@/lib/board-image-results";
import { createProvider } from "@/lib/providers";
import { resolveImageChannel } from "@/lib/server-model-settings";
import { ProviderError } from "@/lib/providers/base";
import { aspectRatioFromDimensions, imageDimensionsForPreset } from "@/lib/image-output-size";
import { uniqueStrings } from "@/lib/prompt-dedup";
import { clearBoardTaskCancellation, isBoardTaskCancelled } from "@/lib/board-task-cancellations";
import { prepareImageEditReferenceUrl } from "@/lib/image-edit-reference";
import { completedImageExecutionOutputNodes } from "@/lib/board-image-sync";
import {
  BOARD_IMAGE_TASKS,
  buildCanonicalBoardImageTask,
  type BoardImageTask,
} from "@/lib/board-image-task-contract";
import {
  detailImageBatchFromNode,
  detailImageBatchReplacementMode,
  updateDetailImageBatch,
} from "@/lib/board-detail-image-batches";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const IMAGE_REFERENCE_LIMIT = 8;
const IMAGE_OUTPUT_LIMIT = 1;
const MB = 1024 * 1024;

type BoardImageRequestBody = {
  action?: string;
  pendingResultId?: string;
  clientTaskId?: string;
  clientStartedAt?: string | number;
  clientVisibleAtMs?: number;
  executorNodeId?: string;
  prompt?: string;
  promptMetadata?: Record<string, unknown>;
  repairInstruction?: string;
  assetRole?: string;
  referenceNodeIds?: unknown;
  provider?: string;
  channel?: {
    id?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    requestTimeoutMs?: number;
    name?: string;
  };
  endpointPath?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  resultTitle?: string;
  resultDescription?: string;
  x?: number;
  y?: number;
  detailBatchNodeId?: string;
  detailBatchItemIndex?: number;
};

async function appendImageDebugLog(workflowLocalDir: string, event: string, payload: Record<string, unknown> = {}) {
  const diagnosticsDir = path.join(workflowLocalDir, "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true }).catch(() => undefined);
  const logPath = path.join(diagnosticsDir, "image.log");
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  await appendFile(logPath, `${line}\n`, "utf8").catch(() => undefined);
}

function absoluteUrl(req: NextRequest, url?: string) {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  if (url.startsWith("/")) return `${req.nextUrl.origin}${url}`;
  return url;
}

function dataUrlPayloadBytes(url: string) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return undefined;
  const encodedLength = Math.max(0, url.length - comma - 1);
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encodedLength * 3) / 4) - padding);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readImageBytes(url: string) {
  if (url.startsWith("data:")) return parseDataUrl(url);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dispatcher = new Agent({
      connectTimeout: 60_000,
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    try {
      const res = await undiciRequest(url, {
        method: "GET",
        dispatcher,
        headersTimeout: 0,
        bodyTimeout: 0,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`图片下载失败：${res.statusCode}`);
      const contentType = String(res.headers["content-type"] || "image/png");
      const chunks: Buffer[] = [];
      for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) throw new Error("图片下载失败：空响应");
      const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
      return { bytes, ext, mimeType: contentType };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1500 * attempt);
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("图片下载失败");
}

function readPosition(body: BoardImageRequestBody, fallbackX: number, fallbackY: number) {
  const x = Number(body.x || fallbackX);
  const y = Number(body.y || fallbackY);
  return {
    x: Number.isFinite(x) ? x : fallbackX,
    y: Number.isFinite(y) ? y : fallbackY,
  };
}

function imageEditPathFromChannel(endpointPath?: unknown) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/edits";
  if (/\/images\/generations$/i.test(value)) return value.replace(/\/images\/generations$/i, "/images/edits");
  return value;
}

function imageGenerationPathFromChannel(endpointPath?: unknown) {
  const value = String(endpointPath || "").trim();
  if (!value) return "/images/generations";
  if (/\/images\/edits$/i.test(value)) return value.replace(/\/images\/edits$/i, "/images/generations");
  return value;
}

function optionalTimingNumber(source: unknown, key: string) {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function parsedClientTimestamp(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Date.now() + 60_000) return fallback;
  return Math.round(parsed);
}

function generationTimingFromResult(
  result: { extra?: Record<string, unknown> },
  requestStartedAt: number,
  clientStartedAt: unknown
): BoardImageGenerationTiming {
  const timing = result.extra?.timing;
  const clientStartedAtMs = parsedClientTimestamp(clientStartedAt, requestStartedAt);
  const responseHeadersAtMs = optionalTimingNumber(timing, "responseHeadersAtMs");
  const responseBodyCompletedAtMs = optionalTimingNumber(timing, "responseBodyCompletedAtMs");
  return {
    clientStartedAtMs,
    serverReceivedAtMs: requestStartedAt,
    upstreamRequestStartedAtMs: optionalTimingNumber(timing, "upstreamRequestStartedAtMs"),
    responseHeadersAtMs,
    firstResponseByteAtMs: optionalTimingNumber(timing, "firstResponseByteAtMs"),
    responseBodyCompletedAtMs,
    upstreamProcessingMs: optionalTimingNumber(timing, "upstreamProcessingMs"),
    resultTransferMs: optionalTimingNumber(timing, "resultTransferMs"),
    responseFirstByteWaitMs: optionalTimingNumber(timing, "responseFirstByteWaitMs"),
    responseBodyTransferMs: optionalTimingNumber(timing, "responseBodyTransferMs"),
    responseChunkCount: optionalTimingNumber(timing, "responseChunkCount"),
    responseMaxChunkGapMs: optionalTimingNumber(timing, "responseMaxChunkGapMs"),
    responseAverageBytesPerSecond: optionalTimingNumber(timing, "responseAverageBytesPerSecond"),
    upstreamTotalMs: optionalTimingNumber(timing, "upstreamTotalMs"),
    responseBodyBytes: optionalTimingNumber(timing, "responseBodyBytes"),
    clickToUpstreamHeadersMs: responseHeadersAtMs === undefined
      ? undefined
      : Math.max(0, responseHeadersAtMs - clientStartedAtMs),
    clickToResponseCompleteMs: responseBodyCompletedAtMs === undefined
      ? undefined
      : Math.max(0, responseBodyCompletedAtMs - clientStartedAtMs),
    totalMs: Math.max(0, Date.now() - requestStartedAt),
  };
}

function resultTransport(payload: string): "b64_json" | "url" {
  return payload.startsWith("data:") ? "b64_json" : "url";
}

const BOARD_IMAGE_FILE_ROLE: Record<string, string> = {
  clean_scene: "场景空镜",
  product_white_background: "商品白底图",
  outfit_front: "穿搭正面",
  outfit_side: "穿搭侧面",
  outfit_back: "穿搭背面",
  composite_image: "合成主图",
  repaired_image: "细节修复",
};

function safeBoardImageFileNamePart(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function boardImageFileBase(workflow: BoardWorkflow, pending: BoardImagePendingResult) {
  const taskName = safeBoardImageFileNamePart(BOARD_IMAGE_FILE_ROLE[pending.role] || pending.title, "图片资产");
  return boardArtifactRelativePath(
    "assets",
    boardArtifactFileName(workflow, taskName, "png", { timestamp: new Date(pending.createdAt) }).replace(/\.png$/i, ""),
  );
}

function timingAfterLocalSave(timing: BoardImageGenerationTiming | undefined, startedAt: number) {
  const localSaveCompletedAtMs = Date.now();
  return {
    ...timing,
    localSaveMs: Math.max(0, localSaveCompletedAtMs - startedAt),
    localSaveCompletedAtMs,
    clickToLocalSaveMs: timing?.clientStartedAtMs === undefined
      ? undefined
      : Math.max(0, localSaveCompletedAtMs - timing.clientStartedAtMs),
  } satisfies BoardImageGenerationTiming;
}

function timingAtBoardPersist(timing: BoardImageGenerationTiming | undefined) {
  const boardPersistedAtMs = Date.now();
  return {
    ...timing,
    boardPersistedAtMs,
    clickToBoardPersistedMs: timing?.clientStartedAtMs === undefined
      ? undefined
      : Math.max(0, boardPersistedAtMs - timing.clientStartedAtMs),
  } satisfies BoardImageGenerationTiming;
}

function isFileInsideWorkflow(workflow: BoardWorkflow, filePath?: string) {
  if (!filePath) return false;
  const root = path.resolve(workflow.localDir);
  const candidate = path.resolve(filePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function persistPendingBoardImage(input: {
  workflow: BoardWorkflow;
  ownerId: string;
  clientTaskId: string;
  pending: BoardImagePendingResult;
}) {
  const localSaveStartedAt = Date.now();
  let pending = input.pending;
  try {
    let filePath = pending.filePath;
    let extension = pending.fileExtension || "png";
    let bytes = 0;

    if (!filePath || !isFileInsideWorkflow(input.workflow, filePath) || !existsSync(filePath)) {
      await appendImageDebugLog(input.workflow.localDir, "pending_result_local_save_start", {
        pendingId: pending.id,
        role: pending.role,
        transport: pending.transport,
      });
      const image = await readImageBytes(pending.payload);
      extension = image.ext;
      bytes = image.bytes.length;
      filePath = await writeUniqueBoardBuffer(
        input.workflow.id,
        boardImageFileBase(input.workflow, pending),
        extension,
        image.bytes
      );
      pending = await updateBoardImagePendingResult(input.workflow.localDir, pending.id, {
        filePath,
        fileExtension: extension,
        generationTiming: timingAfterLocalSave(pending.generationTiming, localSaveStartedAt),
      });
      await appendImageDebugLog(input.workflow.localDir, "pending_result_local_save_done", {
        pendingId: pending.id,
        role: pending.role,
        filePath,
        bytes,
        transport: pending.transport,
      });
    } else {
      pending = await updateBoardImagePendingResult(input.workflow.localDir, pending.id, {
        generationTiming: timingAfterLocalSave(pending.generationTiming, localSaveStartedAt),
      });
    }

    const current = await getBoardWorkflow(input.workflow.id, input.ownerId) || input.workflow;
    if (
      isBoardTaskCancelled(input.workflow.id, input.clientTaskId) ||
      isNodeExecutionCancelled(current, pending.executorNodeId)
    ) {
      return { workflow: current, cancelled: true } as const;
    }

    const existingNode = current.nodes.find((node) => String(node.meta?.pendingResultId || "") === pending.id);
    if (existingNode) {
      const finalWorkflow = await finishNodeExecution(
        input.workflow.id,
        pending.executorNodeId,
        pending.referenceNodeIds,
        [existingNode.id],
        `图片已本地保存并写入画板 · ${pending.transport === "b64_json" ? "Base64 回传" : "URL 回退"}`
      ) || current;
      await deleteBoardImagePendingResult(input.workflow.localDir, pending.id);
      return { workflow: finalWorkflow, node: existingNode, pending: false } as const;
    }

    const boardTiming = timingAtBoardPersist(pending.generationTiming);
    const node = createNode({
      kind: "image_asset",
      title: pending.title,
      description: pending.description,
      filePath,
      publicUrl: boardFilePublicUrl(input.workflow.id, filePath),
      promptEnglish: pending.promptEnglish,
      meta: {
        assetRole: pending.role,
        provider: pending.provider,
        model: pending.model,
        taskId: pending.taskId,
        referenceNodeIds: pending.referenceNodeIds,
        requestedWidth: pending.requestedWidth,
        requestedHeight: pending.requestedHeight,
        promptMetadata: pending.promptMetadata,
        resultTransport: pending.transport,
        generationTiming: boardTiming,
        pendingResultId: pending.id,
        executorNodeId: pending.executorNodeId,
      },
      x: pending.x,
      y: pending.y,
    });
    const newEdges = [
      createEdge(pending.executorNodeId, node.id, "节点执行输出"),
      ...pending.referenceNodeIds.map((referenceId) => createEdge(referenceId, node.id, "参考图")),
    ];
    const next = await updateBoardWorkflow(input.workflow.id, {
      status: "assets",
      nodes: [...current.nodes, node],
      edges: [...current.edges, ...newEdges],
    }, current.revision ?? 0);
    const finalWorkflow = await finishNodeExecution(
      input.workflow.id,
      pending.executorNodeId,
      pending.referenceNodeIds,
      [node.id],
      `图片已本地保存并写入画板 · ${pending.transport === "b64_json" ? "Base64 回传" : "URL 回退"}`
    ) || next;
    await deleteBoardImagePendingResult(input.workflow.localDir, pending.id);
    return { workflow: finalWorkflow, node, pending: false } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : "本地图片保存失败";
    const timing = timingAfterLocalSave(pending.generationTiming, localSaveStartedAt);
    await updateBoardImagePendingResult(input.workflow.localDir, pending.id, {
      lastError: message,
      generationTiming: timing,
    }).catch(() => undefined);
    const workflow = await deferNodeExecution(
      input.workflow.id,
      pending.executorNodeId,
      pending.referenceNodeIds,
      "上游已返回图片，等待本地保存恢复"
    ).catch(() => null);
    await appendImageDebugLog(input.workflow.localDir, "pending_result_local_save_failed", {
      pendingId: pending.id,
      role: pending.role,
      transport: pending.transport,
      message,
    });
    return { workflow, pending: true, error: message } as const;
  }
}

function pendingResponse(input: {
  workflow: BoardWorkflow | null;
  pending: BoardImagePendingResult;
  error: string;
}) {
  return NextResponse.json({
    workflow: input.workflow,
    pending: true,
    pendingResult: summarizeBoardImagePendingResult(input.pending),
    error: `图片已由模型返回并保全，但本地保存尚未完成。可点击“继续保存结果”，不会重新调用模型。${input.error}`,
  }, { status: 202 });
}

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const access = await getOwnedBoardWorkflowAccess(req, id);
  if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
  const pendingResults = await listBoardImagePendingResults(access.workflow.localDir);
  return NextResponse.json({ pendingResults });
}

export async function POST(req: NextRequest, { params }: Params) {
  let workflowId = "";
  let executorNodeId = "";
  let inputNodeIds: string[] = [];
  let detailBatchNodeId = "";
  let detailBatchItemIndex: number | undefined;
  try {
    const { id } = await params;
    const access = await getOwnedBoardWorkflowAccess(req, id);
    if (!access) return NextResponse.json({ error: "画板不存在或无权访问" }, { status: 404 });
    const user = access.user;
    workflowId = id;
    const workflow = access.workflow;
    if (!workflow) return NextResponse.json({ error: "画板工作流不存在" }, { status: 404 });

    const body = await req.json() as BoardImageRequestBody;
    const action = String(body.action || "");
    const clientTaskId = String(body.clientTaskId || "");
    executorNodeId = String(body.executorNodeId || "");
    detailBatchNodeId = String(body.detailBatchNodeId || "");
    detailBatchItemIndex = Number.isSafeInteger(Number(body.detailBatchItemIndex)) ? Number(body.detailBatchItemIndex) : undefined;
    const executorNode = workflow.nodes.find((node) => node.id === executorNodeId);
    if (!executorNode || String(executorNode.meta?.controlRole || "") !== "image_pipeline") {
      return NextResponse.json({ error: "请从画板上的 image-2 资产流水线节点发起生成。", workflow }, { status: 400 });
    }

    const failValidation = async (message: string) => {
      inputNodeIds = uniqueStrings(Array.isArray(body.referenceNodeIds)
        ? body.referenceNodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string")
        : []);
      const started = await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId).catch(() => null);
      const failed = await failNodeExecution(id, executorNodeId, inputNodeIds, message).catch(() => null);
      return NextResponse.json({ error: message, workflow: failed || started || workflow }, { status: 400 });
    };

    if (action === "record_client_sync") {
      const latest = await getBoardWorkflow(id, user.id) || workflow;
      const outputNodes = completedImageExecutionOutputNodes(latest, executorNodeId, clientTaskId);
      if (!outputNodes) {
        return NextResponse.json({ error: "当前任务的本地图片或画板输出节点尚未完整，不能记录画板显示完成。" }, { status: 409 });
      }
      const clientVisibleAtMs = parsedClientTimestamp(body.clientVisibleAtMs, Date.now());
      const outputIds = new Set(outputNodes.map((node) => node.id));
      const nodes = latest.nodes.map((node) => {
        if (!outputIds.has(node.id)) return node;
        const currentTiming = node.meta?.generationTiming && typeof node.meta.generationTiming === "object"
          ? node.meta.generationTiming as BoardImageGenerationTiming
          : {};
        return {
          ...node,
          meta: {
            ...node.meta,
            generationTiming: {
              ...currentTiming,
              clientVisibleAtMs,
              clickToClientVisibleMs: currentTiming.clientStartedAtMs === undefined
                ? undefined
                : Math.max(0, clientVisibleAtMs - currentTiming.clientStartedAtMs),
            },
          },
        };
      });
      const syncedWorkflow = await updateBoardWorkflow(id, { nodes }, latest.revision ?? 0);
      await appendImageDebugLog(workflow.localDir, "client_board_sync_confirmed", {
        executorNodeId,
        clientTaskId,
        outputNodeIds: outputNodes.map((node) => node.id),
        clientVisibleAtMs,
        clickToClientVisibleMs: (() => {
          const timing = outputNodes[0]?.meta?.generationTiming as BoardImageGenerationTiming | undefined;
          return timing?.clientStartedAtMs === undefined
            ? undefined
            : Math.max(0, clientVisibleAtMs - timing.clientStartedAtMs);
        })(),
      });
      return NextResponse.json({ workflow: syncedWorkflow, synced: true });
    }

    if (action === "retry_pending") {
      const pendingId = String(body.pendingResultId || "");
      const pending = await getBoardImagePendingResult(workflow.localDir, pendingId);
      if (!pending || pending.workflowId !== workflow.id || pending.ownerId !== user.id || pending.executorNodeId !== executorNodeId) {
        return NextResponse.json({ error: "待恢复结果不存在、已完成，或不属于当前画板。" }, { status: 404 });
      }
      inputNodeIds = pending.referenceNodeIds;
      await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);
      await appendImageDebugLog(workflow.localDir, "pending_result_retry_requested", {
        pendingId,
        executorNodeId,
        transport: pending.transport,
      });
      const persisted = await persistPendingBoardImage({ workflow, ownerId: user.id, clientTaskId, pending });
      if (persisted.cancelled) return NextResponse.json({ workflow: persisted.workflow, cancelled: true });
      if (persisted.pending) return pendingResponse({ workflow: persisted.workflow, pending, error: persisted.error });
      clearBoardTaskCancellation(id, clientTaskId);
      return NextResponse.json({
        workflow: persisted.workflow,
        node: persisted.node,
        result: { taskId: pending.taskId, modelId: pending.model, imageCount: 1, recovered: true },
      });
    }

    const requestStartedAt = Date.now();
    await appendImageDebugLog(workflow.localDir, "route_request_received", {
      role: body.assetRole,
      executorNodeId,
      promptLength: typeof body.prompt === "string" ? body.prompt.length : 0,
      bodyReferenceCount: Array.isArray(body.referenceNodeIds) ? body.referenceNodeIds.length : 0,
      channelName: body.channel?.name,
      model: body.channel?.model,
      endpointPath: body.endpointPath,
    });
    const channel = await resolveImageChannel(req, body.channel, body.channel?.id);
    if (!channel?.apiKey || !channel.baseUrl || !channel.model) {
      return failValidation("缺少生图模型配置。");
    }

    const role = String(body.assetRole || "");
    if (!BOARD_IMAGE_TASKS.includes(role as BoardImageTask)) {
      return failValidation("当前 image-2 任务角色不受支持。");
    }
    const bodyReferenceNodeIds = Array.isArray(body.referenceNodeIds)
      ? body.referenceNodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string")
      : [];
    const directInputNodeIds = manualDirectInputNodeIds(workflow, executorNodeId);
    const directInputNodeIdSet = new Set(directInputNodeIds);
    let batchNode: BoardWorkflowNode | null = null;
    let batchItemIndex: number | undefined;
    if (role === "detail_product_replacement") {
      batchNode = workflow.nodes.find((node) => node.id === detailBatchNodeId) || null;
      const batch = detailImageBatchFromNode(batchNode);
      batchItemIndex = detailBatchItemIndex;
      if (!batchNode || !batch || !directInputNodeIdSet.has(batchNode.id) || !directInputNodeIdSet.has(batch.productNodeId)) {
        return failValidation("详情图换装必须先把当前详情图批次节点和产品白底图直接连到 image-2 资产流水线。");
      }
      if (batchItemIndex === undefined || batchItemIndex < 0 || batchItemIndex >= batch.items.length) {
        return failValidation("详情图批次项不存在或序号已失效，请刷新批次后重试。");
      }
      const batchItem = batch.items[batchItemIndex];
      if (batchItem.status === "done") return failValidation("该详情图批次项已经完成，不会重复生成。");
      const replacementMode = detailImageBatchReplacementMode(batch);
      if (replacementMode === "product_and_face" && !batch.faceNodeId) {
        return failValidation("详情图批次的人脸分支信息已损坏，请重新创建批次。");
      }
      const expectedIds = [
        batch.productNodeId,
        ...(replacementMode === "product_and_face" ? [batch.faceNodeId!] : []),
        batchItem.nodeId,
      ];
      if (bodyReferenceNodeIds.length > 0 && bodyReferenceNodeIds.some((nodeId) => !expectedIds.includes(nodeId))) {
        return failValidation("详情图批次项只能使用该批次创建时锁定的产品白底图、人脸图和当前详情图。");
      }
      inputNodeIds = expectedIds;
    } else {
      if (bodyReferenceNodeIds.length === 0) {
        return failValidation("请先把本次任务所需图片直接手动连线到当前 image-2 节点。");
      }
      const nonDirectReferenceNodeIds = bodyReferenceNodeIds.filter((nodeId) => !directInputNodeIdSet.has(nodeId));
      if (nonDirectReferenceNodeIds.length > 0) {
        await appendImageDebugLog(workflow.localDir, "route_person_reference_rejected", {
          role,
          executorNodeId,
          nonDirectReferenceNodeIds,
          directInputNodeIds,
        });
        return failValidation("当前 image-2 只会发送直接手动连线到该节点的图片；未直接连线素材不会自动带入。");
      }
    }
    let referenceNodeIds = uniqueStrings(inputNodeIds.length ? inputNodeIds : bodyReferenceNodeIds);
    if (referenceNodeIds.length > IMAGE_REFERENCE_LIMIT) {
      return failValidation(`当前 image-2 最多可发送 ${IMAGE_REFERENCE_LIMIT} 张直接连线的参考图。`);
    }
    const missingReferenceNodeIds = referenceNodeIds.filter((nodeId) => !workflow.nodes.find((item) => item.id === nodeId)?.publicUrl);
    if (missingReferenceNodeIds.length > 0) {
      return failValidation("当前 image-2 的直接连线中包含不可用图片节点；请重新连接本次所需素材。");
    }
    const selectedReferenceNodes = referenceNodeIds
      .map((nodeId) => workflow.nodes.find((item) => item.id === nodeId))
      .filter((node): node is BoardWorkflowNode => Boolean(node));
    let canonicalTask: ReturnType<typeof buildCanonicalBoardImageTask>;
    try {
      canonicalTask = buildCanonicalBoardImageTask({
        task: role as BoardImageTask,
        referenceNodes: selectedReferenceNodes,
        repairInstruction: String(body.repairInstruction || ""),
      });
    } catch (error) {
      return failValidation(error instanceof Error ? error.message : String(error));
    }
    referenceNodeIds = canonicalTask.orderedNodes.map((node) => node.id);
    const prompt = canonicalTask.promptEnglish;
    inputNodeIds = referenceNodeIds;
    await startNodeExecution(id, executorNodeId, inputNodeIds, clientTaskId);
    if (batchNode && batchItemIndex !== undefined) {
      const runningBatch = detailImageBatchFromNode(batchNode);
      if (runningBatch) {
        const runningNode = updateDetailImageBatch(batchNode, (batch) => ({
          ...batch,
          status: "running",
          items: batch.items.map((item, index) => index === batchItemIndex
            ? { ...item, status: "running", error: undefined, startedAt: new Date().toISOString() }
            : item),
        }));
        const latest = await getBoardWorkflow(id, user.id) || workflow;
        const nodes = latest.nodes.map((node) => node.id === batchNode?.id ? runningNode : node);
        await updateBoardWorkflow(id, { nodes }, latest.revision ?? 0);
      }
    }
    await appendImageDebugLog(workflow.localDir, "route_reference_nodes", {
      role,
      inputNodeIds,
      directInputNodeIds,
      imageTaskContractVersion: canonicalTask.promptMetadata.imageTaskContractVersion,
      serverOwnedPrompt: true,
      canonicalPromptLength: prompt.length,
    });

    const referenceItems = referenceNodeIds
      .map((nodeId) => {
        const node = workflow.nodes.find((item) => item.id === nodeId);
        const url = absoluteUrl(req, node?.publicUrl);
        return url ? { node, url } : null;
      })
      .filter((item): item is { node: BoardWorkflowNode | undefined; url: string } => Boolean(item));
    const multiReferenceEdit = referenceItems.length >= 3;
    const preparedReferenceUrls = await Promise.all(referenceItems.map(({ node, url }) => {
      if (!multiReferenceEdit) return prepareImageEditReferenceUrl(url, { ownerId: user.id });
      const nodeRole = String(node?.meta?.assetRole || "");
      const isProductReference = nodeRole === "product_image";
      const isFrontalFaceCalibration = nodeRole === "face_front" || String(node?.meta?.identityReferenceSourceKind || "") === "face_front";
      return prepareImageEditReferenceUrl(url, {
        ownerId: user.id,
        targetBytes: isProductReference ? 2.4 * MB : isFrontalFaceCalibration ? 1.8 * MB : 1.1 * MB,
        maxSide: isProductReference ? 2200 : isFrontalFaceCalibration ? 1800 : 1500,
      });
    }));
    await appendImageDebugLog(workflow.localDir, "route_references_prepared", {
      role,
      referenceCount: referenceItems.length,
      preparedCount: preparedReferenceUrls.length,
      preparedLengths: preparedReferenceUrls.map((url) => url.length),
      preparedBytes: preparedReferenceUrls.map(dataUrlPayloadBytes),
      multiReferenceEdit,
    });

    const provider = createProvider({
      name: String(body.provider || "openai-seedance"),
      apiKey: channel.apiKey,
      baseUrl: channel.baseUrl,
      timeout: channel.requestTimeoutMs,
      extra: {
        imageApiKey: channel.apiKey,
        imageBaseUrl: channel.baseUrl,
        imageEditPath: imageEditPathFromChannel(body.endpointPath),
        imagePath: imageGenerationPathFromChannel(body.endpointPath),
        debugLogPath: path.join(workflow.localDir, "image-debug.log"),
      },
      audit: {
        userId: user.id,
        callType: "image",
        providerKey: String(body.provider || "openai-seedance"),
        channelName: channel.name,
        model: channel.model,
        source: "board.image.generate",
        boardWorkflowId: id,
        boardNodeId: executorNodeId,
      },
    });

    const fixedProductWhiteBackgroundSize = role === "product_white_background"
      ? imageDimensionsForPreset("1:1", "4k")
      : null;
    const bodyWidth = fixedProductWhiteBackgroundSize?.width || Number(body.width || 0) || undefined;
    const bodyHeight = fixedProductWhiteBackgroundSize?.height || Number(body.height || 0) || undefined;
    const presetSize = !bodyWidth || !bodyHeight ? imageDimensionsForPreset(String(body.aspectRatio || "9:16"), "4k") : null;
    const requestedWidth = bodyWidth || presetSize?.width;
    const requestedHeight = bodyHeight || presetSize?.height;
    const requestedAspectRatio = aspectRatioFromDimensions(requestedWidth, requestedHeight);
    await appendImageDebugLog(workflow.localDir, "route_provider_generate_start", {
      role,
      mode: preparedReferenceUrls.length ? "image-to-image" : "text-to-image",
      model: channel.model,
      baseUrl: channel.baseUrl,
      imageEditPath: imageEditPathFromChannel(body.endpointPath),
      requestedWidth,
      requestedHeight,
      requestedAspectRatio,
    });
    const result = await provider.generateImage({
      modelId: channel.model,
      mode: preparedReferenceUrls.length ? "image-to-image" : "text-to-image",
      prompt,
      referenceImageUrls: preparedReferenceUrls,
      width: requestedWidth,
      height: requestedHeight,
      count: IMAGE_OUTPUT_LIMIT,
      extra: requestedWidth && requestedHeight ? { quality: "auto" } : undefined,
    });
    await appendImageDebugLog(workflow.localDir, "route_provider_generate_done", {
      role,
      taskId: result.taskId,
      imageUrlCount: result.imageUrls.length,
      imageUrlKinds: result.imageUrls.map((url) => resultTransport(url)),
      timing: result.extra?.timing,
    });

    const workflowAfterGeneration = await getBoardWorkflow(id, user.id) || workflow;
    if (isBoardTaskCancelled(id, clientTaskId) || isNodeExecutionCancelled(workflowAfterGeneration, executorNodeId)) {
      return NextResponse.json({ workflow: workflowAfterGeneration, cancelled: true });
    }

    const payload = result.imageUrls[0];
    if (!payload) throw new Error("生图模型没有返回图片结果。");
    const position = readPosition(body, 980, 520);
    const pending = await saveBoardImagePendingResult(workflow.localDir, {
      workflowId: workflow.id,
      ownerId: user.id,
      executorNodeId,
      role,
      title: canonicalTask.title,
      description: canonicalTask.description,
      promptEnglish: prompt,
      promptMetadata: {
        ...canonicalTask.promptMetadata,
        ...(batchNode && batchItemIndex !== undefined
          ? { detailBatchNodeId: batchNode.id, detailBatchItemIndex: batchItemIndex }
          : {}),
      },
      referenceNodeIds,
      provider: String(body.provider || "openai-seedance"),
      model: channel.model,
      taskId: result.taskId,
      transport: resultTransport(payload),
      payload,
      requestedWidth,
      requestedHeight,
      x: position.x,
      y: position.y,
      generationTiming: generationTimingFromResult(result, requestStartedAt, body.clientStartedAt),
    });
    await appendImageDebugLog(workflow.localDir, "route_upstream_result_preserved", {
      pendingId: pending.id,
      role,
      transport: pending.transport,
      taskId: result.taskId,
    });

    const persisted = await persistPendingBoardImage({ workflow, ownerId: user.id, clientTaskId, pending });
    if (persisted.cancelled) return NextResponse.json({ workflow: persisted.workflow, cancelled: true });
    if (persisted.pending) return pendingResponse({ workflow: persisted.workflow, pending, error: persisted.error });
    clearBoardTaskCancellation(id, clientTaskId);
    let finalWorkflow = persisted.workflow;
    if (batchNode && batchItemIndex !== undefined) {
      const latest = await getBoardWorkflow(id, user.id) || finalWorkflow;
      const currentBatchNode = latest.nodes.find((node) => node.id === batchNode?.id);
      if (currentBatchNode) {
        const updatedBatchNode = updateDetailImageBatch(currentBatchNode, (batch) => {
          const items = batch.items.map((item, index) => index === batchItemIndex
            ? { ...item, status: "done" as const, outputNodeId: persisted.node?.id, error: undefined, finishedAt: new Date().toISOString() }
            : item);
          const status = items.every((item) => item.status === "done") ? "done" : "running";
          return { ...batch, status, items };
        });
        finalWorkflow = await updateBoardWorkflow(id, {
          nodes: latest.nodes.map((node) => node.id === updatedBatchNode.id ? updatedBatchNode : node),
        }, latest.revision ?? 0);
      }
    }
    return NextResponse.json({
      workflow: finalWorkflow,
      node: persisted.node,
      result: { taskId: result.taskId, modelId: result.modelId, imageCount: 1 },
    });
  } catch (error) {
    console.error("board image generation failed:", error);
    let failedWorkflow: BoardWorkflow | null = null;
    if (workflowId && executorNodeId) {
      const currentWorkflow = await getBoardWorkflow(workflowId).catch(() => null);
      if (currentWorkflow?.localDir) {
        await appendImageDebugLog(currentWorkflow.localDir, "route_failed", {
          executorNodeId,
          inputNodeIds,
          message: error instanceof Error ? error.message : String(error),
          providerError: error instanceof ProviderError ? {
            code: error.code,
            provider: error.provider,
            statusCode: error.statusCode,
          } : undefined,
        });
      }
      failedWorkflow = await failNodeExecution(
        workflowId,
        executorNodeId,
        inputNodeIds,
        error instanceof Error ? error.message : "image-2 生成失败"
      ).catch(() => null);
      if (detailBatchNodeId && detailBatchItemIndex !== undefined) {
        const latestWorkflow = await getBoardWorkflow(workflowId).catch(() => null);
        const batchNode = latestWorkflow?.nodes.find((node) => node.id === detailBatchNodeId);
        if (latestWorkflow && batchNode && detailImageBatchFromNode(batchNode)) {
          const updatedBatchNode = updateDetailImageBatch(batchNode, (batch) => ({
            ...batch,
            status: "paused",
            items: batch.items.map((item, index) => index === detailBatchItemIndex
              ? { ...item, status: "failed", error: error instanceof Error ? error.message : "详情图换装失败", finishedAt: new Date().toISOString() }
              : item),
          }));
          failedWorkflow = await updateBoardWorkflow(workflowId, {
            nodes: latestWorkflow.nodes.map((node) => node.id === updatedBatchNode.id ? updatedBatchNode : node),
          }, latestWorkflow.revision ?? 0).catch(() => failedWorkflow);
        }
      }
    }
    if (error instanceof ProviderError) {
      return NextResponse.json(
        { error: error.message, code: error.code, provider: error.provider, statusCode: error.statusCode, workflow: failedWorkflow },
        { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "画板生图失败", workflow: failedWorkflow },
      { status: 500 }
    );
  }
}

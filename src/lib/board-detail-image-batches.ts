import type { BoardWorkflowNode } from "@/lib/board-workflows";

export const DETAIL_IMAGE_BATCH_VERSION = 3;
export const DETAIL_IMAGE_BATCH_ROLE = "detail_image_batch";
export const DETAIL_IMAGE_REFERENCE_ROLE = "detail_reference_image";

export type DetailImageBatchItemStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type DetailImageReplacementMode = "product_only" | "product_and_face";
export type DetailImageOutputAspectRatio = "1:1" | "9:16";

export type DetailImageOutputSize = {
  aspectRatio: DetailImageOutputAspectRatio;
  width: number;
  height: number;
};

export type DetailImageBatchItem = {
  id: string;
  index: number;
  nodeId: string;
  originalName: string;
  sourceWidth?: number;
  sourceHeight?: number;
  outputAspectRatio?: DetailImageOutputAspectRatio;
  outputWidth?: number;
  outputHeight?: number;
  status: DetailImageBatchItemStatus;
  outputNodeId?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export function detailImageOutputSizeForSource(sourceWidth: number, sourceHeight: number): DetailImageOutputSize {
  if (!(Number.isFinite(sourceWidth) && sourceWidth > 0 && Number.isFinite(sourceHeight) && sourceHeight > 0)) {
    throw new Error("详情图缺少有效的原始宽高。");
  }
  return sourceHeight > sourceWidth
    ? { aspectRatio: "9:16", width: 2160, height: 3840 }
    : { aspectRatio: "1:1", width: 2160, height: 2160 };
}

export function detailImageBatchItemOutputSize(item: DetailImageBatchItem): DetailImageOutputSize {
  if (
    (item.outputAspectRatio === "1:1" || item.outputAspectRatio === "9:16")
    && Number.isFinite(item.outputWidth)
    && Number(item.outputWidth) > 0
    && Number.isFinite(item.outputHeight)
    && Number(item.outputHeight) > 0
  ) {
    return {
      aspectRatio: item.outputAspectRatio,
      width: Number(item.outputWidth),
      height: Number(item.outputHeight),
    };
  }
  // Historical batches did not freeze per-item dimensions and already ran as 9:16.
  return { aspectRatio: "9:16", width: 2160, height: 3840 };
}

export type DetailImageBatch = {
  id: string;
  title: string;
  version: number;
  productNodeId: string;
  replacementMode?: DetailImageReplacementMode;
  faceNodeId?: string;
  executorNodeId: string;
  itemNodeIds: string[];
  items: DetailImageBatchItem[];
  status: "draft" | "running" | "paused" | "done" | "failed" | "cancelled";
  stopOnError: boolean;
  createdAt: string;
  updatedAt: string;
};

export function detailImageBatchReplacementMode(batch: DetailImageBatch): DetailImageReplacementMode {
  return batch.version >= 2 && batch.replacementMode === "product_and_face" && Boolean(batch.faceNodeId)
    ? "product_and_face"
    : "product_only";
}

function readBatch(node?: BoardWorkflowNode | null): DetailImageBatch | null {
  if (!node || String(node.meta?.assetRole || "") !== DETAIL_IMAGE_BATCH_ROLE) return null;
  const value = node.meta?.detailImageBatch;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const batch = value as DetailImageBatch;
  if (!batch.id || !Array.isArray(batch.items) || !batch.productNodeId || !batch.executorNodeId) return null;
  return batch;
}

export function detailImageBatchFromNode(node?: BoardWorkflowNode | null) {
  return readBatch(node);
}

export function detailImageBatchNodes(nodes: BoardWorkflowNode[]) {
  return nodes
    .map((node) => ({ node, batch: readBatch(node) }))
    .filter((entry): entry is { node: BoardWorkflowNode; batch: DetailImageBatch } => Boolean(entry.batch));
}

export function nextDetailImageBatchItem(batch: DetailImageBatch) {
  return batch.items.find((item) => item.status === "queued" || item.status === "failed");
}

export function summarizeDetailImageBatch(batch: DetailImageBatch) {
  const counts = batch.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return {
    id: batch.id,
    title: batch.title,
    status: batch.status,
    total: batch.items.length,
    queued: counts.queued || 0,
    running: counts.running || 0,
    done: counts.done || 0,
    failed: counts.failed || 0,
    cancelled: counts.cancelled || 0,
    productNodeId: batch.productNodeId,
    replacementMode: detailImageBatchReplacementMode(batch),
    faceNodeId: batch.faceNodeId,
    executorNodeId: batch.executorNodeId,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export function updateDetailImageBatch(
  node: BoardWorkflowNode,
  updater: (batch: DetailImageBatch) => DetailImageBatch,
) {
  const batch = readBatch(node);
  if (!batch) throw new Error("详情图批次不存在或已损坏。");
  const updated = updater(batch);
  return {
    ...node,
    meta: {
      ...node.meta,
      detailImageBatch: { ...updated, updatedAt: new Date().toISOString() },
    },
  } satisfies BoardWorkflowNode;
}

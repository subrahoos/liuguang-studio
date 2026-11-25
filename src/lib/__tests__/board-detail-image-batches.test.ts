import { describe, expect, it } from "vitest";
import {
  detailImageBatchFromNode,
  detailImageBatchItemOutputSize,
  detailImageBatchReplacementMode,
  detailImageBatchNodes,
  nextDetailImageBatchItem,
  summarizeDetailImageBatch,
  updateDetailImageBatch,
  DETAIL_IMAGE_BATCH_ROLE,
  type DetailImageBatch,
} from "@/lib/board-detail-image-batches";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function batchNode(): BoardWorkflowNode {
  const batch: DetailImageBatch = {
    id: "batch-1",
    title: "春季详情图",
    version: 1,
    productNodeId: "product-1",
    executorNodeId: "executor-1",
    itemNodeIds: ["detail-1", "detail-2"],
    items: [
      { id: "item-1", index: 0, nodeId: "detail-1", originalName: "01.png", status: "done" },
      { id: "item-2", index: 1, nodeId: "detail-2", originalName: "02.png", status: "queued" },
    ],
    status: "running",
    stopOnError: true,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
  return {
    id: "batch-node",
    kind: "note",
    title: batch.title,
    x: 0,
    y: 0,
    createdAt: batch.createdAt,
    meta: { assetRole: DETAIL_IMAGE_BATCH_ROLE, detailImageBatch: batch },
  };
}

describe("detail image batch model", () => {
  it("finds the next non-complete item and summarizes arbitrary batch sizes", () => {
    const node = batchNode();
    const batch = detailImageBatchFromNode(node)!;
    expect(nextDetailImageBatchItem(batch)?.index).toBe(1);
    expect(summarizeDetailImageBatch(batch)).toMatchObject({ total: 2, done: 1, queued: 1, running: 0 });
    expect(detailImageBatchNodes([node])).toHaveLength(1);
  });

  it("keeps every item in a batch larger than ten in upload order", () => {
    const node = batchNode();
    const batch = detailImageBatchFromNode(node)!;
    const items = Array.from({ length: 11 }, (_, index) => ({
      id: `item-${index + 1}`,
      index,
      nodeId: `detail-${index + 1}`,
      originalName: `${String(index + 1).padStart(2, "0")}.png`,
      status: "queued" as const,
    }));
    const expanded = { ...batch, items, itemNodeIds: items.map((item) => item.nodeId) };
    expect(summarizeDetailImageBatch(expanded)).toMatchObject({ total: 11, queued: 11 });
    expect(expanded.items.map((item) => item.originalName)).toEqual(
      Array.from({ length: 11 }, (_, index) => `${String(index + 1).padStart(2, "0")}.png`),
    );
  });

  it("updates a batch without changing its node identity", () => {
    const updated = updateDetailImageBatch(batchNode(), (batch) => ({
      ...batch,
      status: "done",
      items: batch.items.map((item) => ({ ...item, status: "done" as const })),
    }));
    expect(updated.id).toBe("batch-node");
    expect(detailImageBatchFromNode(updated)?.status).toBe("done");
    expect(detailImageBatchFromNode(updated)?.items.every((item) => item.status === "done")).toBe(true);
  });

  it("keeps legacy batches product-only and reads the frozen face branch in version 2", () => {
    const legacy = detailImageBatchFromNode(batchNode())!;
    expect(detailImageBatchReplacementMode(legacy)).toBe("product_only");

    const withFace: DetailImageBatch = {
      ...legacy,
      version: 2,
      replacementMode: "product_and_face",
      faceNodeId: "face-1",
    };
    expect(detailImageBatchReplacementMode(withFace)).toBe("product_and_face");
    expect(summarizeDetailImageBatch(withFace)).toMatchObject({
      replacementMode: "product_and_face",
      faceNodeId: "face-1",
    });
  });

  it("maps non-standard source ratios to the two supported ecommerce outputs", () => {
    expect(detailImageBatchItemOutputSize({
      id: "squareish",
      index: 0,
      nodeId: "detail-1",
      originalName: "squareish.png",
      sourceWidth: 1200,
      sourceHeight: 1200,
      outputAspectRatio: "1:1",
      outputWidth: 2160,
      outputHeight: 2160,
      status: "queued",
    })).toEqual({ aspectRatio: "1:1", width: 2160, height: 2160 });
    expect(detailImageBatchItemOutputSize({
      id: "portrait",
      index: 1,
      nodeId: "detail-2",
      originalName: "portrait.png",
      sourceWidth: 1000,
      sourceHeight: 1500,
      outputAspectRatio: "9:16",
      outputWidth: 2160,
      outputHeight: 3840,
      status: "queued",
    })).toEqual({ aspectRatio: "9:16", width: 2160, height: 3840 });
  });
});

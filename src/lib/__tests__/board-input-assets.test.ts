import { describe, expect, it } from "vitest";
import {
  currentProductGroup,
  currentReferenceVideoNode,
  markCurrentReferenceVideo,
  newAudioPosition,
  newReferenceVideoPosition,
  setCurrentProductGroup,
} from "@/lib/board-input-assets";
import type { BoardWorkflow, BoardWorkflowNode } from "@/lib/board-workflows";

function node(overrides: Partial<BoardWorkflowNode> & Pick<BoardWorkflowNode, "id" | "kind">): BoardWorkflowNode {
  return {
    id: overrides.id,
    kind: overrides.kind,
    title: overrides.title || overrides.id,
    description: overrides.description || "",
    filePath: overrides.filePath,
    publicUrl: overrides.publicUrl,
    meta: overrides.meta || {},
    x: overrides.x || 0,
    y: overrides.y || 0,
    createdAt: overrides.createdAt || "2026-08-12T00:00:00.000Z",
    execution: overrides.execution,
  };
}

describe("board input asset selection", () => {
  it("places a newly registered reference video beside its executor", () => {
    const workflow = {
      nodes: [
        node({ id: "input", kind: "control", x: 1800, y: 420, meta: { controlRole: "input_assets" } }),
      ],
    } as Pick<BoardWorkflow, "nodes">;

    expect(newReferenceVideoPosition(workflow, "input")).toEqual({ x: 2220, y: 420 });
    expect(newReferenceVideoPosition(workflow, "missing")).toEqual({ x: 460, y: 260 });
  });

  it("places extracted audio below its reference video", () => {
    const workflow = {
      nodes: [
        node({ id: "source", kind: "source_video", x: 3471, y: 100 }),
        node({ id: "input", kind: "control", x: 3051, y: 100 }),
      ],
    } as Pick<BoardWorkflow, "nodes">;

    expect(newAudioPosition(workflow, "source", "input")).toEqual({ x: 3471, y: 620 });
    expect(newAudioPosition({ nodes: [] }, undefined, "input")).toEqual({ x: 460, y: 780 });
  });

  it("uses the workflow source path as the explicit current reference video", () => {
    const older = node({ id: "older", kind: "source_video", filePath: "source/older.mp4", meta: { currentReferenceVideo: true } });
    const selected = node({ id: "selected", kind: "source_video", filePath: "source/selected.mp4" });
    const workflow = {
      sourceVideoPath: "source/selected.mp4",
      nodes: [older, selected],
    } as Pick<BoardWorkflow, "sourceVideoPath" | "nodes">;

    expect(currentReferenceVideoNode(workflow)?.id).toBe("selected");
  });

  it("marks exactly one source video as current", () => {
    const nodes = [
      node({ id: "one", kind: "source_video", filePath: "source/one.mp4", meta: { currentReferenceVideo: true } }),
      node({ id: "two", kind: "source_video", filePath: "source/two.mp4" }),
      node({ id: "image", kind: "image_asset", filePath: "assets/image.png", meta: { currentReferenceVideo: true } }),
    ];

    const marked = markCurrentReferenceVideo(nodes, "two");
    expect(marked.find((item) => item.id === "one")?.meta?.currentReferenceVideo).toBeUndefined();
    expect(marked.find((item) => item.id === "two")?.meta?.currentReferenceVideo).toBe(true);
    expect(marked.find((item) => item.id === "image")?.meta?.currentReferenceVideo).toBe(true);
  });

  it("keeps only valid, unique product images in the saved group", () => {
    const products = Array.from({ length: 5 }, (_, index) => node({
      id: `product-${index + 1}`,
      kind: "image_asset",
      filePath: `assets/product-${index + 1}.png`,
      meta: { assetRole: "product_image" },
    }));
    const invalid = node({ id: "identity", kind: "image_asset", filePath: "assets/identity.png", meta: { assetRole: "identity_image" } });
    const owner = node({
      id: "owner",
      kind: "control",
      meta: {
        controlRole: "input_assets",
        currentProductGroupId: "group-a",
        currentProductGroupNodeIds: ["product-1", "identity", "missing", "product-1", "product-2", "product-3", "product-4", "product-5"],
      },
    });

    const group = currentProductGroup(owner, [owner, invalid, ...products]);
    expect(group.groupId).toBe("group-a");
    expect(group.nodeIds).toEqual(["product-1", "product-2", "product-3", "product-4"]);
  });

  it("saves an explicit product group without deleting product nodes", () => {
    const owner = node({ id: "owner", kind: "control", meta: { controlRole: "input_assets" } });
    const product = node({ id: "product", kind: "image_asset", filePath: "assets/product.png", meta: { assetRole: "product_image" } });
    const identity = node({ id: "identity", kind: "image_asset", filePath: "assets/identity.png", meta: { assetRole: "identity_image" } });

    const updated = setCurrentProductGroup([owner, product, identity], owner.id, "group-b", [identity.id, product.id, product.id]);
    expect(updated).toHaveLength(3);
    expect(updated.find((item) => item.id === owner.id)?.meta).toMatchObject({
      currentProductGroupId: "group-b",
      currentProductGroupNodeIds: [product.id],
    });
  });
});

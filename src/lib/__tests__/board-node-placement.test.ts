import { describe, expect, it } from "vitest";
import { generatedOutputPosition } from "@/lib/board-node-placement";
import type { BoardWorkflowNode } from "@/lib/board-workflows";

function node(input: Partial<BoardWorkflowNode> & Pick<BoardWorkflowNode, "id" | "kind" | "x" | "y">): BoardWorkflowNode {
  return {
    title: input.id,
    createdAt: "2026-07-24T00:00:00.000Z",
    ...input,
  };
}

describe("generated board output placement", () => {
  it("places a new analysis output directly to the right of its control", () => {
    const control = node({ id: "control", kind: "control", x: 800, y: 1000 });

    expect(generatedOutputPosition({
      nodes: [control],
      anchor: control,
      outputKind: "analysis",
      outputRole: "reference_method_analysis",
    })).toEqual({ x: 1220, y: 1000 });
  });

  it("does not let an unrelated historical node push a new result across the board", () => {
    const control = node({ id: "control", kind: "control", x: 800, y: 1000 });
    const obstacle = node({ id: "obstacle", kind: "image_asset", x: 1220, y: 1000 });

    expect(generatedOutputPosition({
      nodes: [control, obstacle],
      anchor: control,
      outputKind: "analysis",
    })).toEqual({ x: 1220, y: 1000 });
  });

  it("preserves a manually adjusted output position on regeneration", () => {
    const control = node({ id: "control", kind: "control", x: 800, y: 1000 });
    const previous = node({ id: "previous", kind: "analysis", x: 1470, y: 760 });

    expect(generatedOutputPosition({
      nodes: [control, previous],
      anchor: control,
      outputKind: "analysis",
      previousOutput: previous,
    })).toEqual({ x: 1470, y: 760 });
  });

  it("keeps segmented video tasks in a compact rail beside the video function", () => {
    const control = node({ id: "video", kind: "control", x: 3500, y: 100 });

    expect(generatedOutputPosition({
      nodes: [control],
      anchor: control,
      outputKind: "video_clip",
      outputRole: "generated_video",
      outputSlot: "video_segment",
      segmentIndex: 2,
    })).toEqual({ x: 3920, y: 552 });
  });

  it("reserves the first video-result slot for the completed film", () => {
    const control = node({ id: "video", kind: "control", x: 3500, y: 100 });
    const finalVideo = node({
      id: "final",
      kind: "video_clip",
      x: 3920,
      y: 100,
      meta: { assetRole: "composed_video", executorNodeId: "video" },
    });

    expect(generatedOutputPosition({
      nodes: [control, finalVideo],
      anchor: control,
      outputKind: "video_clip",
      outputRole: "generated_video",
      outputSlot: "video_segment",
      segmentIndex: 1,
    })).toEqual({ x: 3920, y: 552 });
  });

  it("places the director prompt immediately to the left of video generation", () => {
    const director = node({ id: "director", kind: "control", x: 1800, y: 100 });
    const video = node({ id: "video", kind: "control", x: 3500, y: 900, meta: { controlRole: "video_generate" } });

    expect(generatedOutputPosition({
      nodes: [director, video],
      anchor: director,
      outputKind: "prompt",
      outputRole: "video_director_prompt",
    })).toEqual({ x: 3088, y: 900 });
  });
});

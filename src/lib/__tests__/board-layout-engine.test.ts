import { describe, expect, it } from "vitest";
import {
  BOARD_LAYOUT_LANE_GAP,
  BOARD_LAYOUT_LANE_WIDTH,
  BOARD_LAYOUT_TOP,
  boardLayoutStageForNode,
  boardLayoutStageLeft,
  buildBoardLayoutPreview,
  estimatedBoardNodeHeight,
} from "@/lib/board-layout-engine";
import type { BoardWorkflowEdge, BoardWorkflowNode } from "@/lib/board-workflows";

function node(input: Partial<BoardWorkflowNode> & Pick<BoardWorkflowNode, "id" | "kind">): BoardWorkflowNode {
  return {
    title: input.id,
    createdAt: "2026-07-25T00:00:00.000Z",
    x: 999,
    y: 999,
    ...input,
  };
}

function edge(from: string, to: string, label = "手动连线"): BoardWorkflowEdge {
  return { id: `${from}-${to}-${label}`, from, to, label };
}

describe("compact board layout engine", () => {
  it("places the optional half-second action supplement in the video-evidence stage", () => {
    const detailEvidence = node({
      id: "action-supplement",
      kind: "keyframe",
      meta: { assetRole: "action_supplement_storyboard_collection" },
    });

    expect(boardLayoutStageForNode(detailEvidence)).toBe(1);
    expect(estimatedBoardNodeHeight(detailEvidence)).toBe(500);
  });

  it("uses the measured expanded control height so following nodes do not overlap", () => {
    const control = node({ id: "image", kind: "control", meta: { controlRole: "image_pipeline" } });
    const outputs = Array.from({ length: 5 }, (_, index) => node({
      id: `output-${index}`,
      kind: "image_asset",
      createdAt: `2026-07-25T00:00:0${index}.000Z`,
      meta: { assetRole: "clean_scene" },
    }));
    const preview = buildBoardLayoutPreview([control, ...outputs], [], "pipeline", new Map([["image", 1400]]));
    const placedControl = preview.nodes.find((item) => item.id === "image")!;
    expect(placedControl.y).toBe(BOARD_LAYOUT_TOP);
    expect(preview.canvasMinHeight).toBeGreaterThanOrEqual(BOARD_LAYOUT_TOP + 1400 + 120);
    const imageLaneNodes = preview.nodes
      .filter((item) => item.x === placedControl.x)
      .sort((a, b) => a.y - b.y);
    for (let index = 1; index < imageLaneNodes.length; index += 1) {
      const previous = imageLaneNodes[index - 1];
      const current = imageLaneNodes[index];
      const previousHeight = previous.id === "image" ? 1400 : estimatedBoardNodeHeight(previous);
      expect(current.y).toBeGreaterThanOrEqual(previous.y + previousHeight + 32);
    }
    expect(estimatedBoardNodeHeight(control)).toBeLessThan(240);
  });

  it("keeps complete audio beside imported source assets", () => {
    const input = node({ id: "input", kind: "control", meta: { controlRole: "input_assets" } });
    const source = node({ id: "source", kind: "source_video" });
    const audio = node({ id: "audio", kind: "audio", meta: { assetRole: "audio_evidence" } });
    const preview = buildBoardLayoutPreview([input, source, audio], [], "pipeline");

    expect(boardLayoutStageForNode(audio)).toBe(0);
    expect(preview.nodes.find((item) => item.id === audio.id)!.x).toBe(boardLayoutStageLeft(0));
  });

  it("spreads repeated video-reference images across two lanes beside video generation", () => {
    const control = node({ id: "image", kind: "control", meta: { controlRole: "image_pipeline" } });
    const outputs = Array.from({ length: 6 }, (_, index) => node({
      id: `output-${index}`,
      kind: "image_asset",
      createdAt: `2026-07-25T00:00:0${index}.000Z`,
      meta: { assetRole: index < 3 ? "outfit_front" : "composite_image" },
    }));
    const preview = buildBoardLayoutPreview([control, ...outputs], outputs.map((item) => edge(control.id, item.id)), "pipeline");
    const stageLeft = boardLayoutStageLeft(4);
    const outputXs = new Set(preview.nodes.filter((item) => item.kind === "image_asset").map((item) => item.x));
    expect(outputXs).toEqual(new Set([stageLeft, stageLeft + BOARD_LAYOUT_LANE_WIDTH + BOARD_LAYOUT_LANE_GAP]));
    expect(preview.canvasMinHeight).toBeLessThan(2400);
  });

  it("keeps same-role outputs in creation order across repeated layouts", () => {
    const control = node({ id: "video", kind: "control", meta: { controlRole: "video_generate" } });
    const newer = node({ id: "segment-2", kind: "video_clip", createdAt: "2026-07-25T00:00:02.000Z", meta: { assetRole: "generated_video", segmentIndex: 2 } });
    const older = node({ id: "segment-1", kind: "video_clip", createdAt: "2026-07-25T00:00:01.000Z", meta: { assetRole: "generated_video", segmentIndex: 1 } });
    const first = buildBoardLayoutPreview([control, newer, older], [edge("video", "segment-2"), edge("video", "segment-1")], "pipeline");
    const second = buildBoardLayoutPreview(first.nodes, [edge("video", "segment-2"), edge("video", "segment-1")], "pipeline");
    expect(second.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(first.nodes.map(({ id, x, y }) => ({ id, x, y })));
  });

  it("keeps image inputs beside image-2 and video inputs beside video generation", () => {
    const product = node({ id: "product", kind: "image_asset", meta: { assetRole: "product_image" } });
    const image = node({ id: "image", kind: "control", meta: { controlRole: "image_pipeline" } });
    const prompt = node({ id: "director-prompt", kind: "prompt", meta: { assetRole: "video_director_prompt" } });
    const video = node({ id: "video", kind: "control", meta: { controlRole: "video_generate" } });
    const preview = buildBoardLayoutPreview([product, image, prompt, video], [], "pipeline");

    const placedProduct = preview.nodes.find((item) => item.id === product.id)!;
    const placedImage = preview.nodes.find((item) => item.id === image.id)!;
    const placedPrompt = preview.nodes.find((item) => item.id === prompt.id)!;
    const placedVideo = preview.nodes.find((item) => item.id === video.id)!;
    expect(placedProduct.x).toBe(boardLayoutStageLeft(3));
    expect(placedImage.x).toBe(boardLayoutStageLeft(3) + BOARD_LAYOUT_LANE_WIDTH + BOARD_LAYOUT_LANE_GAP);
    expect(placedPrompt.x).toBe(boardLayoutStageLeft(4));
    expect(placedVideo.x).toBe(boardLayoutStageLeft(4) + BOARD_LAYOUT_LANE_WIDTH + BOARD_LAYOUT_LANE_GAP);
  });

  it("keeps video segments in the same nearby result rail as the final film", () => {
    const finalVideo = node({ id: "final", kind: "video_clip", meta: { assetRole: "composed_video" } });
    const segment1 = node({ id: "segment-1", kind: "video_clip", meta: { assetRole: "generated_video", segmentIndex: 1 } });
    const segment2 = node({ id: "segment-2", kind: "video_clip", meta: { assetRole: "generated_video", segmentIndex: 2 } });
    const preview = buildBoardLayoutPreview([segment2, finalVideo, segment1], [], "pipeline");
    const rows = preview.nodes.filter((item) => item.kind === "video_clip").sort((a, b) => a.y - b.y);

    expect(rows.map((item) => item.id)).toEqual(["final", "segment-1", "segment-2"]);
    expect(new Set(rows.map((item) => item.x))).toEqual(new Set([boardLayoutStageLeft(5)]));
  });

  it("uses only manual links to group a direct reference-video replacement package", () => {
    const referenceVideo = node({ id: "reference-video", kind: "source_video" });
    const product = node({ id: "product", kind: "image_asset", meta: { assetRole: "product_image" } });
    const face = node({ id: "face", kind: "image_asset", meta: { assetRole: "identity_image" } });
    const person = node({ id: "person", kind: "image_asset", meta: { assetRole: "identity_auxiliary_asset" } });
    const scene = node({ id: "scene", kind: "image_asset", meta: { assetRole: "selected_scene_frame" } });
    const video = node({ id: "video", kind: "control", meta: { controlRole: "video_generate" } });
    const result = node({ id: "result", kind: "video_clip", meta: { assetRole: "generated_video", segmentIndex: 1 } });
    const manualInputs = [referenceVideo, product, face, person, scene].map((input) => edge(input.id, video.id));
    const preview = buildBoardLayoutPreview(
      [referenceVideo, product, face, person, scene, video, result],
      [...manualInputs, edge(video.id, result.id, "节点执行输出"), edge(product.id, result.id, "参考素材")],
      "connections",
    );

    expect(preview.manualEdgeCount).toBe(5);
    expect(preview.connectedNodeCount).toBe(6);
    expect(preview.unlinkedNodeCount).toBe(1);
  });

  it("keeps generated videos in one result rail when arranging by manual links", () => {
    const video = node({ id: "video", kind: "control", meta: { controlRole: "video_generate" } });
    const finalVideo = node({ id: "final", kind: "video_clip", meta: { assetRole: "composed_video" } });
    const segment1 = node({ id: "segment-1", kind: "video_clip", meta: { assetRole: "generated_video", segmentIndex: 1 } });
    const segment2 = node({ id: "segment-2", kind: "video_clip", meta: { assetRole: "generated_video", segmentIndex: 2 } });
    const preview = buildBoardLayoutPreview(
      [video, segment2, finalVideo, segment1],
      [edge("video", "final", "节点执行输出"), edge("video", "segment-1", "节点执行输出"), edge("video", "segment-2", "节点执行输出")],
      "connections",
    );
    const rows = preview.nodes.filter((item) => item.kind === "video_clip").sort((a, b) => a.y - b.y);

    expect(preview.manualEdgeCount).toBe(0);
    expect(preview.connectedNodeCount).toBe(0);
    expect(rows.map((item) => item.id)).toEqual(["final", "segment-1", "segment-2"]);
    expect(new Set(rows.map((item) => item.x))).toEqual(new Set([boardLayoutStageLeft(5)]));
  });
});
